# Kestrel Rust execution runtime

This crate is the native Rust worker process for Kestrel's execution plane. It speaks the existing worker-authenticated control-plane protocol and runs each customer job in a fresh, constrained Docker container.

## Required environment

- `KESTREL_API_URL`: public HTTPS Kestrel API base URL.
- `KESTREL_WORKER_ID`: provisioned worker ID.
- `KESTREL_WORKER_TOKEN`: one-time worker credential (keep secret).
- `KESTREL_JOB_IMAGE`: immutable, digest-pinned job image in production.
- Optional: `KESTREL_WORKER_WORKDIR`, `KESTREL_WORKER_HOST_WORKDIR`, `KESTREL_CONCURRENCY`, `KESTREL_REGION`, `KESTREL_JOB_NETWORK`, `KESTREL_DOCKER_BIN`.
- `KESTREL_JOB_NETWORK` defaults to `none` in production and `bridge` in development. Every production Rust worker requires the Docker egress firewall and `KESTREL_EGRESS_HARDENED=true`, because managed deployment containers use Docker bridge networking even when build jobs use `none`. The Rust installer sets this only after the firewall service starts successfully.

## Build and run

```sh
cargo test --manifest-path runtime/rust/Cargo.toml
cargo build --release --manifest-path runtime/rust/Cargo.toml
NODE_ENV=development KESTREL_API_URL=http://127.0.0.1:4000 KESTREL_WORKER_ID=dev-worker KESTREL_WORKER_TOKEN=... runtime/rust/target/release/kestrel-runtime
```

The runtime supports Git-backed and uploaded-source projects, worker registration/heartbeat/claim, bounded concurrent execution, streamed logs, cancellation polling, timeouts, artifact uploads and Docker-based job isolation. It does not expose the Docker socket to job containers.

## Worker lifecycle

Platform administrators can move a worker to `draining` to stop new claims while existing jobs finish, `offline` to prevent new claims, or `online` to resume scheduling. These changes are available from the existing `/admin` console and are recorded in the audit log. The worker heartbeat preserves administrator-selected `draining` and `offline` states.

## Security boundary

Rust is the trusted host-side supervisor, not a substitute for an OS sandbox. Docker still shares the host kernel. Production multi-tenant workers must use dedicated hosts, digest-pinned images, strict egress controls, ephemeral credentials, and a stronger sandbox (gVisor, Kata, or Firecracker) before accepting hostile public workloads.


## Connect a deployment worker

Workspace members with developer access can provision a one-time worker credential from **Workspace → Deployments → Set up deployment worker**. Install the runtime on a dedicated Ubuntu/Debian Linux host that has Docker Engine available:

```sh
curl -fsSL https://raw.githubusercontent.com/Pstacks-dev/Kestrel/main/deploy/install-rust-worker.sh | sudo bash
```

The installer prompts for the worker ID, Kestrel API URL, hostname, region label, concurrency and one-time token. It validates the provisioned ID and token, installs Docker, iptables and Rust, builds the runtime, pins the Node.js job image by immutable multi-platform SHA-256 digest, writes a root-owned credential file with `NODE_ENV=production`, and configures systemd. It installs and enables the Docker egress firewall before starting the worker; the worker service requires that firewall unit and will not start if it fails. Enter the same concurrency value selected when provisioning the credential. The token is read without echo and is never placed in the shell command.

After install, verify the worker from the dashboard or with:

```sh
sudo systemctl status kestrel-rust-worker
sudo journalctl -u kestrel-rust-worker -f
```

**Use a dedicated Linux host.** Vercel Sandboxes do not expose a Docker daemon/socket, so they cannot run this container deployment runtime. Membership in the Docker group is root-equivalent; treat the worker as privileged infrastructure and never run it on a shared/untrusted host.

## Deployment engine

The Rust worker can also process Kestrel deployment jobs. A deployment environment is pinned to one Rust worker and one published host port. A release pulls the requested container image, stops the currently active release, starts the new container with dropped Linux capabilities, no-new-privileges, a read-only root filesystem, a PID limit and a memory limit, then polls the configured HTTP health path. If the candidate does not become healthy, the worker attempts to restart the previous release container before reporting failure.

This is a host-port deployment primitive, not a managed TLS ingress. Put a reverse proxy/load balancer in front of the worker and configure the environment's public URL to the routed hostname. The current switch has a short interruption while the old container stops and the candidate starts; it is not zero-downtime blue/green traffic switching.

Deployment environments can select only workers registered with `runtime=rust`. Private registry credentials are not yet managed by the deployment UI; use images accessible to the worker's Docker daemon until registry credential support is added.

## Worker egress hardening

The Rust worker installer enables this firewall automatically before starting the worker. For manually configured Docker workers, use Docker `bridge` networking only after installing the host firewall. On a dedicated Linux worker, copy the repository to `/opt/kestrel`, then run:

```sh
sudo install -m 0755 /opt/kestrel/deploy/harden-worker-egress.sh /usr/local/sbin/kestrel-harden-worker-egress
sudo install -m 0644 /opt/kestrel/deploy/kestrel-worker-egress.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kestrel-worker-egress.service
```

The firewall places rules in Docker's `DOCKER-USER` chain to block container access to host-local addresses, private networks, loopback, link-local and cloud metadata ranges while allowing established replies and public internet egress. The production runtime refuses to start unless `KESTREL_EGRESS_HARDENED=true` is set in the root-owned worker environment file, regardless of the build-job network setting. Verify the rules after every Docker/OS upgrade and persist them through the systemd unit. This is an additional network boundary, not a substitute for dedicated worker hosts and stronger sandboxing such as gVisor, Kata Containers or Firecracker.


## Database migrations for the current execution/deployment features

Apply migrations in numeric order before deploying the matching control-plane code:

- `008_artifact_lifecycle.sql`
- `009_recovery_state_consistency.sql`
- `010_deployment_engine.sql`
- `011_deployment_lease_recovery.sql`
- `012_artifact_upload_sessions.sql`
- `013_recovery_deployment_state.sql`
- `014_job_retry_backoff.sql`
- `015_recovery_backoff.sql`
- `016_worker_desired_state.sql`

Artifacts are uploaded directly to Supabase Storage through one-use signed URLs; the Vercel API does not proxy large artifact bodies. Expired upload sessions are cleaned up with the same cron. The artifact lifecycle defaults to no automatic expiry. Set `KESTREL_ARTIFACT_RETENTION_DAYS` to a value from 1 to 3650 to expire newly uploaded artifacts; the protected daily cron removes expired objects from the private Supabase bucket. Set a strong `CRON_SECRET` in the control plane for both lease recovery and artifact cleanup.
