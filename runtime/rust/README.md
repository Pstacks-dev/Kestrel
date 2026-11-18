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
