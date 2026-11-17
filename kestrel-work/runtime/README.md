# Kestrel job runtime

Build and publish the base image:

```bash
docker build -f runtime/images/Dockerfile.node22 -t ghcr.io/YOUR_ORG/kestrel-job-node22:1.0.0 .
docker push ghcr.io/YOUR_ORG/kestrel-job-node22:1.0.0
```

The worker runs each job in a fresh container with a non-root UID, dropped Linux capabilities, `no-new-privileges`, a read-only root filesystem, bounded memory/CPU/PIDs, a temporary `/tmp`, and only that job's workspace mounted. `KESTREL_JOB_NETWORK=none` is the secure default. Builds requiring package downloads need a controlled egress proxy/network policy; do not casually enable unrestricted network access for untrusted pull requests.

This is a hardened container baseline, not a microVM boundary. For hostile multi-tenant workloads, run workers on dedicated hosts and use Firecracker/Kata/gVisor, a per-job network policy, secret broker, image digest pinning, and ephemeral worker credentials. Never mount `/var/run/docker.sock` into a job container.
