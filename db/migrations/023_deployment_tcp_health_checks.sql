-- Deployment environments may use HTTP response checks or TCP connect checks.
alter table public.deployment_environments
  add column if not exists health_check_type text not null default 'http'
    check (health_check_type in ('http', 'tcp'));
