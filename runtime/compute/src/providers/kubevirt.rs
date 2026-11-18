use crate::{ComputeError, ComputeProvider, Instance, InstanceSpec, InstanceState, ProviderCapabilities, ProviderKind};
use async_trait::async_trait;
use reqwest::{Certificate, Client, Method, StatusCode};
use serde_json::{json, Value};
use std::{fs, path::Path};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct KubeVirtConfig {
    pub api_server: String,
    pub namespace: String,
    pub service_account_token_path: String,
    pub ca_certificate_path: String,
}

impl KubeVirtConfig {
    pub fn validate(&self) -> Result<(), ComputeError> {
        let parsed = reqwest::Url::parse(&self.api_server)
            .map_err(|_| ComputeError::NotConfigured("Invalid Kubernetes API URL".into()))?;
        if parsed.scheme() != "https" || parsed.host_str().is_none() || parsed.username() != "" || parsed.password().is_some() {
            return Err(ComputeError::NotConfigured("Kubernetes API server must be an HTTPS URL without embedded credentials".into()));
        }
        if self.namespace.is_empty() || self.namespace.len() > 63
            || !self.namespace.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || !self.namespace.as_bytes()[0].is_ascii_alphanumeric()
            || !self.namespace.as_bytes()[self.namespace.len() - 1].is_ascii_alphanumeric()
        {
            return Err(ComputeError::NotConfigured("Invalid Kubernetes namespace".into()));
        }
        for path in [&self.service_account_token_path, &self.ca_certificate_path] {
            if path.is_empty() || !Path::new(path).is_absolute() {
                return Err(ComputeError::NotConfigured("Kubernetes token and CA paths must be absolute".into()));
            }
        }
        Ok(())
    }
}

pub struct KubeVirtProvider {
    pub config: KubeVirtConfig,
    client: Client,
    bearer_token: String,
}

impl KubeVirtProvider {
    /// Build a client using a namespace-scoped service-account token and the cluster CA.
    /// The token is never returned from this provider or included in error messages.
    pub fn new(config: KubeVirtConfig) -> Result<Self, ComputeError> {
        config.validate()?;
        let token = fs::read_to_string(&config.service_account_token_path)
            .map_err(|_| ComputeError::NotConfigured("Unable to read Kubernetes service-account token".into()))?;
        let bearer_token = token.trim().to_owned();
        if bearer_token.is_empty() || bearer_token.len() > 16_384 || bearer_token.bytes().any(|b| b.is_ascii_whitespace()) {
            return Err(ComputeError::NotConfigured("Kubernetes service-account token is empty or malformed".into()));
        }
        let ca_pem = fs::read(&config.ca_certificate_path)
            .map_err(|_| ComputeError::NotConfigured("Unable to read Kubernetes CA certificate".into()))?;
        let ca = Certificate::from_pem(&ca_pem)
            .map_err(|_| ComputeError::NotConfigured("Kubernetes CA certificate is not valid PEM".into()))?;
        let client = Client::builder()
            .add_root_certificate(ca)
            .https_only(true)
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(35))
            .build()
            .map_err(|e| ComputeError::Provider(format!("Kubernetes HTTP client: {e}")))?;
        Ok(Self { config, client, bearer_token })
    }

    fn resource_url(&self, resource: &str, name: Option<&str>, action: Option<&str>) -> String {
        let base = self.config.api_server.trim_end_matches('/');
        let mut url = format!("{base}/apis/kubevirt.io/v1/namespaces/{}/virtualmachines", self.config.namespace);
        if let Some(name) = name { url.push('/'); url.push_str(name); }
        if let Some(action) = action { url.push('/'); url.push_str(action); }
        if resource == "vmi" {
            url = format!("{base}/apis/kubevirt.io/v1/namespaces/{}/virtualmachineinstances/{}", self.config.namespace, name.unwrap_or_default());
        }
        url
    }

    async fn request(&self, method: Method, url: String, body: Option<Value>) -> Result<Value, ComputeError> {
        let mut request = self.client.request(method, url).bearer_auth(&self.bearer_token);
        if let Some(body) = body { request = request.json(&body); }
        let response = request.send().await.map_err(|e| ComputeError::Provider(format!("Kubernetes API request failed: {e}")))?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|e| ComputeError::Provider(format!("Kubernetes API response failed: {e}")))?;
        if !status.is_success() {
            let detail = serde_json::from_slice::<Value>(&bytes).ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
            return Err(ComputeError::Provider(format!("KubeVirt API rejected request: {detail}")));
        }
        if status == StatusCode::NO_CONTENT || bytes.is_empty() { return Ok(Value::Null); }
        serde_json::from_slice(&bytes).map_err(|e| ComputeError::Provider(format!("Invalid Kubernetes API JSON: {e}")))
    }

    fn vm_manifest(&self, spec: &InstanceSpec) -> Value {
        let mut disks = vec![
            json!({"name":"rootfs","disk":{"bus":"virtio"}}),
            json!({"name":"data","disk":{"bus":"virtio"}}),
        ];
        let mut volumes = vec![
            json!({"name":"rootfs","containerDisk":{"image":spec.image}}),
            json!({"name":"data","emptyDisk":{"capacity":format!("{}Gi", spec.disk_gib)}}),
        ];
        if let Some(key) = &spec.ssh_public_key {
            let user_data = format!("#cloud-config\nusers:\n  - name: kestrel\n    groups: [sudo]\n    shell: /bin/bash\n    sudo: ['ALL=(ALL) NOPASSWD:ALL']\n    ssh_authorized_keys:\n      - {}\n", key);
            disks.push(json!({"name":"cloudinit","disk":{"bus":"virtio"}}));
            volumes.push(json!({"name":"cloudinit","cloudInitNoCloud":{"userData":user_data}}));
        }
        json!({
            "apiVersion":"kubevirt.io/v1",
            "kind":"VirtualMachine",
            "metadata":{"name":spec.name,"namespace":self.config.namespace,"labels":{"app.kubernetes.io/managed-by":"kestrel","kestrel.io/provider":"kubevirt"}},
            "spec":{
                "running":false,
                "template":{
                    "metadata":{"labels":{"kestrel.io/instance":spec.name}},
                    "spec":{
                        "domain":{
                            "cpu":{"cores":spec.vcpus},
                            "resources":{"requests":{"memory":format!("{}Mi",spec.memory_mib)}},
                            "devices":{"disks":disks,"interfaces":[{"name":"default","masquerade":{}}]}
                        },
                        "networks":[{"name":"default","pod":{}}],
                        "volumes":volumes
                    }
                }
            }
        })
    }

    fn to_instance(&self, vm: &Value, vmi: Option<&Value>, fallback_name: &str) -> Result<Instance, ComputeError> {
        let metadata = vm.get("metadata").ok_or_else(|| ComputeError::Provider("Kubernetes VM response has no metadata".into()))?;
        let name = metadata.get("name").and_then(Value::as_str).unwrap_or(fallback_name).to_owned();
        let provider_id = name.clone();
        let raw_uid = metadata.get("uid").and_then(Value::as_str).unwrap_or_default();
        let id = Uuid::parse_str(raw_uid).map_err(|_| ComputeError::Provider("Kubernetes VM response has an invalid UID".into()))?;
        let printable = vm.pointer("/status/printableStatus").and_then(Value::as_str).unwrap_or("Stopped");
        let vmi_phase = vmi.and_then(|v| v.pointer("/status/phase")).and_then(Value::as_str).unwrap_or("");
        let state = match (printable.to_ascii_lowercase().as_str(), vmi_phase.to_ascii_lowercase().as_str()) {
            (_, "running") | ("running", _) => InstanceState::Running,
            ("starting", _) | ("provisioning", _) | ("pending", _) => InstanceState::Starting,
            ("stopping", _) => InstanceState::Stopping,
            ("failed", _) | ("crashed", _) => InstanceState::Failed,
            ("stopped", _) | ("off", _) | ("halted", _) | (_, "") => InstanceState::Stopped,
            _ => InstanceState::Unknown,
        };
        let ipv4 = vmi.and_then(|v| v.pointer("/status/interfaces")).and_then(Value::as_array)
            .into_iter().flatten()
            .filter_map(|interface| interface.get("ipAddress").and_then(Value::as_str))
            .filter(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok())
            .map(str::to_owned).collect();
        Ok(Instance { id, provider_id, name, state, ipv4 })
    }

    async fn fetch_instance(&self, name: &str) -> Result<Instance, ComputeError> {
        validate_resource_name(name)?;
        let vm = self.request(Method::GET, self.resource_url("vm", Some(name), None), None).await?;
        let vmi = self.request(Method::GET, self.resource_url("vmi", Some(name), None), None).await.ok();
        self.to_instance(&vm, vmi.as_ref(), name)
    }
}

fn validate_resource_name(name: &str) -> Result<(), ComputeError> {
    if name.is_empty() || name.len() > 63 || !name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || !name.as_bytes()[0].is_ascii_alphanumeric() || !name.as_bytes()[name.len()-1].is_ascii_alphanumeric() {
        return Err(ComputeError::InvalidSpec("invalid Kubernetes resource name".into()));
    }
    Ok(())
}

#[async_trait]
impl ComputeProvider for KubeVirtProvider {
    fn kind(&self) -> ProviderKind { ProviderKind::KubeVirt }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities { virtual_machines: true, snapshots: false, live_migration: false, console: false, cluster_scheduling: false }
    }

    async fn health(&self) -> Result<(), ComputeError> {
        self.request(Method::GET, self.resource_url("vm", None, None), None).await.map(|_| ())
    }

    async fn create_instance(&self, spec: &InstanceSpec) -> Result<Instance, ComputeError> {
        spec.validate()?;
        let manifest = self.vm_manifest(spec);
        self.request(Method::POST, self.resource_url("vm", None, None), Some(manifest)).await?;
        self.fetch_instance(&spec.name).await
    }

    async fn get_instance(&self, id: &str) -> Result<Instance, ComputeError> { self.fetch_instance(id).await }

    async fn start_instance(&self, id: &str) -> Result<(), ComputeError> {
        validate_resource_name(id)?;
        self.request(Method::PUT, self.resource_url("vm", Some(id), Some("start")), Some(json!({"apiVersion":"subresources.kubevirt.io/v1alpha3","kind":"VirtualMachineStartOptions"}))).await.map(|_| ())
    }

    async fn stop_instance(&self, id: &str) -> Result<(), ComputeError> {
        validate_resource_name(id)?;
        self.request(Method::PUT, self.resource_url("vm", Some(id), Some("stop")), Some(json!({"apiVersion":"subresources.kubevirt.io/v1alpha3","kind":"VirtualMachineStopOptions"}))).await.map(|_| ())
    }

    async fn delete_instance(&self, id: &str) -> Result<(), ComputeError> {
        validate_resource_name(id)?;
        self.request(Method::DELETE, self.resource_url("vm", Some(id), None), Some(json!({"apiVersion":"v1","kind":"DeleteOptions","propagationPolicy":"Foreground"}))).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> KubeVirtConfig {
        KubeVirtConfig { api_server:"https://kubernetes.example:6443".into(), namespace:"kestrel-workloads".into(),
            service_account_token_path:"/var/run/kestrel/token".into(), ca_certificate_path:"/var/run/kestrel/ca.crt".into() }
    }

    #[test]
    fn rejects_http_and_embedded_credentials() {
        let mut value = config(); value.api_server = "http://kubernetes.example".into(); assert!(value.validate().is_err());
        let mut value = config(); value.api_server = "https://user:secret@kubernetes.example".into(); assert!(value.validate().is_err());
    }

    #[test]
    fn rejects_namespace_path_injection() {
        let mut value = config(); value.namespace = "../default".into(); assert!(value.validate().is_err());
    }

    #[test]
    fn resource_names_are_validated_before_url_construction() {
        assert!(validate_resource_name("vm-01").is_ok());
        assert!(validate_resource_name("../secrets").is_err());
        assert!(validate_resource_name("UPPERCASE").is_err());
    }

    #[test]
    fn vm_manifest_maps_cpu_memory_disk_and_ssh_key() {
        let provider = KubeVirtProvider {
            config: config(),
            client: Client::new(),
            bearer_token: "test-token".into(),
        };
        let spec = InstanceSpec { name:"test-vm".into(), image:"quay.io/containerdisks/ubuntu:24.04".into(),
            vcpus:2, memory_mib:2048, disk_gib:30, region:None, ssh_public_key:Some("ssh-ed25519 AAAATEST test".into()) };
        let manifest = provider.vm_manifest(&spec);
        assert_eq!(manifest.pointer("/spec/template/spec/domain/cpu/cores").and_then(Value::as_u64), Some(2));
        assert_eq!(manifest.pointer("/spec/template/spec/domain/resources/requests/memory").and_then(Value::as_str), Some("2048Mi"));
        assert_eq!(manifest.pointer("/spec/template/spec/volumes/1/emptyDisk/capacity").and_then(Value::as_str), Some("30Gi"));
        assert_eq!(manifest.pointer("/spec/template/spec/volumes/2/cloudInitNoCloud/userData").and_then(Value::as_str).unwrap().contains("ssh-ed25519 AAAATEST"), true);
    }
}
