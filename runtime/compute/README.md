# Kestrel Compute

Kestrel Compute is a provider-neutral VM control plane. Kestrel owns customer
tenancy, quota checks, placement, VM inventory, operation leases and the
dashboard. A trusted Linux host agent holds provider credentials and executes
provider API calls. Provider sockets, cluster tokens and host credentials are
never sent to the browser or customer workloads.

## Provider backends

| Provider | Role | Host requirements |
| --- | --- | --- |
| Incus | General-purpose Linux VMs | Linux/KVM host, Incus daemon, dedicated project and trusted mTLS client identity |
| Firecracker | Lightweight microVMs | Linux/KVM host, /dev/kvm, jailer, compatible kernel and prepared ext4 rootfs images |
| KubeVirt | VMs on Kubernetes | Kubernetes cluster with KubeVirt, namespace-scoped service account and cluster CA |

They are alternative provider pools, not nested engines. Kestrel schedules a
VM only onto an online node with the requested provider, region and sufficient
unallocated vCPU, memory, disk and instance capacity.

## Implemented control-plane features

- Migration 017_compute_providers.sql creates provider-node inventory,
  hashed node credentials, tenant VM records, durable operations and workspace
  compute quotas.
- Platform operators provision provider nodes through
  POST /api/admin/compute/nodes. The returned agent token is shown once;
  only its SHA-256 hash is stored.
- Workspace members with owner, admin or developer role can list VMs, create
  VMs, and queue start, stop and delete operations.
- The scheduler serializes quota and node-capacity reservations in PostgreSQL.
  It does not assign work to stale, offline or draining nodes.
- The host agent registers, heartbeats, claims operations using a 90-second
  lease, renews long-running leases, executes the provider action and reports
  the resulting provider ID, state and IP addresses.
- Expired operations are retried within a bounded attempt count. Exhausted
  create operations fail and release their capacity reservation.
- The existing Kestrel workspace interface has a Compute page with VM
  creation, quota usage, status and lifecycle controls.

## Build and test

```sh
cargo test --manifest-path runtime/compute/Cargo.toml
cargo clippy --manifest-path runtime/compute/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path runtime/compute-agent/Cargo.toml
cargo clippy --manifest-path runtime/compute-agent/Cargo.toml --all-targets -- -D warnings
cargo build --release --manifest-path runtime/compute-agent/Cargo.toml
```

## Provisioning a provider node

First apply migrations in numeric order through 017_compute_providers.sql to
the Kestrel PostgreSQL database. A platform administrator then provisions a
node with a provider, region and physical capacity:

```http
POST /api/admin/compute/nodes
Authorization: Bearer <platform-admin-session>
Content-Type: application/json

{
  "id": "incus-ibadan-01",
  "provider": "incus",
  "hostname": "incus-ibadan-01",
  "region": "ng-ibadan",
  "totalVcpu": 16,
  "totalMemoryMib": 32768,
  "totalDiskGib": 1000,
  "maxInstances": 40
}
```

The response contains a one-time agentToken. Store it in a root-readable
environment file on the matching Linux host. Never put this token in Vite
variables, customer projects, images or browser storage.

### Common agent environment

```sh
KESTREL_API_URL=https://your-kestrel-api.example
KESTREL_COMPUTE_NODE_ID=incus-ibadan-01
KESTREL_COMPUTE_NODE_TOKEN=<one-time-node-token>
KESTREL_COMPUTE_PROVIDER=incus
```

### Incus node

```sh
KESTREL_INCUS_ENDPOINT=https://127.0.0.1:8443
KESTREL_INCUS_PROJECT=kestrel
KESTREL_INCUS_CLIENT_CERT=/etc/kestrel/incus-client.crt
KESTREL_INCUS_CLIENT_KEY=/etc/kestrel/incus-client.key
KESTREL_INCUS_SERVER_CA=/etc/kestrel/incus-server-ca.crt
```

The client certificate must be trusted by the Incus daemon and restricted to
the dedicated Kestrel project. The configured image is an Incus image alias
available to that project.

### Firecracker node

```sh
KESTREL_COMPUTE_PROVIDER=firecracker
KESTREL_FIRECRACKER_CHROOT_BASE=/var/lib/kestrel/jailer
KESTREL_FIRECRACKER_JAILER=/usr/bin/jailer
KESTREL_FIRECRACKER_BINARY=/usr/bin/firecracker
KESTREL_FIRECRACKER_KERNEL_DIR=/var/lib/kestrel/kernels
KESTREL_FIRECRACKER_ROOTFS_DIR=/var/lib/kestrel/rootfs
KESTREL_FIRECRACKER_BRIDGE=br-kestrel
KESTREL_FIRECRACKER_UID=1000
KESTREL_FIRECRACKER_GID=1000
```

Install a compatible kernel as vmlinux and each supported guest root
filesystem as a pre-installed ext4 file in the rootfs directory. Guest images
must include cloud-init when SSH public-key injection is requested; install
the cloud-localds utility on the host agent. The VM
request's image field must be the filename only (for example
ubuntu-24.04.ext4). The agent needs the host privileges required by the
jailer; Firecracker itself is configured to run under the non-root UID/GID.
Use a dedicated filesystem and operator-owned directories for the jailer
chroot base. Create and secure the bridge (including DHCP, routing and
firewall rules) before starting the agent. The agent creates one TAP interface
per microVM, attaches it to that bridge and configures the Firecracker guest
interface; it does not create a public IP or firewall policy for the host.

### KubeVirt node

```sh
KESTREL_COMPUTE_PROVIDER=kubevirt
KESTREL_KUBEVIRT_API_SERVER=https://kubernetes.example:6443
KESTREL_KUBEVIRT_NAMESPACE=kestrel-workloads
KESTREL_KUBEVIRT_TOKEN_FILE=/etc/kestrel/kubevirt-token
KESTREL_KUBEVIRT_CA_FILE=/etc/kestrel/kubernetes-ca.crt
```

The service account must be restricted to the configured namespace and only
the VirtualMachine and VirtualMachineInstance operations Kestrel needs. The
image field is a containerDisk image reference accessible to the cluster.

### Run the host agent

Build the binary on a compatible Linux host and run it under a service manager
with a protected environment file:

```sh
cargo build --release --manifest-path runtime/compute-agent/Cargo.toml
./target/release/kestrel-compute-agent
```

The agent runs one provider backend per node. It must not be placed inside a
customer build container. Give it only the host permissions and credentials
needed for its selected backend.

## Security boundaries and limitations

- Customer VM requests cannot specify host paths, sockets, raw provider
  configuration, Kubernetes API URLs or arbitrary device mappings.
- Provider credentials remain on the trusted host agent. Compute node tokens
  are stored as one-way hashes and agent requests require a matching node ID.
- Workspace quotas and node capacity are reserved transactionally before an
  operation is queued. RLS protects tenant VM and operation reads.
- Firecracker API sockets are kept inside per-instance jailer directories.
  The agent persists process IDs so a restarted agent can reconnect to
  existing Firecracker instances.
- SSH public keys can be injected at guest creation, but Kestrel does not yet
  provide an SSH proxy, web console or private network ingress.
- Firecracker managed IP allocation, snapshots, backup/restore, live migration,
  monitoring metrics and managed TLS ingress
  are not yet implemented. Provider capabilities intentionally report these
  as unavailable.
- Incus and KubeVirt image/storage profiles and KubeVirt image pull secrets
  are operator-managed. Customer-controlled image credentials are not exposed.
- Provider API implementations and the control-plane integration have not yet
  been verified against real Incus, Firecracker or KubeVirt hosts. No hosted
  compute node has been provisioned for this repository, and a green CI run
  has not yet been observed. Do not treat this as production-ready until
  migration, provider-host and end-to-end VM tests pass.
