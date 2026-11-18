use anyhow::{anyhow, Context, Result};
use kestrel_compute::{
    providers::{firecracker::{FirecrackerConfig, FirecrackerProvider}, incus::{IncusConfig, IncusProvider}, kubevirt::{KubeVirtConfig, KubeVirtProvider}},
    ComputeProvider, Instance, InstanceSpec, InstanceState, ProviderKind,
};
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{env, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::RwLock;
use tokio::time;
use tracing::{error, info, warn};

#[derive(Clone)]
struct Config {
    api_url: String,
    node_id: String,
    token: String,
    provider: String,
    hostname: String,
    architecture: String,
}

#[derive(Debug, Deserialize)]
struct ClaimResponse {
    operation: Option<Operation>,
}

#[derive(Debug, Deserialize)]
struct Operation {
    id: String,
    #[serde(rename = "instance_id")]
    instance_id: String,
    action: String,
    payload: Value,
    #[serde(rename = "leaseToken")]
    lease_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Completion<'a> {
    operation_id: &'a str,
    lease_token: &'a str,
    success: bool,
    provider_id: Option<&'a str>,
    state: Option<&'a str>,
    ipv4: &'a [String],
    error: Option<&'a str>,
}

fn required(name: &str) -> Result<String> {
    let value = env::var(name).with_context(|| format!("{name} is required"))?;
    anyhow::ensure!(!value.trim().is_empty(), "{name} cannot be empty");
    Ok(value)
}

fn config() -> Result<Config> {
    Ok(Config {
        api_url: required("KESTREL_API_URL")?.trim_end_matches('/').to_owned(),
        node_id: required("KESTREL_COMPUTE_NODE_ID")?,
        token: required("KESTREL_COMPUTE_NODE_TOKEN")?,
        provider: required("KESTREL_COMPUTE_PROVIDER")?,
        hostname: env::var("HOSTNAME").unwrap_or_else(|_| "kestrel-compute-node".into()),
        architecture: format!("linux/{}", env::consts::ARCH),
    })
}

fn provider(cfg: &Config) -> Result<Arc<dyn ComputeProvider>> {
    match cfg.provider.as_str() {
        "incus" => Ok(Arc::new(IncusProvider {
            config: IncusConfig {
                https_endpoint: required("KESTREL_INCUS_ENDPOINT")?,
                project: env::var("KESTREL_INCUS_PROJECT").unwrap_or_else(|_| "kestrel".into()),
                client_certificate_path: required("KESTREL_INCUS_CLIENT_CERT")?,
                client_key_path: required("KESTREL_INCUS_CLIENT_KEY")?,
                server_ca_path: required("KESTREL_INCUS_SERVER_CA")?,
            },
        })),
        "firecracker" => Ok(Arc::new(FirecrackerProvider::new(FirecrackerConfig {
            api_socket_dir: PathBuf::from(required("KESTREL_FIRECRACKER_CHROOT_BASE")?),
            jailer_binary: PathBuf::from(required("KESTREL_FIRECRACKER_JAILER")?),
            firecracker_binary: PathBuf::from(required("KESTREL_FIRECRACKER_BINARY")?),
            kernel_image_dir: PathBuf::from(required("KESTREL_FIRECRACKER_KERNEL_DIR")?),
            rootfs_image_dir: PathBuf::from(required("KESTREL_FIRECRACKER_ROOTFS_DIR")?),
            uid: env::var("KESTREL_FIRECRACKER_UID").unwrap_or_else(|_| "1000".into()).parse()?,
            gid: env::var("KESTREL_FIRECRACKER_GID").unwrap_or_else(|_| "1000".into()).parse()?,
        })?)),
        "kubevirt" => Ok(Arc::new(KubeVirtProvider::new(KubeVirtConfig {
            api_server: required("KESTREL_KUBEVIRT_API_SERVER")?,
            namespace: required("KESTREL_KUBEVIRT_NAMESPACE")?,
            service_account_token_path: required("KESTREL_KUBEVIRT_TOKEN_FILE")?,
            ca_certificate_path: required("KESTREL_KUBEVIRT_CA_FILE")?,
        })?)),
        other => Err(anyhow!("Unsupported compute provider: {other}")),
    }
}

fn client(cfg: &Config) -> Result<Client> {
    let mut headers = header::HeaderMap::new();
    headers.insert(header::AUTHORIZATION, format!("Bearer {}", cfg.token).parse()?);
    headers.insert("x-compute-node-id", cfg.node_id.parse()?);
    Ok(Client::builder().default_headers(headers).timeout(Duration::from_secs(30)).build()?)
}

async fn post(http: &Client, cfg: &Config, path: &str, body: Value) -> Result<Value> {
    let response = http.post(format!("{}{path}", cfg.api_url)).json(&body).send().await?;
    let status = response.status();
    let bytes = response.bytes().await?;
    anyhow::ensure!(status.is_success(), "Kestrel API {path} returned HTTP {status}: {}", String::from_utf8_lossy(&bytes));
    if bytes.is_empty() { return Ok(Value::Null); }
    Ok(serde_json::from_slice(&bytes)?)
}

async fn register(http: &Client, cfg: &Config) -> Result<()> {
    post(http, cfg, "/api/compute/agent/register", json!({
        "hostname":cfg.hostname,"architecture":cfg.architecture
    })).await?;
    info!(node_id = %cfg.node_id, provider = %cfg.provider, "compute host registered");
    Ok(())
}

async fn heartbeat(http: &Client, cfg: &Config, active: Option<(String, String)>) -> Result<()> {
    let body = match active {
        Some((operation_id, lease_token)) => json!({"operationId":operation_id,"leaseToken":lease_token}),
        None => json!({}),
    };
    post(http, cfg, "/api/compute/agent/heartbeat", body).await?;
    Ok(())
}

async fn claim(http: &Client, cfg: &Config) -> Result<Option<Operation>> {
    let response = post(http, cfg, "/api/compute/agent/claim", json!({})).await?;
    Ok(serde_json::from_value::<ClaimResponse>(response)?.operation)
}

async fn complete(http: &Client, cfg: &Config, operation: &Operation, result: Result<Instance>) -> Result<()> {
    match result {
        Ok(instance) => {
            let state = match instance.state {
                InstanceState::Running => "running",
                InstanceState::Stopped => "stopped",
                InstanceState::Starting => "starting",
                InstanceState::Stopping => "stopping",
                InstanceState::Pending => "provisioning",
                InstanceState::Failed => "failed",
                InstanceState::Unknown => "unknown",
            };
            post(http, cfg, "/api/compute/agent/complete", json!({
                "operationId":operation.id,"leaseToken":operation.lease_token,"success":true,
                "providerId":instance.provider_id,"state":state,"ipv4":instance.ipv4
            })).await?;
        }
        Err(error) => {
            post(http, cfg, "/api/compute/agent/complete", json!({
                "operationId":operation.id,"leaseToken":operation.lease_token,"success":false,
                "error":error.to_string()
            })).await?;
        }
    }
    Ok(())
}

async fn execute(provider: &dyn ComputeProvider, operation: &Operation) -> Result<Instance> {
    match operation.action.as_str() {
        "create" => {
            let spec: InstanceSpec = serde_json::from_value(operation.payload.get("spec").cloned().ok_or_else(|| anyhow!("create operation is missing its VM spec"))?)?;
            provider.create_instance(&spec).await.map_err(|e| anyhow!(e.to_string()))
        }
        "start" | "stop" | "delete" => {
            let provider_id = operation.payload.get("providerId").and_then(Value::as_str)
                .ok_or_else(|| anyhow!("VM operation is missing providerId"))?;
            match operation.action.as_str() {
                "start" => provider.start_instance(provider_id).await.map_err(|e| anyhow!(e.to_string()))?,
                "stop" => provider.stop_instance(provider_id).await.map_err(|e| anyhow!(e.to_string()))?,
                "delete" => {
                    provider.delete_instance(provider_id).await.map_err(|e| anyhow!(e.to_string()))?;
                    return Ok(Instance {
                        id: uuid::Uuid::nil(), provider_id: provider_id.into(),
                        name: provider_id.into(), state: InstanceState::Stopped, ipv4: Vec::new()
                    });
                }
                _ => unreachable!(),
            }
            provider.get_instance(provider_id).await.map_err(|e| anyhow!(e.to_string()))
        }
        other => Err(anyhow!("Unsupported compute action: {other}")),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())
    ).init();

    let cfg = config()?;
    let provider = provider(&cfg)?;
    anyhow::ensure!(matches!((cfg.provider.as_str(), provider.kind()),
        ("incus", ProviderKind::Incus) | ("firecracker", ProviderKind::Firecracker) | ("kubevirt", ProviderKind::KubeVirt)),
        "Configured provider does not match provider implementation");
    provider.health().await.map_err(|e| anyhow!("Provider health check failed: {e}"))?;
    let http = client(&cfg)?;
    register(&http, &cfg).await?;

    let active_lease: Arc<RwLock<Option<(String, String)>>> = Arc::new(RwLock::new(None));
    let heartbeat_active = active_lease.clone();
    let heartbeat_http = http.clone();
    let heartbeat_cfg = cfg.clone();
    let heartbeat_task = tokio::spawn(async move {
        let mut tick = time::interval(Duration::from_secs(15));
        loop {
            tick.tick().await;
            let active = heartbeat_active.read().await.clone();
            if let Err(error) = heartbeat(&heartbeat_http, &heartbeat_cfg, active).await {
                error!(%error, "compute node heartbeat or operation lease renewal failed");
            }
        }
    });

    let mut poll_tick = time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                warn!("shutdown requested; compute node will stop claiming new operations");
                break;
            }
            _ = poll_tick.tick() => {
                match claim(&http, &cfg).await {
                    Ok(Some(operation)) => {
                        info!(operation_id = %operation.id, action = %operation.action, instance_id = %operation.instance_id, "claimed VM operation");
                        *active_lease.write().await = Some((operation.id.clone(), operation.lease_token.clone()));
                        let result = execute(provider.as_ref(), &operation).await;
                        if let Err(error) = &result {
                            error!(operation_id = %operation.id, %error, "VM operation failed");
                        }
                        if let Err(error) = complete(&http, &cfg, &operation, result).await {
                            error!(operation_id = %operation.id, %error, "could not report VM operation result");
                        }
                        *active_lease.write().await = None;
                    }
                    Ok(None) => {}
                    Err(error) => error!(%error, "compute operation polling failed"),
                }
            }
        }
    }
    heartbeat_task.abort();
    Ok(())
}
