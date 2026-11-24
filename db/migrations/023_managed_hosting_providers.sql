-- Tenant-scoped encrypted credentials for managed external hosting providers.
create table if not exists public.hosting_provider_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_id text not null check (provider_id in (
    'render','railway','flyio','google-cloud-run','aws-ecs-express',
    'digitalocean-app-platform','heroku','vercel','netlify','cloudflare-pages'
  )),
  credentials_ciphertext text not null,
  credentials_iv text not null,
  credentials_auth_tag text not null,
  account_label text,
  last_verified_at timestamptz,
  last_error text,
  status text not null default 'configured'
    check (status in ('configured','verified','error')),
  connected_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider_id)
);

create index if not exists idx_hosting_provider_connections_org
  on public.hosting_provider_connections(organization_id, provider_id);

alter table public.hosting_provider_connections enable row level security;
-- Provider credentials are server-only. Browser clients must use the authenticated control-plane API.
revoke all on public.hosting_provider_connections from anon, authenticated;
grant all on public.hosting_provider_connections to service_role;
