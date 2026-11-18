# Kestrel Compute

Kestrel Compute is a provider-neutral VM control layer. Kestrel owns the
customer-facing API, tenancy, quotas, scheduling, audit trail and dashboard.
A dedicated Linux host agent holds the credentials needed to talk to the
selected virtualization engine.

## Supported provider directions

| Provider | Intended role | Host requirements |
| --- | --- | --- |
| Incus | General-purpose Linux VMs and system containers; first integration target | Linux, KVM for VMs, Incus daemon and trusted client certificates |
| Firecracker | Lightweight microVMs for isolated workloads | Linux/KVM, Firecracker, jailer, kernel and prepared root filesystems |
| KubeVirt | VM scheduling on an existing Kubernetes cluster | Kubernetes cluster with KubeVirt installed and scoped service-account RBAC |

These providers are alternatives assigned to separate compute nodes or pools.
They are not nested inside one another. Incus is the first provider to complete:
it offers a direct VM management API without requiring Kestrel to introduce
Kubernetes as a dependency.

## Security boundaries

- Never expose the Incus privileged socket, Firecracker API socket or
  Kubernetes cluster credentials to the browser or public control plane.
- Only the Kestrel host agent may hold provider credentials. Use per-node
  identities, narrow permissions and credential rotation.
- Use a dedicated Incus project, Firecracker jailer isolation, or a dedicated
  Kubernetes namespace with narrowly scoped RBAC.
- Enforce organization quotas before scheduling and enforce CPU, memory, disk,
  network and instance-count limits at the provider.
- Do not accept customer-controlled host paths, device mappings, raw provider
  configuration or arbitrary API URLs.
- Keep host kernels, QEMU/Firecracker, firmware and guest images patched.

## Current implementation status

The first implementation adds a shared Rust provider contract, VM resource
validation and provider-specific configuration validation for Incus,
Firecracker and KubeVirt. It does not yet create real VMs. Provider API
transports, persistent VM records, scheduling, image/network provisioning,
console/SSH access, snapshots and quota enforcement remain to be implemented
and tested on a real KVM host.

Provider operations deliberately return an explicit not-implemented error
until their security-sensitive transports are connected. This prevents the
API or dashboard from claiming that a VM was created when no hypervisor
operation occurred.

## Build and test

    cargo test --manifest-path runtime/compute/Cargo.toml
    cargo clippy --manifest-path runtime/compute/Cargo.toml --all-targets -- -D warnings
