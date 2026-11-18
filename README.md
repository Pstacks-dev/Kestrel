# Kestrel — Distributed CI/CD Platform

Kestrel is a production-hardened, distributed CI/CD platform built with:
- **Frontend**: React 19, Vite, and TypeScript.
- **Control Plane**: Express.js REST API with rate limiting, security headers, and webhook receivers.
- **Persistence & Auth**: Supabase PostgreSQL with Row Level Security (RLS) and Supabase Auth.
- **Build Workers**: Independent, sandboxed Docker workers with non-root UID, dropped Linux capabilities, and resource limits.
- **Deployments**: Vercel-ready serverless API / static frontend, with separate Linux hosts for always-on Docker execution.

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
8. **Automated Migrations & Preflights**:
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

4. Start the worker agent:
```bash
npm run start:worker
```

---

## 3. Vercel + Supabase Deployment

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

- **Worker provisioning**: No hosted Kestrel worker is included in this repository deployment. Customer jobs execute only when a dedicated Linux Docker worker has been provisioned, registered, and is online. Without one, jobs remain queued. The Rust runtime is additive; Node workers remain available for build jobs.\n- **Artifact delivery**: Direct signed upload, finalization, authenticated download/delete, SHA-256 metadata, and optional expiry are implemented in code. Apply migrations 008, 012 and configure the server-only Supabase service-role key before use; verify against the live Storage project.\n- **Deployments and rollback**: A first container-image deployment engine is implemented: per-project environments, Rust-worker assignment, release history, health checks, retries, and rollback to the prior healthy image. It uses a published host port and has a short interruption during switching; it does not yet provide managed TLS ingress, zero-downtime blue/green switching, or private-registry credential management. Production releases require immutable image digests.\n- **Usage controls**: Usage metering and quotas are not part of this implementation pass.\n- **Kernel Sharing**: Docker containers share the host Linux kernel. The worker egress firewall blocks host-local/private/link-local destinations, and jobs run with dropped capabilities, no-new-privileges, read-only roots and resource limits. Stronger isolation (gVisor, Kata or Firecracker) is still required before accepting hostile public multi-tenant workloads.\n- **Network Egress**: Job containers default to Docker bridge networking for package downloads. Install `deploy/harden-worker-egress.sh` on each dedicated worker host; use `KESTREL_JOB_NETWORK=none` for offline jobs.
- **Network Egress**: Jobs default to `--network none` for security. Workloads requiring dependency downloads should configure a controlled egress proxy.
- **Serverless API Timeout**: On Vercel Hobby plans, function maximum duration is 15 seconds. Heavy control plane workflows should be sized accordingly.
