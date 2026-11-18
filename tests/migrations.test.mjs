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
