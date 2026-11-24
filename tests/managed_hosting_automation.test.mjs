import test from 'node:test';
import assert from 'node:assert/strict';
import { processManagedHostingQueue } from '../server/lib/managed-hosting-automation.mjs';

test('managed hosting queue processor exits cleanly when no events are ready', async () => {
  const queries = [];
  const result = await processManagedHostingQueue({
    query: async (sql) => { queries.push(sql); return { rowCount: 0, rows: [] }; },
    transaction: async () => { throw new Error('No transaction should be opened'); },
  });
  assert.deepEqual(result, { processed: 0 });
  assert.match(queries[0], /for update skip locked/i);
});

test('skips an automation event if its pipeline is no longer successful', async () => {
  const queueItem = {
    id: 'queue-1', pipeline_run_id: 'run-1', attempt_count: 1,
  };
  const updates = [];
  let claim = true;
  const result = await processManagedHostingQueue({
    query: async (sql, params) => {
      if (/with candidate as/i.test(sql)) {
        if (!claim) return { rowCount: 0, rows: [] };
        claim = false;
        return { rowCount: 1, rows: [queueItem] };
      }
      if (/select r.id as run_id/i.test(sql)) return { rowCount: 1, rows: [{ run_id: 'run-1', run_status: 'failed' }] };
      if (/update public.managed_hosting_automation_queue/i.test(sql)) {
        updates.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      throw new Error('Unexpected query in managed deployment queue test');
    },
    transaction: async () => { throw new Error('No transaction should be opened'); },
  });
  assert.deepEqual(result, { processed: 1 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[1], 'skipped');
});

test('bounds each queue batch to at most twenty events', async () => {
  let claims = 0;
  await processManagedHostingQueue({
    query: async (sql) => {
      if (/with candidate as/i.test(sql)) {
        claims += 1;
        return { rowCount: 1, rows: [{ id: `queue-${claims}`, pipeline_run_id: `run-${claims}`, attempt_count: 1 }] };
      }
      if (/select r.id as run_id/i.test(sql)) return { rowCount: 1, rows: [{ run_id: 'run', run_status: 'failed' }] };
      if (/update public.managed_hosting_automation_queue/i.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected query in bounded queue test');
    },
    transaction: async () => {},
  }, 1000);
  assert.equal(claims, 20);
});
