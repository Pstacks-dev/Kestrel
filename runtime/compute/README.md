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

The shared Rust provider contract and VM resource validation are in place.

- **Incus:** mTLS REST client, project-scoped requests, asynchronous operation waiting, VM create/lookup/start/stop/delete calls and configuration/URL-scope tests.
- **Firecracker:** jailer process launch, per-instance chroot layout, staged kernel/rootfs, Unix-domain HTTP API, machine configuration, boot source, root drive, instance start, state lookup, graceful guest shutdown and process/jail cleanup. The image field is a pre-installed rootfs filename in the configured rootfs directory; the host must supply a compatible kernel and ext4 rootfs. The jailer must run with the privileges needed to create its chroot, while Firecracker itself runs under the configured non-root UID/GID.
- **KubeVirt:** HTTPS client with a pinned cluster CA and namespace-scoped service-account token, VM manifest creation, resource mapping, optional cloud-init SSH key, lookup, start/stop subresources and deletion. The configured namespace's RBAC must grant only the required VirtualMachine and VirtualMachineInstance operations.

These implementations have not yet passed a fresh CI run or been exercised against real Incus, Firecracker or KubeVirt hosts. They are code-level integrations, not proof that a provider is provisioned or that a customer VM can be reached.

## Remaining integration

Persistent Kestrel VM records, provider-node registration, resource-aware scheduling, asynchronous provisioning reconciliation, quotas, tenant authorization, network attachment/IP allocation, SSH/console proxying, snapshots and monitoring still need to be connected to the control plane and dashboard. Firecracker networking also needs a trusted host-side TAP/network setup; customer workloads must never receive provider sockets or host credentials. Incus and KubeVirt image/storage profiles need explicit operator-managed configuration.

## Build and test

    cargo test --manifest-path runtime/compute/Cargo.toml
    cargo clippy --manifest-path runtime/compute/Cargo.toml --all-targets -- -D warnings
