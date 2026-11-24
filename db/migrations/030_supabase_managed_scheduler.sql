-- Use Supabase's managed Postgres scheduler for sub-minute platform queue work.
-- This avoids Vercel Hobby's once-per-day cron restriction while keeping the
-- durable queue and scheduling state inside the managed Supabase project.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Vault secrets named kestrel_api_url and kestrel_cron_secret are provisioned
-- separately. The scheduled SQL never embeds the bearer secret in cron.job.
select cron.schedule(
  'kestrel-managed-deployments',
  '* * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'kestrel_api_url')
             || '/api/cron/managed-deployments',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kestrel_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $job$
);

select cron.schedule(
  'kestrel-lease-recovery',
  '* * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'kestrel_api_url')
             || '/api/cron/recovery',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kestrel_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $job$
);
