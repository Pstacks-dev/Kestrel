use crate::{ComputeError, ComputeProvider, Instance, InstanceSpec, InstanceState, ProviderCapabilities, ProviderKind};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::UnixStream, process::{Child, Command}, sync::Mutex, time::sleep};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct FirecrackerConfig {
    /// Host directory used as jailer chroot base; keep it on a dedicated filesystem.
    pub api_socket_dir: PathBuf,
    pub jailer_binary: PathBuf,
    pub firecracker_binary: PathBuf,
    pub kernel_image_dir: PathBuf,
    pub rootfs_image_dir: PathBuf,
    /// Operator-managed Linux bridge with DHCP/routing and firewall policy.
    pub network_bridge: String,
    pub uid: u32,
    pub gid: u32,
}

impl FirecrackerConfig {
    pub fn validate(&self) -> Result<(), ComputeError> {
        for path in [&self.api_socket_dir, &self.jailer_binary, &self.firecracker_binary, &self.kernel_image_dir, &self.rootfs_image_dir] {
            if !path.is_absolute() {
                return Err(ComputeError::NotConfigured("Firecracker paths must be absolute".into()));
            }
        }
        if self.api_socket_dir == Path::new("/") || self.api_socket_dir.components().count() < 2 {
            return Err(ComputeError::NotConfigured("Unsafe Firecracker jailer base directory".into()));
        }
        if self.uid == 0 || self.gid == 0 {
            return Err(ComputeError::NotConfigured("Firecracker must run as a non-root UID and GID".into()));
        }
        if self.network_bridge.is_empty() || self.network_bridge.len() > 15
            || !self.network_bridge.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
        {
            return Err(ComputeError::NotConfigured("Firecracker network bridge must be a valid Linux interface name".into()));
        }
        Ok(())
    }
}

pub struct FirecrackerProvider {
    pub config: FirecrackerConfig,
    children: Mutex<HashMap<String, Child>>,
}

impl FirecrackerProvider {
    pub fn new(config: FirecrackerConfig) -> Result<Self, ComputeError> {
        config.validate()?;
        Ok(Self { config, children: Mutex::new(HashMap::new()) })
    }

    fn jail_root(&self, id: &str) -> PathBuf {
        self.config.api_socket_dir.join("firecracker").join(id).join("root")
    }

    fn socket_path(&self, id: &str) -> PathBuf {
        self.jail_root(id).join("run/firecracker.socket")
    }

    fn rootfs_source(&self, image: &str) -> Result<PathBuf, ComputeError> {
        if image.is_empty() || image.len() > 128
            || !image.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
            || image == "." || image == ".."
        {
            return Err(ComputeError::InvalidSpec("Firecracker image must be a local rootfs filename".into()));
        }
        Ok(self.config.rootfs_image_dir.join(image))
    }

    async fn api_request(&self, id: &str, method: &str, path: &str, body: Option<Value>) -> Result<Value, ComputeError> {
        let socket = self.socket_path(id);
        let mut stream = UnixStream::connect(&socket).await
            .map_err(|e| ComputeError::Provider(format!("Firecracker API socket is unavailable: {e}")))?;
        let payload = body.map(|v| v.to_string()).unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            payload.len(), payload
        );
        stream.write_all(request.as_bytes()).await
            .map_err(|e| ComputeError::Provider(format!("Firecracker API write failed: {e}")))?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await
            .map_err(|e| ComputeError::Provider(format!("Firecracker API read failed: {e}")))?;
        let response = String::from_utf8_lossy(&response);
        let (headers, body) = response.split_once("\r\n\r\n")
            .ok_or_else(|| ComputeError::Provider("Malformed Firecracker API response".into()))?;
        let status_line = headers.lines().next().unwrap_or_default();
        let status = status_line.split_whitespace().nth(1).unwrap_or("500");
        if !status.starts_with('2') {
            return Err(ComputeError::Provider(format!("Firecracker API returned HTTP {status}: {}", body.chars().take(512).collect::<String>())));
        }
        if body.trim().is_empty() { return Ok(Value::Null); }
        serde_json::from_str(body).map_err(|e| ComputeError::Provider(format!("Invalid Firecracker API JSON: {e}")))
    }

    async fn wait_for_socket(&self, id: &str, child: &mut Child) -> Result<(), ComputeError> {
        for _ in 0..100 {
            if self.socket_path(id).exists() { return Ok(()); }
            if let Some(status) = child.try_wait().map_err(|e| ComputeError::Provider(format!("Jailer process check failed: {e}")))? {
                return Err(ComputeError::Provider(format!("Firecracker jailer exited before opening its API socket: {status}")));
            }
            sleep(Duration::from_millis(100)).await;
        }
        Err(ComputeError::Provider("Timed out waiting for the Firecracker API socket".into()))
    }

    fn tap_name(id: &str) -> String {
        let digest = Uuid::new_v5(&Uuid::NAMESPACE_URL, format!("kestrel:tap:{id}").as_bytes());
        format!("kt{}", &digest.simple().to_string()[..11])
    }

    fn guest_mac(id: &str) -> String {
        let digest = Uuid::new_v5(&Uuid::NAMESPACE_URL, format!("kestrel:mac:{id}").as_bytes());
        let bytes = digest.as_bytes();
        format!("02:fc:{:02x}:{:02x}:{:02x}:{:02x}", bytes[0], bytes[1], bytes[2], bytes[3])
    }

    async fn create_tap(&self, id: &str) -> Result<String, ComputeError> {
        let tap = Self::tap_name(id);
        let uid = self.config.uid.to_string();
        let created = Command::new("ip").args(["tuntap", "add", "dev", &tap, "mode", "tap", "user", &uid])
            .status().await.map_err(|e| ComputeError::Provider(format!("Cannot create Firecracker TAP interface: {e}")))?;
        if !created.success() { return Err(ComputeError::Provider("Linux refused to create the Firecracker TAP interface".into())); }
        let attached = Command::new("ip").args(["link", "set", "dev", &tap, "master", &self.config.network_bridge])
            .status().await.map_err(|e| ComputeError::Provider(format!("Cannot attach Firecracker TAP interface to bridge: {e}")))?;
        if !attached.success() {
            let _ = Command::new("ip").args(["link", "delete", "dev", &tap]).status().await;
            return Err(ComputeError::Provider("Could not attach Firecracker TAP interface to configured bridge".into()));
        }
        let up = Command::new("ip").args(["link", "set", "dev", &tap, "up"])
            .status().await.map_err(|e| ComputeError::Provider(format!("Cannot activate Firecracker TAP interface: {e}")))?;
        if !up.success() {
            let _ = Command::new("ip").args(["link", "delete", "dev", &tap]).status().await;
            return Err(ComputeError::Provider("Could not bring Firecracker TAP interface online".into()));
        }
        Ok(tap)
    }

    async fn delete_tap(&self, id: &str) {
        let tap = Self::tap_name(id);
        let _ = Command::new("ip").args(["link", "delete", "dev", &tap]).status().await;
    }

    fn instance(&self, id: &str, state: InstanceState) -> Instance {
        let stable_id = Uuid::new_v5(&Uuid::NAMESPACE_URL, format!("kestrel:firecracker:{id}").as_bytes());
        Instance { id: stable_id, provider_id: id.to_owned(), name: id.to_owned(), state, ipv4: Vec::new() }
    }
}

fn validate_id(id: &str) -> Result<(), ComputeError> {
    if id.is_empty() || id.len() > 63
        || !id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || !id.as_bytes()[0].is_ascii_alphanumeric() || !id.as_bytes()[id.len()-1].is_ascii_alphanumeric()
    {
        return Err(ComputeError::InvalidSpec("Invalid Firecracker instance identifier".into()));
    }
    Ok(())
}

#[async_trait]
impl ComputeProvider for FirecrackerProvider {
    fn kind(&self) -> ProviderKind { ProviderKind::Firecracker }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities { virtual_machines: true, snapshots: false, live_migration: false, console: false, cluster_scheduling: false }
    }

    async fn health(&self) -> Result<(), ComputeError> {
        self.config.validate()?;
        for path in [&self.config.jailer_binary, &self.config.firecracker_binary, &self.config.kernel_image_dir.join("vmlinux")] {
            if !path.is_file() { return Err(ComputeError::NotConfigured(format!("Required Firecracker host file is missing: {}", path.display()))); }
        }
        if !Path::new("/dev/kvm").exists() {
            return Err(ComputeError::NotConfigured("Firecracker requires a Linux KVM device at /dev/kvm".into()));
        }
        Ok(())
    }

    async fn create_instance(&self, spec: &InstanceSpec) -> Result<Instance, ComputeError> {
        spec.validate()?;
        validate_id(&spec.name)?;
        let rootfs = self.rootfs_source(&spec.image)?;
        if !rootfs.is_file() { return Err(ComputeError::NotConfigured("Requested Firecracker rootfs image is not installed on this host".into())); }
        if self.socket_path(&spec.name).exists() {
            return self.get_instance(&spec.name).await;
        }
        let mut children = self.children.lock().await;
        if children.contains_key(&spec.name) { return Err(ComputeError::Provider("Firecracker instance already exists on this agent".into())); }
        let jail_base = self.config.api_socket_dir.join("firecracker");
        tokio::fs::create_dir_all(&jail_base).await
            .map_err(|e| ComputeError::Provider(format!("Cannot create Firecracker jail base: {e}")))?;
        let mut child = Command::new(&self.config.jailer_binary)
            .arg("--id").arg(&spec.name)
            .arg("--exec-file").arg(&self.config.firecracker_binary)
            .arg("--uid").arg(self.config.uid.to_string())
            .arg("--gid").arg(self.config.gid.to_string())
            .arg("--chroot-base-dir").arg(&self.config.api_socket_dir)
            .arg("--").arg("--api-sock").arg("/run/firecracker.socket")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn().map_err(|e| ComputeError::Provider(format!("Unable to start Firecracker jailer: {e}")))?;
        if let Err(error) = self.wait_for_socket(&spec.name, &mut child).await {
            let _ = child.kill().await;
            return Err(error);
        }
        let jail_root = self.jail_root(&spec.name);
        let setup = async {
            tokio::fs::create_dir_all(jail_root.join("run")).await
                .map_err(|e| ComputeError::Provider(format!("Cannot prepare Firecracker jail: {e}")))?;
            let pid = child.id().ok_or_else(|| ComputeError::Provider("Firecracker jailer did not expose a process ID".into()))?;
            tokio::fs::write(jail_root.join("firecracker.pid"), pid.to_string()).await
                .map_err(|e| ComputeError::Provider(format!("Cannot persist Firecracker process ID: {e}")))?;
            tokio::fs::copy(self.config.kernel_image_dir.join("vmlinux"), jail_root.join("vmlinux")).await
                .map_err(|e| ComputeError::Provider(format!("Cannot stage Firecracker kernel: {e}")))?;
            tokio::fs::copy(rootfs, jail_root.join("rootfs.ext4")).await
                .map_err(|e| ComputeError::Provider(format!("Cannot stage Firecracker rootfs: {e}")))?;
            let tap = self.create_tap(&spec.name).await?;
            self.api_request(&spec.name, "PUT", "/machine-config", Some(json!({
                "vcpu_count":spec.vcpus,"mem_size_mib":spec.memory_mib,"smt":false,"track_dirty_pages":false
            }))).await?;
            self.api_request(&spec.name, "PUT", "/boot-source", Some(json!({
                "kernel_image_path":"/vmlinux","boot_args":"console=ttyS0 reboot=k panic=1 pci=off"
            }))).await?;
            self.api_request(&spec.name, "PUT", "/drives/rootfs", Some(json!({
                "drive_id":"rootfs","path_on_host":"/rootfs.ext4","is_root_device":true,"is_read_only":false
            }))).await?;
            self.api_request(&spec.name, "PUT", "/network-interfaces/eth0", Some(json!({
                "iface_id":"eth0","host_dev_name":tap,"guest_mac":Self::guest_mac(&spec.name)
            }))).await?;
            self.api_request(&spec.name, "PUT", "/actions", Some(json!({"action_type":"InstanceStart"}))).await?;
            Ok::<(), ComputeError>(())
        }.await;
        if let Err(error) = setup {
            let _ = child.kill().await;
            let _ = child.wait().await;
            self.delete_tap(&spec.name).await;
            let _ = tokio::fs::remove_dir_all(self.config.api_socket_dir.join("firecracker").join(&spec.name)).await;
            return Err(error);
        }
        child.kill_on_drop(false);
        children.insert(spec.name.clone(), child);
        Ok(self.instance(&spec.name, InstanceState::Running))
    }

    async fn get_instance(&self, id: &str) -> Result<Instance, ComputeError> {
        validate_id(id)?;
        let process_state = {
            let mut children = self.children.lock().await;
            match children.get_mut(id) {
                Some(child) => child.try_wait().map_err(|e| ComputeError::Provider(format!("Firecracker process check failed: {e}")))?,
                None => None,
            }
        };
        if let Some(status) = process_state {
            return Ok(self.instance(id, if status.success() { InstanceState::Stopped } else { InstanceState::Failed }));
        }
        let state = self.api_request(id, "GET", "/vm", None).await
            .and_then(|v| match v.get("state").and_then(Value::as_str) {
                Some("Running") => Ok(InstanceState::Running),
                Some("Paused") => Ok(InstanceState::Stopped),
                _ => Ok(InstanceState::Unknown),
            })?;
        Ok(self.instance(id, state))
    }

    async fn start_instance(&self, id: &str) -> Result<(), ComputeError> {
        validate_id(id)?;
        self.api_request(id, "PATCH", "/vm", Some(json!({"state":"Resumed"}))).await.map(|_| ())
    }

    async fn stop_instance(&self, id: &str) -> Result<(), ComputeError> {
        validate_id(id)?;
        self.api_request(id, "PATCH", "/vm", Some(json!({"state":"Paused"}))).await.map(|_| ())
    }

    async fn delete_instance(&self, id: &str) -> Result<(), ComputeError> {
        validate_id(id)?;
        let mut children = self.children.lock().await;
        if let Some(mut child) = children.remove(id) {
            child.kill().await.map_err(|e| ComputeError::Provider(format!("Unable to terminate Firecracker process: {e}")))?;
            let _ = child.wait().await;
        } else {
            let pid_path = self.jail_root(id).join("firecracker.pid");
            let pid = tokio::fs::read_to_string(pid_path).await
                .map_err(|e| ComputeError::Provider(format!("Cannot find persisted Firecracker process ID: {e}")))?;
            let pid = pid.trim();
            if !pid.bytes().all(|b| b.is_ascii_digit()) || pid.is_empty() {
                return Err(ComputeError::Provider("Persisted Firecracker process ID is invalid".into()));
            }
            let command_line = tokio::fs::read(format!("/proc/{pid}/cmdline")).await
                .map_err(|e| ComputeError::Provider(format!("Cannot verify persisted Firecracker process: {e}")))?;
            if !command_line.windows(b"firecracker".len()).any(|window| window == b"firecracker") {
                return Err(ComputeError::Provider("Persisted process is not a Firecracker jailer/runtime process".into()));
            }
            let status = Command::new("kill").arg("-TERM").arg(pid).status().await
                .map_err(|e| ComputeError::Provider(format!("Unable to signal Firecracker process: {e}")))?;
            if !status.success() {
                return Err(ComputeError::Provider("Firecracker process could not be terminated".into()));
            }
        }
        self.delete_tap(id).await;
        let jail = self.config.api_socket_dir.join("firecracker").join(id);
        tokio::fs::remove_dir_all(jail).await
            .map_err(|e| ComputeError::Provider(format!("Unable to remove Firecracker jail: {e}")))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> FirecrackerConfig {
        FirecrackerConfig {
            api_socket_dir:PathBuf::from("/var/lib/kestrel/jailer"),
            jailer_binary:PathBuf::from("/usr/bin/jailer"),
            firecracker_binary:PathBuf::from("/usr/bin/firecracker"),
            kernel_image_dir:PathBuf::from("/var/lib/kestrel/kernels"),
            rootfs_image_dir:PathBuf::from("/var/lib/kestrel/rootfs"),
            network_bridge:"br-kestrel".into(),
            uid:1000,gid:1000,
        }
    }

    #[test]
    fn validates_absolute_paths_and_non_root_identity() {
        assert!(config().validate().is_ok());
        let mut value = config(); value.api_socket_dir = PathBuf::from("/"); assert!(value.validate().is_err());
        let mut value = config(); value.uid = 0; assert!(value.validate().is_err());
        let mut value = config(); value.jailer_binary = PathBuf::from("jailer"); assert!(value.validate().is_err());
    }

    #[test]
    fn rejects_path_traversal_in_image_and_instance_names() {
        let provider = FirecrackerProvider { config:config(), children:Mutex::new(HashMap::new()) };
        assert!(provider.rootfs_source("../../etc/passwd").is_err());
        assert!(validate_id("../host").is_err());
        assert!(validate_id("vm-01").is_ok());
    }

    #[test]
    fn validates_network_bridge_and_derives_safe_tap_names() {
        assert!(config().validate().is_ok());
        let mut value = config();
        value.network_bridge = "bridge-name-that-is-too-long".into();
        assert!(value.validate().is_err());
        assert!(FirecrackerProvider::tap_name("vm-01").len() <= 15);
        assert!(FirecrackerProvider::guest_mac("vm-01").starts_with("02:fc:"));
    }

    #[test]
    fn derives_stable_instance_ids() {
        let provider = FirecrackerProvider { config:config(), children:Mutex::new(HashMap::new()) };
        assert_eq!(provider.instance("vm-01", InstanceState::Running).id, provider.instance("vm-01", InstanceState::Stopped).id);
    }
}
