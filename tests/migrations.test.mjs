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


test('deployment health check migration defaults to HTTP and permits TCP probes', async () => {
  const sql = await readFile(new URL('../db/migrations/023_deployment_tcp_health_checks.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists health_check_type text not null default 'http'/i);
  assert.match(sql, /check \(health_check_type in \('http', 'tcp'\)\)/i);
});
