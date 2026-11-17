# Kestrel — distributed CI/CD platform (Supabase edition)

Kestrel is structured as a React/Vite web application, an Express control plane, a PostgreSQL-backed scheduler and independently deployed Docker workers. Supabase provides managed PostgreSQL and Auth; build execution happens on worker machines, never in Supabase Edge Functions.

## Current implementation status

This is a substantial engineering foundation and a controlled-test deployment candidate. It is **not certified production-ready**. Do not run arbitrary public pull requests or expose worker hosts to untrusted tenants until the remaining security and integration work listed below is completed.

Implemented in this revision:

- Supabase Auth sign-up/sign-in from the frontend; access tokens are verified server-side with Supabase Auth.
- Workspace creation and membership records.
- PostgreSQL schema/migrations for organizations, members, projects, pipelines, runs, jobs, logs, workers, worker credentials, artifacts and audit events.
- Organization membership checks on project and snapshot APIs; owner/admin/developer checks for project creation and pipeline runs.
- PostgreSQL transactional run creation and dependency-graph cycle checks.
- Atomic job claiming using PostgreSQL `FOR UPDATE SKIP LOCKED` so multiple API replicas cannot claim the same queued job. The first six Node test cases cover dependency graph validation and resource caps.
- Per-worker credentials stored as SHA-256 hashes; worker credentials are issued once by a platform administrator.
- Lease tokens, heartbeat extension, lease expiry recovery and bounded retry attempts.
- Per-job Docker execution with non-root UID, dropped Linux capabilities, read-only root filesystem, `no-new-privileges`, CPU/memory/PID limits, temporary filesystem, project-scoped npm cache volume and automatic workspace cleanup.
- Restricted `/admin` route with server-side platform-role enforcement. It is not linked from public navigation. An unknown URL is not the security boundary; the API authorization check is.
- Container definitions for web, API and dedicated workers.

Not yet implemented / required before public production:

- Signed GitHub App webhooks and OAuth installation; repository checkout currently supports public HTTPS Git URLs only.
- A secret broker and encrypted, short-lived per-job secrets. Do not put deployment secrets in job commands.
- Supabase Storage signed artifact uploads/downloads, checksum verification and retention lifecycle.
- Deployment environments, approvals, rollback orchestration and deployment health checks.
- A dedicated egress proxy/network policy. Jobs default to `--network none`; builds needing package downloads require a controlled network path.
- Firecracker/Kata/gVisor microVM isolation for hostile multi-tenant workloads. Docker containers share the host kernel and are not a sufficient boundary for arbitrary hostile code.
- Admin UI for user/org management, worker issuance/revocation, billing, system settings and audit search. The current private admin UI is a basic operations overview.
- End-to-end, load, chaos, backup/restore and independent security testing.

## 1. Create Supabase project

1. Create a Supabase project.
2. Copy the Project URL, anon/publishable key and PostgreSQL connection string from Project Settings.
3. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env`.
4. Keep the database password and any service-role key on the server only. Never prefix secrets with `VITE_`.
5. Apply migrations:

```bash
npm install
npm run preflight
npm test
npm run migrate
```

Use the Supabase direct connection for migrations when available, or its session pooler for long-running API connections. For serverless deployments use the transaction pooler only with a compatible pool configuration.

## 2. Provision the first platform administrator

Create a normal user through `/signup`, confirm the email if confirmation is enabled, then locate that user's UUID in Supabase Authentication → Users. In the Supabase SQL editor, run:

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
  || '{"platform_role":"platform_admin"}'::jsonb
where id = 'YOUR_AUTH_USER_UUID';
```

Sign out and sign back in so the refreshed JWT includes the platform role. The `/admin` page is not linked from the public site, and `/api/admin/*` checks `app_metadata.platform_role` on every request. Non-admin requests receive a not-found/denied response.

## 3. Local development

```bash
cp .env.example .env
# Fill in Supabase settings and a unique worker token.
npm install
npm run preflight
npm test
npm run migrate
npm run start:api
```

In another terminal:

```bash
npm run dev
```

Open `http://localhost:3000`, create an account and sign in. Kestrel creates a personal workspace on first access. Set `VITE_API_BASE_URL=/api` (default) so Vite proxies API requests to port 4000.

## 4. Provision a worker

Sign in as the platform administrator, then call the private provisioning endpoint using the current Supabase access token:

```bash
curl -X POST http://localhost:4000/api/admin/workers \
  -H "Authorization: Bearer YOUR_SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"organizationId":"YOUR_WORKSPACE_UUID","name":"builder-01","region":"eu-west","maxConcurrency":2}'
```

The private admin console also has a worker provisioning form. The response contains a worker ID and a one-time token. Store the token in the worker's secret environment; it is stored hashed in PostgreSQL and cannot be retrieved again. Set `KESTREL_WORKER_ID` to the returned ID and `KESTREL_WORKER_TOKEN` to the returned token on that worker host.

Build and publish the job image:

```bash
docker build -f runtime/images/Dockerfile.node22 -t ghcr.io/YOUR_ORG/kestrel-job-node22:1.0.0 .
docker push ghcr.io/YOUR_ORG/kestrel-job-node22:1.0.0
```

Configure `KESTREL_JOB_IMAGE` to the image reference. For production, pin the image by immutable digest, not a mutable tag (the production worker refuses mutable image tags). The worker pre-pulls the image before accepting jobs.

## 5. Worker runtime and security

The worker agent uses the Docker CLI and Docker Engine socket on its host to start one disposable container per job. It does not pass the Docker socket into job containers. The worker host itself is highly privileged: access to its Docker socket is effectively host-root access. Run workers on dedicated machines/VMs, do not co-locate them with sensitive workloads, and never expose the Docker socket over TCP.

The default job network is `none`, which prevents builds from fetching dependencies. To support dependency downloads, configure a controlled egress proxy and explicit allowlist; do not enable unrestricted internet access for untrusted code. The npm cache is separated by project, but cross-branch cache poisoning still needs a stronger trust policy before accepting untrusted PRs.

The container runtime is optimized for startup by pre-pulling the base image and retaining a per-project npm cache volume. Add worker nodes horizontally to add execution capacity. Each worker's concurrency should be set according to CPU/RAM available on its host.

## 6. Deployment

The compose file is a single-host reference deployment. It uses Supabase as the managed database/auth provider; it does not run a local Postgres or Redis instance. Set all required environment values and create the worker host directory before starting the worker:

```bash
mkdir -p /srv/kestrel-worker
sudo chown 1000:1000 /srv/kestrel-worker
```

Start API and web:

```bash
docker compose up -d --build api web
# Apply the database migrations using the API container's server-side DB credentials
docker compose exec api npm run migrate
```

Start a provisioned worker after setting its one-time credentials in `.env`:

```bash
docker compose --profile workers up -d --build worker
```

Place a TLS reverse proxy/load balancer in front of port 8080. Do not expose port 4000 or the Docker socket publicly. For multiple workers, deploy the worker agent on separate dedicated hosts with their own worker credentials and shared API URL. Do not scale the compose worker service with one shared token/worker ID.

## 7. Environment variables

See `.env.example`. The frontend receives only Supabase URL, anon key and API base URL. Supabase anon keys are designed to be public; database passwords, worker tokens and any service-role credentials must remain server-side.


## Vercel + Supabase deployment (frontend and HTTP API)

Kestrel supports deploying its Vite frontend and short-lived Express HTTP API to Vercel. The API is exposed through `api/[...path].mjs`; the Express app does not open a listening socket or start background timers in Vercel serverless mode.

### Connect your Supabase project

1. Create/open your Supabase project and copy its Project URL and publishable (or legacy anon) key from Project Settings → API.
2. In Vercel, import this Git repository and set the Root Directory to the folder containing `package.json` and `vercel.json`.
3. Add these Vercel Environment Variables for Production (and Preview only if you intend to use Preview deployments):
   - `VITE_SUPABASE_URL` = Supabase Project URL
   - `VITE_SUPABASE_ANON_KEY` = Supabase publishable/anon key
   - `SUPABASE_URL` = same Project URL
   - `SUPABASE_ANON_KEY` = same publishable/anon key (used by server to validate user JWTs)
   - `SUPABASE_DB_URL` = Supabase Postgres connection string, preferably the Supabase pooler transaction-mode URL for serverless functions. Keep this server-only; never prefix it with `VITE_`.
   - `DB_POOL_MAX` = `2`
   - `DB_SSL_REJECT_UNAUTHORIZED` = `true`
   - `KESTREL_GIT_ALLOWED_HOSTS` = `github.com,gitlab.com,bitbucket.org`
4. In Supabase SQL Editor, run `db/migrations/001_kestrel.sql` once. For future migrations run `npm run migrate` from a trusted local/CI environment with the server-side database URL.
5. Deploy. Test `https://YOUR-APP.vercel.app/api/health`; it should return `ok: true` and `database: connected`.
6. In Supabase Authentication → URL Configuration, set Site URL to your Vercel domain and add your Vercel production and preview callback URLs to Redirect URLs.
7. Register your first user, then promote that user's UUID to `platform_admin` using the SQL statement in the admin section above.

Do not add a Supabase `service_role` key to Vercel's `VITE_` variables or expose it in browser code. The browser uses only the publishable/anon key; access is enforced by Supabase Auth and server-side authorization.

### Important: Vercel is not the build-worker host

Vercel Hobby/serverless functions are request-driven and short-lived. They cannot run Kestrel's persistent worker polling loop, Docker daemon, long-running builds, or a durable scheduler/reaper process. Deploy the web app and HTTP API on Vercel, but run `worker/agent.mjs` on a separate always-on Linux machine/VM with Docker installed. Configure that machine with:

- `KESTREL_API_URL=https://YOUR-APP.vercel.app`
- `KESTREL_WORKER_ID` and `KESTREL_WORKER_TOKEN` from the private admin console
- `KESTREL_WORKER_WORKDIR=/srv/kestrel-worker`
- `KESTREL_JOB_IMAGE` pinned to an immutable image digest

The current worker requires a Docker host and persistent disk. Never deploy it as a Vercel Function. Use a separate VM/container host for it. The API's periodic lease-recovery timer runs only in standalone mode, not in Vercel; production needs a scheduled recovery mechanism or database-side recovery function before relying on automatic retry after worker loss.

### Vercel deployment limitations

This is a Vercel-compatible deployment adapter, not a claim that the whole distributed execution platform runs on Vercel Free. Serverless API duration, concurrent database connections, bandwidth and build limits still apply. The current pipeline API is synchronous and should be load-tested within your plan's function limits. Do not enable public multi-tenant build execution until the remaining controls listed in the production checklist are implemented and independently tested.
