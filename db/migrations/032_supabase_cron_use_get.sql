-- Express cron endpoints are GET routes. Use pg_net's GET helper so the
-- scheduled requests reach the existing authenticated handlers.
select cron.unschedule(jobid)
from cron.job
where jobname in ('kestrel-managed-deployments', 'kestrel-lease-recovery');

select cron.schedule(
  'kestrel-managed-deployments',
  '* * * * *',
  $job$
    select net.http_get(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'kestrel_api_url')
             || '/api/cron/managed-deployments',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kestrel_cron_secret')
      ),
      timeout_milliseconds := 10000
    );
  $job$
);

select cron.schedule(
  'kestrel-lease-recovery',
  '* * * * *',
  $job$
    select net.http_get(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'kestrel_api_url')
             || '/api/cron/recovery',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kestrel_cron_secret')
      ),
      timeout_milliseconds := 10000
    );
  $job$
);
