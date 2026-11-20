-- Workspace-scoped hosting-provider credentials. Secret payload is AES-256-GCM encrypted by the control plane.
create table if not exists public.hosting_provider_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_id text not null check (provider_id in (
    'render','railway','flyio','cloud-run','aws-apprunner','azure-container-apps',
    'digitalocean','heroku','vercel','netlify'
  )),
  display_name text not null check (length(display_name) between 1 and 100),
  encrypted_credentials text not null,
  credentials_iv text not null,
  credentials_auth_tag text not null,
  status text not null default 'unverified' check (status in ('unverified','connected','error','revoked')),
  last_verified_at timestamptz,
  last_error text,
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, provider_id)
);
create index if not exists hosting_provider_connections_org_idx
  on public.hosting_provider_connections(organization_id);
alter table public.hosting_provider_connections enable row level security;
-- Credential rows are server-only; browser clients receive no table grants or policies.
revoke all on public.hosting_provider_connections from anon, authenticated;
grant all on public.hosting_provider_connections to service_role;
