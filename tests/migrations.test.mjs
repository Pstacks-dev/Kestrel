import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('stale lease recovery migration has a valid PL/pgSQL dollar-quoted body', async () => {
  const sql = await readFile(new URL('../db/migrations/015_recovery_backoff.sql', import.meta.url), 'utf8');
  assert.match(sql, /create or replace function public\.recover_stale_leases\(\)/i);
  assert.match(sql, /\n\$\$;\n\nrevoke all on function public\.recover_stale_leases\(\)/i);
  assert.doesNotMatch(sql, /\n\$;\n/);
  assert.match(sql, /grant execute on function public\.recover_stale_leases\(\) to service_role/i);
});

test('worker desired state separates admin intent from transient offline status', async () => {
  const sql = await readFile(new URL('../db/migrations/016_worker_desired_state.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists desired_state text not null default 'online'/i);
  assert.match(sql, /when state = 'offline' then 'offline'/i);
  assert.match(sql, /when state = 'draining' then 'draining'/i);
});

test('compute migration provisions tenant VM inventory, provider nodes and durable operation leases', async () => {
  const sql = await readFile(new URL('../db/migrations/017_compute_providers.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.compute_nodes/i);
  assert.match(sql, /create table if not exists public\.compute_instances/i);
  assert.match(sql, /create table if not exists public\.compute_operations/i);
  assert.match(sql, /create table if not exists public\.compute_quotas/i);
  assert.match(sql, /create table if not exists public\.compute_snapshots/i);
  assert.match(sql, /snapshot_create/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /members read compute instances/i);
  assert.match(sql, /token_hash text not null/i);
});

test('compute control plane exposes authenticated tenant and host-agent operations', async () => {
  const routes = await readFile(new URL('../server/routes/compute.mjs', import.meta.url), 'utf8');
  assert.match(routes, /\/api\/compute\/instances/);
  assert.match(routes, /\/api\/compute\/agent\/claim/);
  assert.match(routes, /\/api\/compute\/agent\/complete/);
  assert.match(routes, /\/api\/compute\/snapshots/);
  assert.match(routes, /snapshot_restore/);
  assert.match(routes, /lease_expires_at = now\(\) \+ interval '90 seconds'/);
  assert.match(routes, /desired_state = 'online'/);
});


test('sandbox migration adds tenant sandbox inventory, quotas and row-level security', async () => {
  const sql = await readFile(new URL('../db/migrations/018_sandbox_compute.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.sandbox_instances/i);
  assert.match(sql, /create table if not exists public\.sandbox_quotas/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /members read sandbox instances/i);
  assert.match(sql, /provider_name text not null unique/i);
});


test('managed hosting credentials are tenant-scoped, encrypted and inaccessible to browser roles', async () => {
  const sql = await readFile(new URL('../db/migrations/023_managed_hosting_providers.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.hosting_provider_connections/i);
  assert.match(sql, /organization_id uuid not null references public\.organizations/i);
  assert.match(sql, /credentials_ciphertext text not null/i);
  assert.match(sql, /credentials_iv text not null/i);
  assert.match(sql, /credentials_auth_tag text not null/i);
  assert.match(sql, /last_verified_at timestamptz/i);
  assert.match(sql, /last_error text/i);
  assert.match(sql, /unique \(organization_id, provider_id\)/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on public\.hosting_provider_connections from anon, authenticated/i);
  assert.match(sql, /grant all on public\.hosting_provider_connections to service_role/i);
});


test('managed hosting deployment migration persists provider resources and release history securely', async () => {
  const sql = await readFile(new URL('../db/migrations/024_managed_hosting_deployments.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.managed_hosting_resources/i);
  assert.match(sql, /create table if not exists public\.managed_hosting_deployments/i);
  assert.match(sql, /provider_service_id text not null/i);
  assert.match(sql, /provider_deployment_id text not null/i);
  assert.match(sql, /rollback_of uuid references public\.managed_hosting_deployments/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on public\.managed_hosting_resources, public\.managed_hosting_deployments from anon, authenticated/i);
  assert.match(sql, /grant all on public\.managed_hosting_resources, public\.managed_hosting_deployments to service_role/i);
});

test('managed deployment routes keep provider selection inside Kestrel and expose lifecycle operations', async () => {
  const routes = await readFile(new URL('../server/routes/managed-deployments.mjs', import.meta.url), 'utf8');
  assert.match(routes, /rankHostingProviders\(profile, \{\}\)/);
  assert.match(routes, /ACTIVE_MANAGED_PROVIDERS\.includes\(provider\.id\)/);
  assert.match(routes, /createManagedProviderDeployment/);
  assert.ok(routes.includes('/api/projects/:projectId/managed-deployments'));
  assert.ok(routes.includes('/api/managed-deployments/:deploymentId/logs'));
  assert.ok(routes.includes('/api/managed-deployments/:deploymentId/rollback'));
  assert.match(routes, /decryptSecret\(/);
});


test('GitHub App installation migration scopes installation links to workspaces and service role', async () => {
  const sql = await readFile(new URL('../db/migrations/028_github_app_installations.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.github_app_installations/i);
  assert.match(sql, /installation_id bigint not null unique/i);
  assert.match(sql, /organization_id uuid not null references public\.organizations/i);
  assert.match(sql, /alter table public\.projects add column if not exists github_installation_id bigint/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on public\.github_app_installations from anon, authenticated/i);
  assert.match(sql, /grant all on public\.github_app_installations to service_role/i);
});

test('deployed hosting schema reconciliation preserves encrypted credentials and webhook idempotency', async () => {
  const sql = await readFile(new URL('../db/migrations/029_reconcile_deployed_hosting_schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /rename column encrypted_credentials to credentials_ciphertext/i);
  assert.match(sql, /rename column display_name to account_label/i);
  assert.match(sql, /rename column created_by to connected_by/i);
  assert.match(sql, /when 'connected' then 'verified'/i);
  assert.match(sql, /add column if not exists id uuid default gen_random_uuid\(\)/i);
  assert.match(sql, /add column if not exists branch text/i);
  assert.match(sql, /add column if not exists commit_sha text/i);
  assert.match(sql, /unique index if not exists github_webhook_deliveries_delivery_id_uidx/i);
  assert.match(sql, /revoke all on public\.github_webhook_deliveries from anon, authenticated/i);
});
