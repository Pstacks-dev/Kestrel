use crate::{ComputeError, ComputeProvider, Instance, InstanceSpec, InstanceState, ProviderCapabilities, ProviderKind};
use async_trait::async_trait;
use reqwest::{Client, Method, Response};
use serde_json::{json, Value};
use std::{fs, time::Duration};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct IncusConfig {
    pub https_endpoint: String,
    pub project: String,
    pub client_certificate_path: String,
    pub client_key_path: String,
    pub server_ca_path: String,
}
impl IncusConfig {
    pub fn validate(&self) -> Result<(), ComputeError> {
        let endpoint = reqwest::Url::parse(&self.https_endpoint)
            .map_err(|_| ComputeError::NotConfigured("Invalid Incus endpoint URL".into()))?;
        if endpoint.scheme() != "https" || endpoint.host_str().is_none() || !endpoint.username().is_empty() || endpoint.password().is_some() {
            return Err(ComputeError::NotConfigured("Incus must use a credential-free HTTPS endpoint".into()));
        }
        if self.project.is_empty() || self.project.len() > 128 || !self.project.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
            return Err(ComputeError::NotConfigured("Invalid Incus project name".into()));
        }
        for path in [&self.client_certificate_path, &self.client_key_path, &self.server_ca_path] {
            if path.is_empty() || !std::path::Path::new(path).is_absolute() {
                return Err(ComputeError::NotConfigured("Incus certificate, key and CA paths must be absolute".into()));
            }
        }
        Ok(())
    }
}

pub struct IncusProvider { pub config: IncusConfig }

impl IncusProvider {
    fn client(&self) -> Result<Client, ComputeError> {
        self.config.validate()?;
        let cert = fs::read(&self.config.client_certificate_path)
            .map_err(|e| ComputeError::NotConfigured(format!("Cannot read Incus client certificate: {e}")))?;
        let key = fs::read(&self.config.client_key_path)
            .map_err(|e| ComputeError::NotConfigured(format!("Cannot read Incus client key: {e}")))?;
        let ca = fs::read(&self.config.server_ca_path)
            .map_err(|e| ComputeError::NotConfigured(format!("Cannot read Incus CA: {e}")))?;
        let mut identity = cert;
        identity.extend_from_slice(b"\n");
        identity.extend_from_slice(&key);
        let identity = reqwest::Identity::from_pem(&identity)
            .map_err(|e| ComputeError::NotConfigured(format!("Invalid Incus client identity: {e}")))?;
        let ca = reqwest::Certificate::from_pem(&ca)
            .map_err(|e| ComputeError::NotConfigured(format!("Invalid Incus server CA: {e}")))?;
        Client::builder()
            .identity(identity)
            .add_root_certificate(ca)
            .https_only(true)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|e| ComputeError::NotConfigured(format!("Cannot initialize Incus HTTPS client: {e}")))
    }

    fn api_url(&self, path: &str) -> String {
        format!("{}/1.0/{}?project={}", self.config.https_endpoint.trim_end_matches('/'), path.trim_start_matches("/1.0/").trim_start_matches('/'), self.config.project)
    }

    async fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, ComputeError> {
        let client = self.client()?;
        let mut request = client.request(method, self.api_url(path));
        if let Some(body) = body { request = request.json(&body); }
        let response = request.send().await.map_err(|e| ComputeError::Provider(format!("Incus request failed: {e}")))?;
        Self::decode(response).await
    }

    async fn decode(response: Response) -> Result<Value, ComputeError> {
        let status = response.status();
        let value: Value = response.json().await
            .map_err(|e| ComputeError::Provider(format!("Invalid Incus API response: {e}")))?;
        if !status.is_success() || value.get("type").and_then(Value::as_str) == Some("error") {
            let message = value.pointer("/metadata/error").and_then(Value::as_str).unwrap_or("Incus returned an error");
            return Err(ComputeError::Provider(format!("Incus HTTP {status}: {message}")));
        }
        Ok(value)
    }

    async fn wait_operation(&self, operation: &str) -> Result<(), ComputeError> {
        if !operation.starts_with("/1.0/operations/") || operation.contains("..") {
            return Err(ComputeError::Provider("Incus returned an invalid operation URL".into()));
        }
        let path = format!("{}{}", operation, if operation.contains('?') { "&timeout=30" } else { "?timeout=30" });
        let result = self.request(Method::GET, &path, None).await?;
        let status = result.pointer("/metadata/status_code").and_then(Value::as_i64).unwrap_or(0);
        if status != 200 {
            return Err(ComputeError::Provider("Incus operation did not complete successfully".into()));
        }
        Ok(())
    }

    fn parse_instance(&self, name: &str, metadata: &Value) -> Result<Instance, ComputeError> {
        let status = metadata.get("status").and_then(Value::as_str).unwrap_or("Unknown");
        let state = match status {
            "Running" => InstanceState::Running,
            "Stopped" => InstanceState::Stopped,
            "Starting" => InstanceState::Starting,
            "Stopping" => InstanceState::Stopping,
            _ => InstanceState::Unknown,
        };
        let provider_id = metadata.get("name").and_then(Value::as_str).unwrap_or(name).to_owned();
        let ipv4 = metadata.pointer("/state/network")
            .and_then(Value::as_object)
            .into_iter().flat_map(|interfaces| interfaces.values())
            .filter_map(Value::as_object)
            .flat_map(|interface| interface.values())
            .filter_map(Value::as_array)
            .flatten()
            .filter(|address| address.get("family").and_then(Value::as_str) == Some("inet"))
            .filter_map(|address| address.get("address").and_then(Value::as_str))
            .filter(|address| !address.starts_with("127.") && !address.starts_with("169.254."))
            .map(str::to_owned).collect();
        Ok(Instance { id: Uuid::new_v4(), provider_id, name: name.to_owned(), state, ipv4 })
    }

    async fn operation_from(&self, response: Value) -> Result<String, ComputeError> {
        let operation = response.pointer("/metadata/operation").and_then(Value::as_str)
            .ok_or_else(|| ComputeError::Provider("Incus response did not include an operation URL".into()))?;
        self.wait_operation(operation).await?;
        Ok(operation.to_owned())
    }
}

#[async_trait]
impl ComputeProvider for IncusProvider {
    fn kind(&self) -> ProviderKind { ProviderKind::Incus }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities { virtual_machines: true, snapshots: true, live_migration: true, console: true, cluster_scheduling: true }
    }
    async fn health(&self) -> Result<(), ComputeError> {
        let response = self.request(Method::GET, "", None).await?;
        if response.pointer("/metadata/auth").and_then(Value::as_str) == Some("trusted") { Ok(()) }
        else { Err(ComputeError::Provider("Incus mTLS identity is not trusted by the server".into())) }
    }
    async fn create_instance(&self, spec: &InstanceSpec) -> Result<Instance, ComputeError> {
        spec.validate()?;
        let mut config = serde_json::Map::new();
        config.insert("limits.cpu".into(), json!(spec.vcpus.to_string()));
        config.insert("limits.memory".into(), json!(format!("{}MiB", spec.memory_mib)));
        if let Some(key) = &spec.ssh_public_key {
            config.insert("user.user-data".into(), json!(format!("#cloud-config\nusers:\n  - name: kestrel\n    groups: [sudo]\n    shell: /bin/bash\n    sudo: ['ALL=(ALL) NOPASSWD:ALL']\n    ssh_authorized_keys:\n      - {}", key)));
        }
        let body = json!({
            "name": spec.name,
            "type": "virtual-machine",
            "source": { "type": "image", "alias": spec.image },
            "profiles": ["default"],
            "config": config,
            "devices": { "root": { "type": "disk", "path": "/", "size": format!("{}GiB", spec.disk_gib) } }
        });
        let response = self.request(Method::POST, "instances", Some(body)).await?;
        self.operation_from(response).await?;
        self.get_instance(&spec.name).await
    }
    async fn get_instance(&self, id: &str) -> Result<Instance, ComputeError> {
        if id.is_empty() || id.len() > 63 || !id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') {
            return Err(ComputeError::InvalidSpec("Invalid Incus instance identifier".into()));
        }
        let response = self.request(Method::GET, &format!("instances/{id}"), None).await?;
        let metadata = response.get("metadata").ok_or_else(|| ComputeError::Provider("Incus instance metadata missing".into()))?;
        self.parse_instance(id, metadata)
    }
    async fn start_instance(&self, id: &str) -> Result<(), ComputeError> {
        self.request(Method::PUT, &format!("instances/{id}/state"), Some(json!({"action":"start","timeout":30,"force":false}))).await?;
        Ok(())
    }
    async fn stop_instance(&self, id: &str) -> Result<(), ComputeError> {
        self.request(Method::PUT, &format!("instances/{id}/state"), Some(json!({"action":"stop","timeout":30,"force":false}))).await?;
        Ok(())
    }
    async fn delete_instance(&self, id: &str) -> Result<(), ComputeError> {
        let response = self.request(Method::DELETE, &format!("instances/{id}"), None).await?;
        self.operation_from(response).await?;
        Ok(())
    }
}
