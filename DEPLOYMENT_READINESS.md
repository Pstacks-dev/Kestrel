# Kestrel release readiness

This document records what the repository can do and what must be configured before production traffic is enabled.

## Implemented in the release branch

- React/Vite dashboard and Express control plane.
- Supabase Auth signup confirmation flow and access-token validation.
- Organization/workspace creation and membership checks.
- PostgreSQL-backed queue with atomic worker job claims, leases, retry and cancellation.
- HMAC-verified GitHub push and pull-request webhook receiver with delivery deduplication.
- Encrypted project secrets and log redaction.
- Worker enrollment issues a one-time credential; only a hash is stored.
- Docker worker agent supports isolated execution, bounded concurrency, job timeouts and graceful draining.
- Security hardening migration is tracked in `db/migrations/005_internal_access_and_artifact_bucket.sql`.

## Not complete / not certified

- Artifact registration exists, but the current worker only sends artifact metadata. The worker does not upload artifact bytes to Supabase Storage and the UI does not yet provide a complete authenticated download path.
- There is no complete Vercel/Netlify/Cloudflare deployment-provider adapter, deployment approval flow, or rollback implementation. Do not present the current pipeline as end-to-end continuous deployment.
- A worker agent is not a managed fleet. A Linux host, Docker Engine, network policy, monitoring, backup and a frequent lease-recovery scheduler must be provisioned separately.
- Signup and workspace creation have not been live-tested against a newly created account in production Vercel.
- Supabase leaked-password protection must be enabled in Authentication settings by a project owner.

## Required server configuration

Set in Vercel server-side environments only:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server only; never expose to Vite/client)
- `SUPABASE_DB_URL` (transaction pooler)
- `KESTREL_ENCRYPTION_KEY` (stable 32-byte key, backed up securely)
- `CRON_SECRET` (at least 32 random characters)
- `DB_POOL_MAX=1`
- `DB_SSL_REJECT_UNAUTHORIZED=true`

Worker host configuration:

- `KESTREL_API_URL=https://kestrel-ci-cd.vercel.app` or the chosen control-plane host
- `KESTREL_WORKER_ID`
- `KESTREL_WORKER_TOKEN` (one-time credential)
- `KESTREL_WORKER_EXECUTOR=docker`
- `KESTREL_JOB_IMAGE=node:22-bookworm-slim@sha256:<verified-digest>`
- `KESTREL_WORKER_WORKDIR`

Do not use `local` or `mock` executors in production.

## Release test plan

1. Create a new account, receive the Supabase confirmation email, verify the code, log in, and refresh the browser.
2. Confirm the account can create a workspace and cannot read another account's workspace.
3. Register a project and configure its GitHub webhook secret in GitHub.
4. Send a real signed push event; confirm exactly one pipeline run is queued even if GitHub retries the delivery.
5. Provision a worker, start it on a dedicated Linux Docker host, and confirm it registers and reports heartbeats.
6. Run a harmless test pipeline and verify logs, job completion, timeout, cancellation and retry.
7. Kill a worker during a job; verify stale-lease recovery and that another worker can safely claim the retry.
8. Complete an artifact-byte upload/download test before enabling artifact retention for customers.
9. Add and test each deployment provider separately, including approvals and rollback, before advertising CD as supported.
10. Restore a database backup in a separate project and verify the restore.

## Known Supabase security follow-up

Internal table grants are restricted and stale-lease recovery is service-role-only. The security advisor may still report RLS-enabled internal tables with no policies (intentional: no direct client access) and the two organization helper functions as SECURITY DEFINER (retained for RLS evaluation). Enable leaked-password protection in Supabase Authentication settings.
