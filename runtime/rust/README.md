# Kestrel Rust execution runtime

This crate is the native Rust worker process for Kestrel's execution plane. It speaks the existing worker-authenticated control-plane protocol and runs each customer job in a fresh, constrained Docker container.

## Required environment

- `KESTREL_API_URL`: public HTTPS Kestrel API base URL.
- `KESTREL_WORKER_ID`: provisioned worker ID.
- `KESTREL_WORKER_TOKEN`: one-time worker credential (keep secret).
- `KESTREL_JOB_IMAGE`: immutable, digest-pinned job image in production.
- Optional: `KESTREL_WORKER_WORKDIR`, `KESTREL_WORKER_HOST_WORKDIR`, `KESTREL_CONCURRENCY`, `KESTREL_REGION`, `KESTREL_JOB_NETWORK`, `KESTREL_DOCKER_BIN`.
- `KESTREL_JOB_NETWORK` defaults to Docker `bridge` so normal builds can download dependencies. Use `none` for offline-only jobs. A production deployment still needs an egress policy that blocks private network ranges and cloud metadata endpoints.

## Build and run

```sh
cargo test --manifest-path runtime/rust/Cargo.toml
cargo build --release --manifest-path runtime/rust/Cargo.toml
KESTREL_API_URL=https://your-kestrel-api.example KESTREL_WORKER_ID=wrk_x KESTREL_WORKER_TOKEN=... runtime/rust/target/release/kestrel-runtime
```

The runtime supports Git-backed and uploaded-source projects, worker registration/heartbeat/claim, bounded concurrent execution, streamed logs, cancellation polling, timeouts, artifact uploads and Docker-based job isolation. It does not expose the Docker socket to job containers.

## Worker lifecycle

Platform administrators can move a worker to `draining` to stop new claims while existing jobs finish, `offline` to prevent new claims, or `online` to resume scheduling. These changes are available from the existing `/admin` console and are recorded in the audit log. The worker heartbeat preserves administrator-selected `draining` and `offline` states.

## Security boundary

Rust is the trusted host-side supervisor, not a substitute for an OS sandbox. Docker still shares the host kernel. Production multi-tenant workers must use dedicated hosts, digest-pinned images, strict egress controls, ephemeral credentials, and a stronger sandbox (gVisor, Kata, or Firecracker) before accepting hostile public workloads.


## Deployment engine

The Rust worker can also process Kestrel deployment jobs. A deployment environment is pinned to one Rust worker and one published host port. A release pulls the requested container image, stops the currently active release, starts the new container with dropped Linux capabilities, no-new-privileges, a read-only root filesystem, a PID limit and a memory limit, then polls the configured HTTP health path. If the candidate does not become healthy, the worker attempts to restart the previous release container before reporting failure.

This is a host-port deployment primitive, not a managed TLS ingress. Put a reverse proxy/load balancer in front of the worker and configure the environment's public URL to the routed hostname. The current switch has a short interruption while the old container stops and the candidate starts; it is not zero-downtime blue/green traffic switching.

Deployment environments can select only workers registered with `runtime=rust`. Private registry credentials are not yet managed by the deployment UI; use images accessible to the worker's Docker daemon until registry credential support is added.

## Worker egress hardening

For customer build jobs, use Docker `bridge` networking only after installing the host firewall. On a dedicated Linux worker, copy the repository to `/opt/kestrel`, then run:

```sh
sudo install -m 0755 /opt/kestrel/deploy/harden-worker-egress.sh /opt/kestrel/deploy/harden-worker-egress.sh
sudo install -m 0644 /opt/kestrel/deploy/kestrel-worker-egress.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kestrel-worker-egress.service
```

The firewall places rules in Docker's `DOCKER-USER` chain to block container access to host-local addresses, private networks, loopback, link-local and cloud metadata ranges while allowing established replies and public internet egress. Verify the rules after every Docker/OS upgrade and persist them through the systemd unit. This is an additional network boundary, not a substitute for dedicated worker hosts and stronger sandboxing such as gVisor, Kata Containers or Firecracker.
