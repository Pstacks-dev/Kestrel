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
