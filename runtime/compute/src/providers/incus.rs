use crate::{ComputeError, ComputeProvider, Instance, InstanceSpec, ProviderCapabilities, ProviderKind};
use async_trait::async_trait;
use std::path::Path;

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
        if !self.https_endpoint.starts_with("https://") || self.https_endpoint.len() > 512 {
            return Err(ComputeError::NotConfigured("Incus must use an HTTPS endpoint".into()));
        }
        if self.project.is_empty() || self.project.len() > 128 {
            return Err(ComputeError::NotConfigured("Incus project is missing".into()));
        }
        for path in [&self.client_certificate_path, &self.client_key_path, &self.server_ca_path] {
            if path.is_empty() || !Path::new(path).is_absolute() {
                return Err(ComputeError::NotConfigured("Incus certificate, key and CA paths must be absolute".into()));
            }
        }
        Ok(())
    }
}
pub struct IncusProvider { pub config: IncusConfig }
#[async_trait]
impl ComputeProvider for IncusProvider {
    fn kind(&self) -> ProviderKind { ProviderKind::Incus }
    fn capabilities(&self) -> ProviderCapabilities { ProviderCapabilities { virtual_machines: true, snapshots: true, live_migration: true, console: true, cluster_scheduling: true } }
    async fn health(&self) -> Result<(), ComputeError> { self.config.validate()?; Err(ComputeError::NotImplemented("Incus mTLS API transport is not connected yet".into())) }
    async fn create_instance(&self, spec: &InstanceSpec) -> Result<Instance, ComputeError> { spec.validate()?; Err(ComputeError::NotImplemented("Incus VM creation is not enabled until mTLS transport is connected".into())) }
    async fn get_instance(&self, _: &str) -> Result<Instance, ComputeError> { Err(ComputeError::NotImplemented("Incus lookup".into())) }
    async fn start_instance(&self, _: &str) -> Result<(), ComputeError> { Err(ComputeError::NotImplemented("Incus start".into())) }
    async fn stop_instance(&self, _: &str) -> Result<(), ComputeError> { Err(ComputeError::NotImplemented("Incus stop".into())) }
    async fn delete_instance(&self, _: &str) -> Result<(), ComputeError> { Err(ComputeError::NotImplemented("Incus delete".into())) }
}
