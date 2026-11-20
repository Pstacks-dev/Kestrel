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

test('hosting-provider credential migration stores encrypted workspace credentials and scoped provider identifiers', async () => {
  const sql = await readFile(new URL('../db/migrations/024_hosting_provider_connections.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes('create table if not exists public.hosting_provider_connections'));
  assert.ok(sql.includes('encrypted_credentials text not null'));
  assert.ok(sql.includes('credentials_iv text not null'));
  assert.ok(sql.includes('credentials_auth_tag text not null'));
  assert.ok(sql.includes('unique (organization_id, provider_id)'));
  assert.ok(sql.includes('provider_id text not null check'));
});

test('hosting provider connection routes require encrypted credentials and workspace admin', async () => {
  const routes = await readFile(new URL('../server/routes/hosting-providers.mjs', import.meta.url), 'utf8');
  assert.ok(routes.includes('/api/hosting/providers'));
  assert.ok(routes.includes('/api/organizations/:organizationId/hosting-connections'));
  assert.ok(routes.includes('KESTREL_ENCRYPTION_KEY'));
  assert.ok(routes.includes('/verify'));
  assert.ok(routes.includes('verifyHostingProvider'));
  assert.ok(routes.includes('encrypted_credentials'));
  assert.ok(routes.includes("roles = ['owner', 'admin']"));
  assert.ok(!routes.includes('select c.encrypted_credentials'));
});


test('hosting deployment route marks records failed on unexpected errors after record creation', async () => {
  const routes = await readFile(new URL('../server/routes/hosting-deployments.mjs', import.meta.url), 'utf8');
  assert.match(routes, /let deploymentRecordId = null/);
  assert.match(routes, /deploymentRecordId = record\.rows\[0\]\.id/);
  assert.match(routes, /status='failed',error_message=\$4,provider_resource_id=\$2/);
  assert.match(routes, /where id=\$1 and status in \('provisioning','building','deploying'\)/);
  assert.match(routes, /Port must be an integer between 1 and 65535/);
  assert.match(routes, /Deployment environment variables contain invalid keys or values/);
  assert.match(routes, /65536/);
});


test('hosting deployment operations require membership and restrict cleanup to failed deployments', async () => {
  const routes = await readFile(new URL('../server/routes/hosting-deployments.mjs', import.meta.url), 'utf8');
  assert.match(routes, /hosting-deployments\/:deploymentId\/logs/);
  assert.match(routes, /hosting-deployments\/:deploymentId\/cleanup/);
  assert.match(routes, /m\.user_id=\$2/);
  assert.match(routes, /ADMIN_ROLES\.includes\(d\.role\)/);
  assert.match(routes, /d\.status !== 'failed'/);
  assert.match(routes, /status='cancelled'/);
});


test('container image build migration adds worker configuration and immutable digest fields',async()=>{
 const migration=await readFile(new URL('../db/migrations/026_container_image_builds.sql',import.meta.url),'utf8');
 assert.match(migration,/job_type in \('build','deployment','container_build'\)/);
 assert.match(migration,/container_build_config jsonb/);
 assert.match(migration,/container_image_digest text/);
 assert.match(migration,/create table if not exists public\.container_builds/);
 assert.match(migration,/enable row level security/);
 assert.match(migration,/grant all on public\.container_builds to service_role/);
});


test('automatic container build settings enforce per-source-run idempotency',async()=>{
 const migration=await readFile(new URL('../db/migrations/027_auto_container_build_settings.sql',import.meta.url),'utf8');
 assert.match(migration,/auto_build_enabled boolean/);
 assert.match(migration,/registry_host/);
 assert.match(migration,/container_builds_auto_run_unique/);
 assert.match(migration,/where auto_triggered/);
 assert.match(migration,/enable row level security/);
});

test('hosting deployment lifecycle event timeline uses the next migration and membership-checked route',async()=>{
 const migration=await readFile(new URL('../db/migrations/028_hosting_deployment_events.sql',import.meta.url),'utf8');
 const routes=await readFile(new URL('../server/routes/hosting-deployments.mjs',import.meta.url),'utf8');
 assert.match(migration,/hosting_deployment_events/);
 assert.match(migration,/enable row level security/i);
 assert.match(migration,/revoke all on public\\.hosting_deployment_events from anon, authenticated/i);
 assert.match(routes,/deployment\\.created/);
 assert.match(routes,/provider\\.accepted/);
 assert.match(routes,/deployment\\.failed/);
 assert.match(routes,/provider\\.failed/);
 assert.match(routes,/status\\.refreshed/);
 assert.match(routes,/hosting-deployments\\/:deploymentId\\/events/);
 assert.match(routes,/retry_payload_ciphertext/);
});

test('hosting deployment retry migration is bounded and request payload encryption is required',async()=>{
 const migration=await readFile(new URL('../db/migrations/029_hosting_deployment_retries.sql',import.meta.url),'utf8');
 const routes=await readFile(new URL('../server/routes/hosting-deployments.mjs',import.meta.url),'utf8');
 assert.match(migration,/retry_count between 0 and 3/i);
 assert.match(migration,/retry_payload_ciphertext/);
 assert.match(routes,/encryptSecret\\(JSON\\.stringify\\(deploymentRequest\\)\\)/);
 assert.match(routes,/retry_count<3/);
 assert.match(routes,/metadata->>'retryable'='true'/);
 assert.match(routes,/provider_resource_id is null/);
});
