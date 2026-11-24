# Kestrel — Distributed CI/CD Platform

Kestrel is a production-hardened, distributed CI/CD platform built with:
- **Frontend**: React 19, Vite, and TypeScript.
- **Control Plane**: Express.js REST API with rate limiting, security headers, and webhook receivers.
- **Persistence & Auth**: Supabase PostgreSQL with Row Level Security (RLS) and Supabase Auth.
- **Managed Cloud Builds**: Vercel Sandbox microVMs run detached, long-running builds without a customer-owned or Kestrel-owned worker host.
- **Container Workers**: Optional independent Docker workers for OCI image builds and host-based deployments; these still require a managed Linux compute provider.

---

## Architecture Overview

```
                                      +------------------------+
                                      |   GitHub / Git Host    |
                                      +------------------------+
                                        |               ^
                   Webhook (HMAC-SHA256)|               | Git Clone
                                        v               |
+---------------------+           +------------------------+           +--------------------------+
|  React 19 Frontend  |  <=====>  | Express Control Plane  |  <=====>  | Dedicated Docker Workers |
|   (Vite / Vercel)   |   JWT     |   (Vercel / Node.js)   |  Signed   |      (Linux VM Host)     |
+---------------------+           +------------------------+  Leases   +--------------------------+
                                              |
                                              | Pooled PostgreSQL & RLS
                                              v
                                  +------------------------+
                                  |   Supabase PostgreSQL  |
                                  +------------------------+
```

---

## Implemented Product Capabilities (Code-Level; Deployment Verification Required)

1. **Authentication & Session Security**:
   - Supabase Auth sign-up / sign-in with server-side JWT verification on every authenticated request.
   - Strict tenant isolation: organizations, projects, runs, jobs, and audit events verify membership and role (`owner`, `admin`, `developer`, `viewer`).
2. **Project Secrets Management**:
   - Secrets encrypted at rest using **AES-256-GCM** with authenticated encryption tags (`server/lib/security.mjs`).
   - Secrets decrypted only in memory when claimed by the assigned worker and passed directly into container environment.
   - Comprehensive **secret redaction**: bearer tokens, JWTs, private keys, URLs with basic auth, and project secret values are masked in logs and client outputs.
3. **GitHub Signed Webhook Integration**:
   - Receiver at `POST /api/webhooks/github` verifies GitHub `X-Hub-Signature-256` HMAC signatures using project-specific webhook secrets.
   - Handles `ping`, `push`, and `pull_request` events to automatically queue pipeline runs with commit SHA, branch, and author.
4. **Resilient Job Scheduling & DAG Validation**:
   - Transactional run queuing with dependency cycle detection (Kahn's / DFS algorithm) and resource limits.
   - Atomic job claiming with PostgreSQL `FOR UPDATE SKIP LOCKED`.
   - Timeout handling (`timeout_seconds`), bounded retry attempts (`max_retries`), and cancellation tracking.
5. **Worker Execution Protocol**:
   - Provisioned credentials stored as one-way SHA-256 hashes.
   - Heartbeat leases (45s duration) with automatic extension on log upload.
   - Atomic lease recovery function `recover_stale_leases()` cleans up orphaned jobs and flags offline workers.
   - Per-job Docker container execution: dropped Linux capabilities (`--cap-drop=ALL`), `--read-only` root filesystem, `no-new-privileges`, memory and CPU limits, scoped temporary filesystem, and non-root UID (`1000:1000`).
   - Support for `KESTREL_WORKER_EXECUTOR=docker|local|mock` for dry-run testing and diverse environments.
6. **Live Log Viewer & Real-time Feedback**:
   - Database-backed streaming log ingest and query endpoint (`GET /api/jobs/:jobId/logs`).
   - Interactive log viewer with stdout/stderr filtering, substring search, auto-scroll, copy-to-clipboard, and live polling.
7. **Native Project Files**:
   - Create projects from Git repositories or upload-only source projects.
   - Upload individual files or complete folders into a private Supabase Storage bucket through authenticated Kestrel API routes.
   - Workspace membership and developer roles are checked server-side; paths are normalized and traversal attempts rejected; per-file uploads are limited to 20 MiB.
   - Uploaded-source projects can be browsed and downloaded. Workers receive short-lived, organization-scoped source download URLs and stage files into the isolated job workspace, with limits of 500 files and 250 MiB per run.
8. **Build Artifacts**:
   - Automatic scanning of `dist/`, `build/`, and `artifacts/` directories on job completion.
   - Direct signed uploads to private Supabase Storage, SHA-256 metadata, authenticated downloads, deletion, and optional retention cleanup.
9. **Kestrel Compute (provider integrations; host validation pending)**:
   - Workspace-scoped VM inventory, create/start/stop/delete operations, durable operation leases and quota enforcement.
   - Provider pools for Incus, Firecracker and KubeVirt, selected by region and available CPU, memory, disk and instance capacity.
   - Trusted Rust compute host agent; provider credentials stay on the host and node tokens are stored as SHA-256 hashes.
   - The existing workspace interface includes a Compute page for VM creation, resource quota usage and lifecycle controls.
   - A real Linux/KVM provider node is required. No hosted node has been provisioned and live VM lifecycle has not yet been verified.
10. **Managed Cloud Builds (Vercel Sandbox)**:
   - Workspace developers can start a Node.js build from a public GitHub, GitLab, or Bitbucket repository inside a Vercel-managed microVM.
   - The control plane starts the build as a detached command and immediately returns a command ID; it does not hold a serverless request open for the duration of dependency installation or compilation.
   - Build status is polled through the Vercel Sandbox command API, and stdout/stderr can be retrieved through a bounded log endpoint.
   - Build commands support npm, pnpm and Yarn lockfiles and run `npm run build`.
   - No customer-managed Docker daemon, local worker process, or dedicated Kestrel server is needed for this build path. Vercel Sandbox credentials and provider usage/billing are required.
   - This is a managed build path, not yet a complete artifact publication or managed production-ingress path. Existing Docker-based deployment workers remain a separate option.
11. **Automated Migrations & Preflights**:
   - `scripts/migrate.mjs` applies ordered, transactional SQL migrations with idempotency tracking.
   - `scripts/check-env.mjs` verifies database URLs, SSL policies, and production security rules.

---

## 1. Quick Start / Local Development

### Prerequisites
- Node.js >= 20.x
- Docker Engine (for running containerized worker jobs)

### Step 1: Clone and Configure Environment
```bash
cp .env.example .env
```
Fill in your Supabase project settings (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`).

### Step 2: Install and Verify
```bash
npm install
npm run preflight
npm test
npm run migrate
```

### Step 3: Run the Control Plane and Frontend
In terminal 1 (Control Plane API):
```bash
npm run start:api
```

In terminal 2 (Vite Frontend):
```bash
npm run dev
```
Open `http://localhost:3000` in your browser.

---

## 2. Provisioning Workers

1. Create a user account via the web UI and promote the user to `platform_admin`:
```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
  || '{"platform_role":"platform_admin"}'::jsonb
where id = 'YOUR_USER_UUID';
```

2. Provision a worker token using the platform admin endpoint:
```bash
curl -X POST http://localhost:4000/api/admin/workers \
  -H "Authorization: Bearer YOUR_SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"organizationId":"YOUR_WORKSPACE_UUID","name":"worker-linux-01","region":"us-east","maxConcurrency":2}'
```
This returns a `workerId` and a one-time secret `token`.

3. On your dedicated worker host, configure `.env`:
```bash
KESTREL_API_URL=https://your-api-domain.com
KESTREL_WORKER_ID=wrk_...
KESTREL_WORKER_TOKEN=your-provisioned-token
KESTREL_WORKER_WORKDIR=/srv/kestrel-worker
KESTREL_JOB_IMAGE=node:22-bookworm-slim
```

4. Start the existing Node worker when using the legacy agent:
```bash
npm run start:worker
```

5. For the native Rust worker, first install the egress firewall from `deploy/harden-worker-egress.sh` as described in `runtime/rust/README.md`. Create `.env.worker` on the Linux host:
```bash
NODE_ENV=production
KESTREL_API_URL=https://your-api-domain.com
KESTREL_WORKER_ID=wrk_...
KESTREL_WORKER_TOKEN=your-provisioned-token
KESTREL_WORKER_WORKDIR=/var/lib/kestrel/work
KESTREL_WORKER_HOST_WORKDIR=/srv/kestrel-worker/work
KESTREL_CONCURRENCY=2
KESTREL_JOB_IMAGE=ghcr.io/your-org/kestrel-job-node22@sha256:YOUR_64_HEX_DIGEST
KESTREL_JOB_NETWORK=bridge
KESTREL_DOCKER_BIN=docker
```

Set `KESTREL_WORKER_HOST_WORKDIR=/srv/kestrel-worker/work` in the host shell or root Compose `.env` as well, because Compose uses it to resolve the bind mount. Then build and start the Rust worker:
```bash
docker compose -f docker-compose.worker-rust.yml up -d --build
docker compose -f docker-compose.worker-rust.yml logs -f
```

The worker registers itself with `runtime=rust`; deployment environments can then be assigned to it. The job image must be published and pinned to its real immutable digest before production startup.

---

## 3. Kestrel Compute provider hosts

Compute hosts are separate from the Vercel control plane and ordinary Docker
build workers. Apply migration 017, provision a provider node through the
platform-admin compute API, then run the trusted Rust compute agent on the
matching Linux/KVM host. Provider-specific environment variables and host
requirements are documented in runtime/compute/README.md. Do not place
provider credentials or API sockets in customer workloads.

The workspace Compute page queues VM operations and displays database-backed
status. A VM remains provisioning until a registered host agent claims the
operation and reports the provider result. No provider VM is created by the
Vercel serverless process itself.

## 4. Vercel + Supabase Deployment

Deploying the frontend and short-lived HTTP API to Vercel:

1. Import the repository in Vercel. Leave Root Directory as `.` (repository root).
2. Set Environment Variables in Vercel:
   - `VITE_SUPABASE_URL`: Supabase Project URL
   - `VITE_SUPABASE_ANON_KEY`: Supabase publishable/anon key
   - `SUPABASE_URL`: Supabase Project URL
   - `SUPABASE_ANON_KEY`: Supabase anon key
   - `SUPABASE_SERVICE_ROLE_KEY`: server-only Supabase service-role key for private project file storage (never expose as a VITE_ variable)
   - `SUPABASE_DB_URL`: Supabase transaction pooler URL (port 6543)
   - `DB_POOL_MAX`: `1`
   - `SUPABASE_DB_SSL_CA`: Supabase database CA certificate in PEM format (recommended; enables verified TLS)
   - `DB_SSL_REJECT_UNAUTHORIZED`: `false` only as a temporary compatibility fallback if the pooler's certificate chain cannot be verified; TLS encryption remains enabled
   - `KESTREL_ENCRYPTION_KEY`: 32-character secret key for AES-256-GCM
   - `CRON_SECRET`: Secret token for Vercel Cron
3. Vercel Cron calls `/api/cron/recovery` daily for stale lease recovery and `/api/cron/artifacts/cleanup` daily for expired uploads/artifacts. Set a strong `CRON_SECRET`; both endpoints reject requests if it is missing.
4. **Important**: Build workers must run on a separate, dedicated Linux host with Docker Engine, never inside Vercel Serverless Functions.

---

## 4. Environment Variables Reference

| Variable | Required In | Purpose |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Server | Supabase API URL |
| `SUPABASE_ANON_KEY` | Server | Supabase public/anon key (used for server-side user JWT validation) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Private project file storage; never expose to the browser |
| `SUPABASE_DB_URL` | Server | Supabase transaction-pooler PostgreSQL connection string |
| `SUPABASE_DB_SSL_CA` | Server (optional) | Supabase database CA certificate PEM; when set, certificate verification is enforced |
| `DB_SSL_REJECT_UNAUTHORIZED` | Server (optional) | Set to `false` only as a temporary TLS certificate-verification fallback; never disable TLS itself |
| `KESTREL_ENCRYPTION_KEY` | Server | AES-256-GCM key for encrypting project secrets at rest |
| `CRON_SECRET` | Server (Vercel) | Required secret protecting worker recovery and artifact cleanup cron routes |
| `KESTREL_ARTIFACT_RETENTION_DAYS` | Server (optional) | 1-3650 days; unset means artifacts do not expire automatically |
| `KESTREL_JOB_NETWORK` | Worker | `bridge` (requires the host egress firewall) or `none` |
| `KESTREL_DOCKER_BIN` | Worker | Docker CLI path used by the Rust worker |
| `KESTREL_GIT_ALLOWED_HOSTS`| Server | Comma-separated list of allowed Git hostnames (`github.com,gitlab.com`) |
| `VITE_SUPABASE_URL` | Web Frontend | Supabase Project URL |
| `VITE_SUPABASE_ANON_KEY`| Web Frontend | Supabase public key for frontend auth |
| `VITE_API_BASE_URL` | Web Frontend | API route prefix (`/api`) |
| `KESTREL_API_URL` | Worker | URL to control plane |
| `KESTREL_WORKER_ID` | Worker | Worker identifier assigned during provisioning |
| `KESTREL_WORKER_TOKEN` | Worker | Secret token for worker authentication |
| `KESTREL_WORKER_WORKDIR` | Worker | Path on worker machine where job workspaces are staged |
| `KESTREL_JOB_IMAGE` | Worker | Base container image (pin by `@sha256:...` digest in production) |
| `KESTREL_WORKER_EXECUTOR`| Worker | `docker` (production), `local` (host shell), or `mock` (unit testing) |

---

## 5. Testing & Verification

Run the test suite:
```bash
npm test
```
Run type-checking and production frontend build:
```bash
npm run check
```

---

## 6. Known Limitations & Production Notes

- **Worker provisioning**: No hosted Kestrel worker is included in this repository deployment. Customer jobs execute only when a dedicated Linux Docker worker has been provisioned, registered, and is online. Without one, jobs remain queued. The Rust runtime is additive; Node workers remain available for build jobs.
- **Worker recovery**: Migration 016 separates administrator intent from transient worker liveness. A worker marked offline after a missed heartbeat can return online after it reconnects; an administrator-disabled or draining worker remains in that state until explicitly resumed.
- **Artifact delivery**: Direct signed upload, finalization, authenticated download/delete, SHA-256 metadata and optional expiry are implemented in code. Run the ordered migrations with `npm run migrate`, configure the server-only Supabase service-role key and a strong `CRON_SECRET`, then verify Storage connectivity in the target Supabase project.
- **Source-to-image builds**: Deployment APIs currently accept an existing container image reference. Kestrel does not yet build arbitrary customer Dockerfiles into registry images. That step is intentionally gated on an isolated/rootless or remote builder; running untrusted Dockerfiles through the worker host Docker socket would undermine tenant isolation.
- **Deployments and rollback**: The first container-image deployment engine supports per-project environments, Rust-worker assignment, release history, health checks, retries and rollback to the prior healthy image. It publishes a host port and has a short interruption during switching; managed TLS ingress, zero-downtime blue/green switching and private-registry credential management are not yet included. Production releases require immutable image digests.
- **Usage controls**: Usage metering and quotas are not part of this implementation pass.
- **Kernel sharing**: Docker containers share the host Linux kernel. The worker egress firewall blocks host-local/private/link-local destinations, and jobs run with dropped capabilities, no-new-privileges, read-only roots and resource limits. Stronger isolation (gVisor, Kata or Firecracker) is still required before accepting hostile public multi-tenant workloads.
- **Network egress**: Job containers default to Docker bridge networking for package downloads. Install `deploy/harden-worker-egress.sh` on each dedicated worker host; use `KESTREL_JOB_NETWORK=none` for offline jobs.
- **Serverless API timeout**: The Vercel function maximum duration is configured to 15 seconds. Heavy workflows run on dedicated workers, not inside the serverless API request.


## 5. Managed Sandbox Compute (Vercel Sandbox)

Kestrel can provision isolated, managed Linux microVM sandboxes without a Kestrel-owned physical host. This is separate from the Incus, Firecracker and KubeVirt host-provider pool. Sandbox workspaces are backed by Vercel Sandbox and are not exposed as customer-managed VM hosts.

Set server-side environment variables before enabling sandbox provisioning: `VERCEL_TOKEN`, `VERCEL_TEAM_ID` (or `VERCEL_ORG_ID`), `VERCEL_PROJECT_ID`, and optionally `KESTREL_SANDBOX_REGION` / `KESTREL_SANDBOX_IMAGE`. Do not expose these credentials in `VITE_` variables or sandbox command environments. Vercel's project sandbox quotas and billing limits apply.

Apply migration 018 (`db/migrations/018_sandbox_compute.sql`) before using sandbox endpoints. The workspace API supports create/list, start/stop, command execution and deletion. Command calls are capped at eight seconds on the Vercel serverless API to fit its configured 15-second function timeout; longer-running terminal sessions are not yet supported. The default workspace quota is two concurrent sandboxes, four vCPUs total and up to 45 minutes per session. The platform pool defaults to a hard cap of ten active sandboxes to stay within the provider Hobby concurrency limit; configure `KESTREL_SANDBOX_GLOBAL_MAX` only if the Vercel plan has higher capacity. Each vCPU is provisioned with 2 GiB RAM. The provider retains its own billing, quota and runtime ceilings; Kestrel does not yet meter usage for billing customers.


## Managed hosting provider selection

Kestrel uses external hosting providers; it does not require Kestrel-owned hosting servers or a Kestrel-owned customer domain. The provider catalog and compatibility scorer are available through authenticated endpoints:

- `GET /api/hosting/providers` returns the ten supported provider profiles and whether their server-side credentials are configured.
- `POST /api/hosting/recommend` accepts a detected application profile (`runtime`, `kind`, `isStatic`, `dockerfile`, `needsPersistentProcess`, `needsBackgroundWorker`, `needsDatabase`) and ranks compatible providers.
- The scorer excludes providers that cannot satisfy hard requirements such as arbitrary containers, persistent processes, workers, or managed databases. It prefers a provider with credentials configured but never treats a missing credential as a successful deployment.

The initial catalog covers Render, Railway, Fly.io, Google Cloud Run, AWS ECS Express Mode, DigitalOcean App Platform, Heroku, Vercel, Netlify, and Cloudflare Pages.
AWS App Runner is not included in the new-customer provider pool: AWS closed it to new customers on 2026-04-30 and recommends ECS Express Mode. ECS Express Mode requires a published OCI image plus task-execution and infrastructure IAM role ARNs; Kestrel's image-publishing pipeline is a prerequisite before this provider can accept production deployments.
 Vercel's container runtime, Netlify Server, and Cloudflare Pages/Workers have distinct runtime constraints; they are not interchangeable with general-purpose container hosts.

Compatibility-aware provider selection and tenant-scoped encrypted credentials are implemented. Railway, Render and DigitalOcean App Platform now have managed create/deploy/status/rollback adapters. Render currently reports deployment-scoped logs as unavailable; DigitalOcean returns its provider log-stream URLs for the authenticated log proxy to retrieve. The other seven providers remain catalogued but are not yet enabled for deployment. No provider is marked production-live until real provider-account deployment smoke tests pass.


### Tenant hosting-provider credentials

Workspace owners, admins, and developers can manage provider credentials through the authenticated control plane:

- `GET /api/workspaces/:orgId/hosting/providers` lists provider connection state without returning credentials.
- `PUT /api/workspaces/:orgId/hosting/providers/:providerId` stores validated credentials encrypted with AES-256-GCM.
- `DELETE /api/workspaces/:orgId/hosting/providers/:providerId` removes a workspace's provider connection.
- `POST /api/workspaces/:orgId/hosting/providers/:providerId/verify` validates stored credentials against the provider API for Render, Railway, Fly.io, Google Cloud Run, AWS ECS API (for ECS Express Mode credentials), DigitalOcean, and Heroku, and Vercel. Successful authentication marks the connection `verified`; it does not mean an application has been deployed.


Set a strong `KESTREL_ENCRYPTION_KEY` (at least 32 characters) before enabling these endpoints. Credentials are tenant-scoped, never returned by the API, and the table is inaccessible to browser roles. A newly saved connection is marked `configured`, not `verified`; successful API authentication and deployment smoke tests are still required before Kestrel can use it for production deployments. Apply migration `023_managed_hosting_providers.sql` before enabling the endpoints.


## Provider-managed application deployments

The first three provider-backed deployment adapters are Railway, Render and DigitalOcean App Platform. Apply migration 024 before enabling them. Kestrel detects the imported GitHub project's runtime and deployment requirements, then automatically selects the highest-ranked compatible active adapter for which the workspace has verified credentials.

- `POST /api/projects/:projectId/managed-deployments` creates a provider project/service on the first deploy and deploys later commits to that resource.
- `GET /api/projects/:projectId/managed-deployments` lists deployment history.
- `GET /api/managed-deployments/:deploymentId` refreshes provider status and the provider-generated application URL.
- `GET /api/managed-deployments/:deploymentId/logs` retrieves build and runtime logs.
- `POST /api/managed-deployments/:deploymentId/rollback` requests a provider rollback.

Provider-specific setup: Railway must have GitHub repository access; Render requires an API key and workspace owner ID; DigitalOcean requires a Personal Access Token (optionally set its App Platform region, default `nyc`). Kestrel stores provider resource identifiers and deployment history; the selected provider hosts the application and supplies its URL. Render deploy requests pin the resolved commit SHA. DigitalOcean App Platform's deployment API triggers a build from the configured branch rather than accepting a commit SHA. Kestrel checks the source commit hash returned by the deployment API when present and rejects a mismatch, but the provider does not offer a request-time immutable commit pin. Render's current adapter does not yet expose deployment-scoped log retrieval. DigitalOcean log endpoints return provider log-stream URLs; streaming/proxy retrieval is a follow-up. These adapters have mock-tested API contracts only and require live account smoke tests before production use. Fly.io, Cloud Run, ECS Express Mode, Heroku, Netlify and Cloudflare Pages are documented in the provider-specific sections below; OCI-image and billing-gated providers remain unavailable for automatic selection until their prerequisites are met.


### Fly.io Machine adapter

Kestrel includes a Fly.io Machines API adapter for OCI-image deployments. It creates or reuses an app in the connected organization, provisions a Machine from an immutable image reference, allocates a shared IPv4 address for public routing, tracks Machine lifecycle events, replaces prior running Machines after a new Machine starts, and rolls back by restarting a retained prior Machine. The adapter requires a published OCI image and an explicit application port. Fly's Machines API does not expose application stdout/stderr through the Machine resource; configure a Fly log drain for runtime logs. The adapter is not included in automatic selection until Kestrel's managed OCI build-and-publish pipeline is available, so a Git repository alone is not yet sufficient to deploy through Fly.io.


### Google Cloud Run managed deployment adapter

Kestrel supports Cloud Run v2 services from published OCI images. The adapter authenticates using a tenant service account, creates and updates services, tracks long-running operations and ready revisions, retrieves runtime entries through Cloud Logging, and rolls traffic back to a previously recorded revision. The service account needs Cloud Run service administration, registry image-read access, and Cloud Logging read permissions. The adapter is not automatically selected until Kestrel's OCI image build-and-publish pipeline is connected.


## Managed provider deployment coverage

Kestrel now has provider-specific deployment lifecycles for all ten catalogued hosts:

- **Source/Git adapters:** Railway, Render, DigitalOcean App Platform, Vercel, and Heroku.
- **OCI-image adapters:** Fly.io Machines, Google Cloud Run, and AWS ECS Express Mode.
- **Static adapters:** Netlify direct artifact uploads and Cloudflare Pages Git-connected builds.

The automatically selectable set currently includes Railway, Render, DigitalOcean App Platform, Vercel, Netlify and Cloudflare Pages. Netlify requires artifact IDs from a successful Kestrel build; Cloudflare Pages requires the repository to have already been authorized in the Cloudflare Pages GitHub integration. Heroku remains gated until an explicit paid-dyno approval control is in place. Fly.io, Cloud Run and ECS Express Mode remain gated until Kestrel's isolated OCI build-and-registry publishing pipeline is connected; they reject deployments without a published image rather than accepting source-only requests.

Netlify static uploads download artifacts from the private Kestrel artifact bucket and verify project ownership, expiry, byte size and SHA-256 before upload. Cloudflare Pages triggers a provider-side build pinned to the resolved Git commit and disables duplicate provider-native push deployments. Provider-generated URLs are returned to Kestrel; Kestrel does not host customer applications or require a Kestrel-owned domain.

These adapters have automated mocked API tests. No live account deployment has yet been smoke-tested for the new Netlify, Cloudflare Pages, Fly.io, Cloud Run or ECS Express integrations. A verified credential means API authentication succeeded, not that a production deployment has succeeded.


### AWS ECS Express Mode deployment adapter

Kestrel includes an ECS Express Mode adapter for immutable OCI image deployments. It creates and updates Express Gateway services using tenant AWS credentials, supports temporary session tokens, tracks service revisions and ingress endpoints, retrieves CloudWatch log events, and rolls back by restoring the task definition from a retained service revision. The connected IAM identity needs permissions for ECS Express Gateway service operations, IAM PassRole for the configured execution and infrastructure roles, ECR image pulls, and CloudWatch Logs. The adapter is not automatically selectable until Kestrel's OCI image build-and-publish pipeline is connected.

### Netlify static artifact deployments

Netlify deployments consume successful Kestrel build artifacts rather than running a second provider-side build. Kestrel verifies artifact ownership, expiration, byte count and SHA-256 against the private artifact store, then submits a digest manifest and uploads only the files Netlify requests. Deployments are capped at 50 MiB and 5,000 files. Static deployment logs are not available from Netlify when no Netlify build is run; rollback restores a prior deployment.

### Cloudflare Pages Git deployments

Cloudflare Pages creates or reuses a GitHub-connected Pages project, disables duplicate provider-native push deployments, and triggers deployments against the immutable commit SHA resolved by Kestrel. It tracks deployment stages and URLs, retrieves provider build logs, and supports rollback through the Pages deployment API. The GitHub repository must already be authorized in the connected Cloudflare account. Cloudflare Pages is intended for static output and framework-supported Pages builds.


### Automatic managed redeploys after successful CI

For an active GitHub push webhook, Kestrel queues a managed deployment only after every pipeline job succeeds and only when the push targets the project's configured default branch. Pull-request runs and feature-branch pushes remain CI-only. The deployment uses the exact commit SHA from the completed run, the first compatible provider with verified workspace credentials, and the project's encrypted environment variables where that provider adapter supports them.

Queue state is stored in `managed_hosting_deployment_queue` (migration 026). Provider creation failures are recorded and retried with bounded exponential backoff. Configure `CRON_SECRET` and schedule an authenticated POST to `/api/cron/managed-hosting-deployments/process` to recover queued/failed work and stale processor locks. A skipped queue entry means no compatible verified provider was connected at the time the successful run completed; use the Deployments workspace to connect a provider and start a deployment manually.

Netlify auto-deploy is selected only for static builds with completed artifacts and no project environment secrets (the current Netlify adapter does not yet sync those secrets). Container-image providers remain unavailable for automatic selection until the OCI image build and registry publishing pipeline is completed.