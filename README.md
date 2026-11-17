# Kestrel — Distributed CI/CD

Kestrel is a CI/CD control plane with a React/Vite dashboard, an Express API, PostgreSQL-backed job queue, and independently hosted Docker workers.

## Current architecture

- **Web app:** React 19 + Vite, deployed as static assets.
- **Control plane:** Express API routed through Vercel functions or a standalone Node process.
- **Database:** Supabase PostgreSQL.
- **Execution:** Linux worker agents poll for jobs and run them in Docker containers.
- **Queue:** PostgreSQL transactions and `FOR UPDATE SKIP LOCKED` coordinate claims.
- **Security:** HMAC-signed GitHub webhooks, one-way worker-token hashes, AES-GCM encrypted project secrets, per-job container limits.

## Current capabilities

The repository currently includes account and organization flows, project management, manually configured GitHub webhooks, a default npm build/test pipeline, a PostgreSQL job queue, worker registration/heartbeat/claim/complete APIs, log ingestion and retrieval, retry/cancel endpoints, basic artifact metadata registration, worker provisioning, and stale-lease recovery.

The webhook receiver queues a built-in npm pipeline. It does **not** yet load a user-defined YAML workflow file. Artifact metadata registration is present, but end-to-end object upload/download is not yet complete. Deployment-provider integrations and rollback are not yet complete. Do not treat those as finished product capabilities.

## Local development

Requirements: Node.js 22+, PostgreSQL/Supabase, and Docker Engine for real worker execution.

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

Start a worker on a separate Linux Docker host after provisioning its unique worker ID and token:

```bash
npm run start:worker
```

Never run untrusted build jobs using the local executor in production.

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
7. Artifact bytes can be uploaded, checksum-verified, authorized and downloaded.
8. Failed jobs recover after worker termination; concurrent workers do not claim the same job.
9. Secrets never appear in logs, process output, client responses or unrelated tenants.
10. Deployment approvals, provider integrations and rollback are implemented and tested before offering CD as a complete feature.

See [DEPLOYMENT_READINESS.md](./DEPLOYMENT_READINESS.md) for release configuration and Google Search Console instructions.
