# Run a Kestrel Docker worker

This Compose service runs the existing Kestrel worker agent as a separate worker
process. It connects outbound to the Kestrel control plane; the control plane
does not need to connect inbound to your PC.

## Requirements

- Docker Desktop with the Linux container engine running, or a Linux Docker host.
- A deployed Kestrel control-plane API reachable over HTTPS.
- The worker database migrations and worker protocol endpoints deployed.
- An administrator account with permission to provision workers.

## 1. Provision a worker credential

Sign in to Kestrel as a workspace owner, admin, or developer. From **Workspace / Overview**, use **Build workers → Provision build worker**, select the Node runtime (the pipeline/image-build worker), and generate the one-time credential. Copy the worker ID and token immediately; the token is shown only once. Never commit it or paste it into source control.

The authenticated workspace API is also available at `POST /api/workspaces/:orgId/workers` with `{ "name": "PStacks Docker Worker", "region": "local", "maxConcurrency": 1, "runtime": "node" }`.

## 2. Configure the worker

From the repository root, copy `.env.worker.example` to `.env.worker`.
Set `KESTREL_API_URL` to the public HTTPS base URL of the Kestrel API
(no trailing slash), then enter the worker ID and one-time token. Keep the
host-side worker workspace path consistent with the Compose bind mount.

The example uses the `bridge` job network so normal build commands can download
dependencies. Jobs still run in separate containers with resource limits and
reduced Linux capabilities. Use `KESTREL_JOB_NETWORK=none` for builds that
must not access the network.

The Compose file bind-mounts the same host directory into the worker agent and
passes its host-side path through `KESTREL_WORKER_HOST_WORKDIR`. This is
required because the Docker daemon runs on the host and cannot resolve a path
that exists only inside the worker-agent container.

For production, set `KESTREL_JOB_IMAGE` to an immutable image reference pinned
to a sha256 digest. Do not use a floating tag for production workers.

## 3. Start the worker

On Linux:

```sh
docker compose --env-file .env.worker -f docker-compose.worker.yml up -d --build
```

On Windows with Docker Desktop in Linux-container mode, run the same command in PowerShell from the repository root. Use forward slashes in the host path in `.env.worker`, for example `C:/kestrel-worker/work`.

Compose also reads `.env.worker` through the service's `env_file` setting.
The command above builds the worker image and starts the worker in the background.

View startup, registration, heartbeat, and job logs:

```sh
docker compose -f docker-compose.worker.yml logs -f kestrel-worker
```

Stop it:

```sh
docker compose -f docker-compose.worker.yml down
```

## 4. Verify in Kestrel

The worker should register and appear online in the Kestrel admin worker
overview. Queue a pipeline run for the same organization. The worker polls for
jobs, starts a separate Docker container for each job, streams logs, and reports
the result.

## Security notes

The worker container mounts the Docker daemon socket. Access to that socket is
effectively host-root access, so only run trusted worker software and protect
the host. Do not expose the Docker socket over TCP. Keep the one-time worker
token private and revoke it from the Kestrel admin API if it is compromised.

The worker needs outbound access to the Kestrel API. Build containers need
outbound network access only when their pipeline steps fetch dependencies or
other remote resources.
