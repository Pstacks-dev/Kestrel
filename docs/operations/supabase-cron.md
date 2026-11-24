# Kestrel scheduled work on Supabase

Kestrel's managed deployment queue and lease recovery run from Supabase Cron, not Vercel Cron. This keeps one-minute scheduling available on Vercel Hobby and leaves the durable queue in Postgres.

## Deployment

1. Apply migration `030_supabase_managed_scheduler.sql`. It enables `pg_cron` and `pg_net`, then registers two one-minute jobs.
2. Add a server-only Vercel environment variable named `KESTREL_CRON_SECRET` for Production. Use a random value of at least 32 bytes. Do not expose it through a `VITE_` variable.
3. Store the production API URL and the same bearer secret in Supabase Vault:

```sql
select vault.create_secret('https://kestrel-kappa-sepia.vercel.app', 'kestrel_api_url');
select vault.create_secret('<the KESTREL_CRON_SECRET production value>', 'kestrel_cron_secret');
```

4. Redeploy the Vercel production project so the new `KESTREL_CRON_SECRET` is available to the functions.

The scheduled SQL reads the secret from `vault.decrypted_secrets` at execution time. The bearer value is not embedded in `cron.job` command text.

## Verification

Check that both jobs exist:

```sql
select jobname, schedule, active
from cron.job
where jobname in ('kestrel-managed-deployments', 'kestrel-lease-recovery')
order by jobname;
```

Inspect the most recent HTTP responses:

```sql
select id, status_code, error_msg, created
from net._http_response
order by created desc
limit 20;
```

A successful request returns HTTP 200. Managed deployment processing handles one durable queue item per invocation; queue leases and retry state remain in Postgres.

Vercel Cron remains enabled only for the daily artifact cleanup task. The old every-minute Vercel cron is removed.
