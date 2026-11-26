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


test('org authorization SECURITY DEFINER helpers are moved out of the exposed public schema', async () => {
  const sql = await readFile(new URL('../db/migrations/031_move_org_auth_helpers_private.sql', import.meta.url), 'utf8');
  assert.match(sql, /alter function public\.is_org_member\(uuid\) set schema private/i);
  assert.match(sql, /alter function public\.is_org_admin\(uuid\) set schema private/i);
  assert.match(sql, /revoke all on function private\.is_org_member\(uuid\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function private\.is_org_member\(uuid\) to authenticated, service_role/i);
});

test('Supabase managed scheduler enables pg_cron and pg_net', async () => {
  const sql = await readFile(new URL('../db/migrations/030_supabase_managed_scheduler.sql', import.meta.url), 'utf8');
  assert.match(sql, /create extension if not exists pg_cron/i);
  assert.match(sql, /create extension if not exists pg_net/i);
  assert.match(sql, /cron\.schedule\(\s*'kestrel-managed-deployments'/i);
  assert.match(sql, /cron\.schedule\(\s*'kestrel-lease-recovery'/i);
  assert.match(sql, /vault\.decrypted_secrets/i);
  assert.doesNotMatch(sql, /Bearer [A-Za-z0-9_-]{20,}/i);
});

test('Vercel Hobby configuration does not schedule frequent managed cron jobs', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.crons.some((job) => job.path === '/api/cron/managed-deployments'), false);
  assert.equal(config.crons.some((job) => job.path === '/api/cron/recovery'), false);
  assert.equal(config.crons.some((job) => job.schedule === '* * * * *'), false);
});

test('Supabase scheduler invokes existing GET cron handlers and replaces prior jobs', async () => {
  const sql = await readFile(new URL('../db/migrations/032_supabase_cron_use_get.sql', import.meta.url), 'utf8');
  assert.match(sql, /cron\.unschedule\(jobid\)/i);
  assert.equal((sql.match(/net\.http_get\(/gi) || []).length, 2);
  assert.doesNotMatch(sql, /net\.http_post\(/i);
  assert.match(sql, /\/api\/cron\/managed-deployments/);
  assert.match(sql, /\/api\/cron\/recovery/);
  assert.match(sql, /vault\.decrypted_secrets/i);
});


test('GitHub App installation webhook delivery ledger is durable and service-role only', async () => {
  const sql = await readFile(new URL('../db/migrations/035_github_app_webhook_delivery_deduplication.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.github_app_webhook_deliveries/i);
  assert.match(sql, /delivery_id text primary key/i);
  assert.match(sql, /installation_id bigint not null check \(installation_id > 0\)/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on public\.github_app_webhook_deliveries from anon, authenticated/i);
  assert.match(sql, /grant all on public\.github_app_webhook_deliveries to service_role/i);
});

test('GitHub installation webhook validates delivery ID and applies state changes transactionally', async () => {
  const routes = await readFile(new URL('../server/control-plane.mjs', import.meta.url), 'utf8');
  assert.match(routes, /const deliveryId = String\(req\.headers\['x-github-delivery'\]/);
  assert.match(routes, /if \(!isValidGitHubDeliveryId\(deliveryId\)\)/);
  assert.match(routes, /await transaction\(async \(client\) =>/);
  assert.match(routes, /processGitHubInstallationDelivery\(client, \{ deliveryId, action, installationId \}\)/);
});


test('project OCI build context is configurable and passed to managed image workers', async () => {
  const sql = await readFile(new URL('../db/migrations/036_project_oci_build_context.sql', import.meta.url), 'utf8');
  const automation = await readFile(new URL('../server/lib/managed-hosting-automation.mjs', import.meta.url), 'utf8');
  const routes = await readFile(new URL('../server/control-plane.mjs', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../worker/agent.mjs', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists oci_build_context text/i);
  assert.match(sql, /add column if not exists build_context text/i);
  assert.match(automation, /p\.oci_build_context/);
  assert.match(routes, /buildContext: row\.build_context/);
  assert.match(worker, /resolveOciBuildContext\([\s\S]*build\.buildContext\)/);
  assert.match(routes, /api\/projects\/:projectId\/build-settings/);
});
