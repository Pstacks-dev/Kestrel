use crate::{ComputeError, ComputeProvider, Instance, InstanceSpec, ProviderCapabilities, ProviderKind};
use async_trait::async_trait;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct FirecrackerConfig {
    pub api_socket_dir: PathBuf,
    pub jailer_binary: PathBuf,
    pub kernel_image_dir: PathBuf,
    pub rootfs_image_dir: PathBuf,
}
impl FirecrackerConfig {
    pub fn validate(&self) -> Result<(), ComputeError> {
        for path in [&self.api_socket_dir, &self.jailer_binary, &self.kernel_image_dir, &self.rootfs_image_dir] {
            if !path.is_absolute() { return Err(ComputeError::NotConfigured("Firecracker paths must be absolute".into())); }
        }
        if self.api_socket_dir == PathBuf::from("/") { return Err(ComputeError::NotConfigured("Unsafe Firecracker socket directory".into())); }
        Ok(())
    }
}
pub struct FirecrackerProvider { pub config: FirecrackerConfig }
#[async_trait]
impl ComputeProvider for FirecrackerProvider {
    fn kind(&self) -> ProviderKind { ProviderKind::Firecracker }
    fn capabilities(&self) -> ProviderCapabilities { ProviderCapabilities { virtual_machines: true, snapshots: false, live_migration: false, console: true, cluster_scheduling: false } }
    async fn health(&self) -> Result<(), ComputeError> { self.config.validate()?; Err(ComputeError::NotImplemented("Firecracker Unix-socket and jailer integration is not connected yet".into())) }
    async fn create_instance(&self, spec: &InstanceSpec) -> Result<Instance, ComputeError> { spec.validate()?; Err(ComputeError::NotImplemented("Firecracker VM creation requires jailer and prepared kernel/rootfs images".into())) }
    async fn get_instance(&self, _: &str) -> Result<Instance, ComputeError> { Err(ComputeError::NotImplemented("Firecracker lookup".into())) }
    async fn start_instance(&self, _: &str) -> Result<(), ComputeError> { Err(ComputeError::NotImplemented("Firecracker start".into())) }
    async fn stop_instance(&self, _: &str) -> Result<(), ComputeError> { Err(ComputeError::NotImplemented("Firecracker stop".into())) }
    async fn delete_instance(&self, _: &str) -> Result<(), ComputeError> { Err(ComputeError::NotImplemented("Firecracker delete".into())) }
}
