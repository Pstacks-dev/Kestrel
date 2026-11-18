//! Provider-neutral VM orchestration contracts for Kestrel.
pub mod providers;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind { Incus, Firecracker, KubeVirt }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceState { Pending, Starting, Running, Stopping, Stopped, Failed, Unknown }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceSpec {
    pub name: String,
    pub image: String,
    pub vcpus: u16,
    #[serde(rename = "memoryMiB")]
    pub memory_mib: u32,
    #[serde(rename = "diskGiB")]
    pub disk_gib: u16,
    pub region: Option<String>,
    pub ssh_public_key: Option<String>,
}

impl InstanceSpec {
    pub fn validate(&self) -> Result<(), ComputeError> {
        let name_ok = !self.name.is_empty() && self.name.len() <= 63
            && self.name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            && self.name.as_bytes()[0].is_ascii_alphanumeric()
            && self.name.as_bytes()[self.name.len()-1].is_ascii_alphanumeric();
        if !name_ok { return Err(ComputeError::InvalidSpec("invalid VM name".into())); }
        if self.image.trim().is_empty() || self.image.len() > 512
            || self.image.bytes().any(|c| c.is_ascii_whitespace() || c.is_ascii_control())
        {
            return Err(ComputeError::InvalidSpec("image is required, must not contain whitespace, and is limited to 512 characters".into()));
        }
        if !(1..=64).contains(&self.vcpus) { return Err(ComputeError::InvalidSpec("vCPUs must be 1-64".into())); }
        if !(512..=262144).contains(&self.memory_mib) { return Err(ComputeError::InvalidSpec("memory must be 512-262144 MiB".into())); }
        if !(5..=4096).contains(&self.disk_gib) { return Err(ComputeError::InvalidSpec("disk must be 5-4096 GiB".into())); }
        if let Some(key) = &self.ssh_public_key {
            let mut fields = key.split_whitespace();
            let key_type = fields.next().unwrap_or_default();
            let key_data = fields.next().unwrap_or_default();
            let supported = matches!(key_type, "ssh-ed25519" | "ssh-rsa" | "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521");
            let valid_data = !key_data.is_empty() && key_data.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/' || c == b'=');
            if key.len() > 16384 || key.bytes().any(|c| c.is_ascii_control()) || !supported || !valid_data {
                return Err(ComputeError::InvalidSpec("SSH key must be a single-line supported OpenSSH public key".into()));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance { pub id: Uuid, pub provider_id: String, pub name: String, pub state: InstanceState, pub ipv4: Vec<String> }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities { pub virtual_machines: bool, pub snapshots: bool, pub live_migration: bool, pub console: bool, pub cluster_scheduling: bool }

#[derive(Debug, Error)]
pub enum ComputeError {
    #[error("invalid VM specification: {0}")] InvalidSpec(String),
    #[error("provider is not configured: {0}")] NotConfigured(String),
    #[error("provider operation is not implemented: {0}")] NotImplemented(String),
    #[error("provider operation failed: {0}")] Provider(String),
}

#[async_trait]
pub trait ComputeProvider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn capabilities(&self) -> ProviderCapabilities;
    async fn health(&self) -> Result<(), ComputeError>;
    async fn create_instance(&self, spec: &InstanceSpec) -> Result<Instance, ComputeError>;
    async fn get_instance(&self, id: &str) -> Result<Instance, ComputeError>;
    async fn start_instance(&self, id: &str) -> Result<(), ComputeError>;
    async fn stop_instance(&self, id: &str) -> Result<(), ComputeError>;
    async fn delete_instance(&self, id: &str) -> Result<(), ComputeError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spec() -> InstanceSpec { InstanceSpec { name: "kestrel-vm-01".into(), image: "ubuntu:24.04".into(), vcpus: 2, memory_mib: 2048, disk_gib: 30, region: None, ssh_public_key: None } }
    #[test] fn valid_spec_passes() { assert!(spec().validate().is_ok()); }
    #[test] fn unsafe_name_small_memory_and_multiline_ssh_are_rejected() {
        let mut value = spec(); value.name = "../root".into(); assert!(value.validate().is_err());
        let mut value = spec(); value.memory_mib = 128; assert!(value.validate().is_err());
        let mut value = spec(); value.ssh_public_key = Some("ssh-ed25519 AAAA\\ncommand".into()); assert!(value.validate().is_err());
    }

    #[test] fn vm_spec_uses_api_resource_field_names() {
        let value = serde_json::to_value(spec()).unwrap();
        assert_eq!(value.get("memoryMiB").and_then(serde_json::Value::as_u64), Some(2048));
        assert_eq!(value.get("diskGiB").and_then(serde_json::Value::as_u64), Some(30));
    }
}
