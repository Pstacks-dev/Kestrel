# Production monitoring and incident response

Kestrel exposes separate liveness and readiness checks and a detailed
platform-admin health view. GitHub Actions runs a synthetic production check
every ten minutes and can also run it manually.

## Configure monitoring

Add the following GitHub Actions secret:

- `KESTREL_PRODUCTION_URL`: the production HTTPS origin, for example
  `https://kestrel.example.com`. Do not include credentials, query strings or
  a path.

Configure `KESTREL_MIN_READY_WORKERS` in the control-plane environment. The
default is `1`. Readiness requires at least this many workers with an
`online` or `busy` state, `desired_state=online`, and a heartbeat within
45 seconds.

The `.github/workflows/production-smoke.yml` workflow checks:

- `GET /api/health`: process and database liveness
- `GET /api/ready`: required database schema, artifact-storage configuration,
  and healthy worker capacity

A non-200 response, invalid JSON, unhealthy check or timeout fails the workflow.
Configure GitHub repository notifications for workflow failures so missed or
failed checks reach the operators. The workflow does not deploy or modify any
hosting provider configuration.

## Health endpoints

| Endpoint | Access | Meaning |
| --- | --- | --- |
| `GET /api/health` | Public | Liveness: the control plane can query PostgreSQL |
| `GET /api/ready` | Public | Readiness: required schema, artifact storage and worker capacity are available |
| `GET /api/admin/health` | Authenticated platform administrator | Detailed database, worker, queue, managed-hosting automation, image-build and provider deployment counts |

The public readiness response contains status and counts only. It never returns
database URLs, tokens, provider credentials or tenant records.

## Incident response

### Liveness or database check fails

1. Check the control-plane deployment logs and Supabase database availability.
2. Confirm `SUPABASE_DB_URL`, SSL settings and connection-pool limits.
3. Check whether the latest database migrations completed. Do not manually mark
   a migration as applied without verifying the resulting schema.
4. If the database is unavailable, stop retrying destructive deployment actions
   until connectivity is restored.

### Readiness reports an incomplete schema

1. Compare the expected tables with the migration files in `db/migrations`.
2. Apply the missing migrations through the controlled migration procedure.
3. Re-run `GET /api/ready` and the production smoke workflow.

### Readiness reports degraded worker capacity

1. Open `GET /api/admin/health` as a platform administrator and inspect online,
   stale, draining and offline workers, plus queued/running jobs.
2. Inspect worker container logs and verify the provisioned worker ID, token,
   HTTPS control-plane URL and immutable worker image digest.
3. Check the worker heartbeat timestamp and desired state. Restart workers with
   SIGTERM so active jobs can drain; avoid killing containers abruptly.
4. If a job is stuck, use the supported retry/recovery controls after checking
   its lease and logs. Do not manually mark an unfinished job successful.

### Managed deployment or image-build failures

1. Inspect the per-provider deployment and image-build counts in
   `/api/admin/health`.
2. Open the deployment/job logs and identify the failed build, provider API
   request or health probe.
3. Verify the provider connection and required scopes without printing tokens.
4. Use Kestrel's bounded retry controls. Confirm the immutable image digest
   before retrying a deployment.
5. Escalate persistent provider failures with the provider request ID and
   sanitized logs.

### Database recovery

Use the encrypted backup and recovery procedure in
[Database backup and recovery](./database-backup-recovery.md). Verify the
archive and perform a restore drill in a separate staging Supabase project
before any production recovery. Never run the destructive staging restore
against the production database.

## Logging and secret handling

- Worker output and job logs are redacted before being persisted.
- Use the authenticated platform-admin health endpoint for aggregate queue and
  provider status; do not expose raw logs or provider credentials publicly.
- Store database URLs, worker tokens, GitHub App keys and provider credentials
  only in server-side deployment secrets.
- Rotate compromised credentials, revoke the old provider token, and verify
  the replacement connection before resuming deployments.
- Preserve sanitized incident timelines, failed run IDs, provider request IDs
  and recovery actions for post-incident review.
