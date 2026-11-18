# Kestrel — Distributed CI/CD

Kestrel is a CI/CD control plane with a React/Vite dashboard, an Express API, PostgreSQL-backed job queue, and independently hosted Docker workers.

## Current architecture

- **Web app:** React 19 + Vite, deployed as static assets.
- **Control plane:** Express API routed through Vercel functions or a standalone Node process.
- **Database:** Supabase PostgreSQL.
- **Execution:** Linux worker agents poll for jobs and run them in Docker containers.
- **Queue:** PostgreSQL transactions and `FOR UPDATE SKIP LOCKED` coordinate claims.
- **Security:** Supabase Auth email confirmation, password handling and JWT sessions, HMAC-signed GitHub webhooks, one-way worker-token hashes, AES-GCM encrypted project secrets, per-job container limits.

## Current capabilities

The repository includes account and organization flows, project management, signed GitHub webhooks, a PostgreSQL job queue, Docker worker registration and execution, log ingestion, retries/cancellation, and stale-lease recovery. Worker artifacts are uploaded as bytes to a private Supabase Storage bucket, checked against SHA-256, and downloaded through short-lived signed URLs after workspace membership checks. Deployment targets support Vercel and Netlify credentials encrypted at rest, deployment history, optional owner/admin approval, status refresh, and rollback to a previous successful release.

The webhook receiver currently queues the built-in npm install/test/build pipeline. It does **not** yet load a user-defined YAML workflow file. Vercel deployments are created from the exact GitHub commit associated with a successful run. Netlify deployments publish the verified build files from the successful run through its deploy API, and rollback uses Netlify's restore-deploy API. Provider credentials and project/site IDs must be supplied by the workspace owner.

## Local development

Requirements: Node.js 22+, Supabase PostgreSQL, SMTP credentials for email verification, and Docker Engine for real worker execution.

```bash
npm ci
cp .env.example .env
npm run preflight
npm run migrate
npm test
npm run check
```

Start the API and frontend in separate terminals:

```bash
npm run start:api
npm run dev
```

Start a worker on a separate Linux Docker host after provisioning its unique worker ID and token. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` on the worker as well; they are used with short-lived signed upload tokens, never with a service-role key:

```bash
npm run start:worker
```

Never run untrusted build jobs using the local executor in production.

## Artifact storage and deployments

The private `kestrel-artifacts` Supabase Storage bucket is created by migration `005_internal_access_and_artifact_bucket.sql`. Worker agents register artifact metadata, request a lease-bound signed upload token, and transfer bytes directly to the private bucket (avoiding serverless request-body limits). The control plane downloads the stored object and independently verifies its registered size and SHA-256 before marking it available. Downloads are authorized against workspace membership and use 60-second signed URLs. The default worker collector scans `dist/`, `build/`, and `artifacts/`, with per-file and per-job limits.

Open **Deployments** in the workspace to connect a provider. Vercel requires a Vercel project ID, a scoped API token, and optionally a team ID. Netlify requires a site ID and a scoped API token. Provider tokens are encrypted using `KESTREL_ENCRYPTION_KEY`; they are never returned to the browser. A deployment can only be requested from a successful run with a full commit SHA. Enable approval to require an owner/admin decision before the provider is called. Vercel preview targets use Vercel's default preview environment; Netlify preview targets create draft deploys. Vercel rollback creates a new deployment from the previous successful commit; Netlify production rollback restores the previous successful deploy. Netlify preview drafts are not restorable as production releases. Artifact uploads are limited to 100 MiB per file; Netlify releases are limited to 100 files and 300 MiB total.

## Database migrations

Migrations are stored in `db/migrations` and applied in lexical order by `npm run migrate`. The runner records applied filenames in `public.kestrel_schema_migrations`. Run migrations once from a trusted environment with a production database connection before switching production traffic.

## Vercel and Supabase

Vercel can host the static frontend and short-lived API functions. Use the Supabase transaction pooler and keep the database connection string server-side. Required server variables include:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_DB_URL`
- `KESTREL_ENCRYPTION_KEY`
- `CRON_SECRET`
- `DB_POOL_MAX=1`
- `DB_SSL_REJECT_UNAUTHORIZED=true`

Use separate high-entropy values for the encryption and cron secrets. Keep the encryption key stable and backed up: rotating it without re-encrypting stored project secrets makes those secrets unreadable.

### Important Vercel Hobby limitation

Vercel Hobby only supports daily Cron Jobs. The configured daily recovery endpoint is a fallback check, not suitable for timely recovery of 45-second worker leases. For dependable queue recovery, run the standalone control plane (which includes a five-second recovery loop) or provide an external scheduler that calls `GET /api/cron/recovery` frequently. Dedicated Docker workers must run on a separate Linux host; Vercel functions cannot host them.

## Production readiness gates

Do not call this service production-ready until all of the following are proven in the target environment:

1. CI tests, TypeScript checks and production build pass.
2. Migrations apply successfully and a backup restore has been tested.
3. Signup, login, password handling and tenant isolation pass security tests.
4. A real GitHub webhook is signature-verified and deduplicated.
5. A provisioned worker pulls a real commit and runs the queued job in Docker.
6. Logs are streamed and retained correctly, including after worker restarts.
7. Artifact bytes upload to the private bucket, SHA-256 verification succeeds, and authorized users can download the original bytes.
8. Failed jobs recover after worker termination; concurrent workers do not claim the same job.
9. Secrets never appear in logs, process output, client responses or unrelated tenants.
10. Vercel and Netlify deployments are tested against real provider projects, approvals block unapproved releases, and rollback restores the intended previous release.

See [DEPLOYMENT_READINESS.md](./DEPLOYMENT_READINESS.md) for release configuration and Google Search Console instructions.


## Email verification

New accounts use Supabase Auth signup with email confirmation. Configure SMTP in the Supabase project's Authentication settings and use the signup verification-code form in the web app. The API validates Supabase access tokens; keep the Supabase service-role key and database URL server-side only. Do not disable email confirmation in production.
