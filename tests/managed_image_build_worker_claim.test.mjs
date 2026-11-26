import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('managed image worker recovers expired leases before enforcing concurrency', async () => {
  const source = await readFile(new URL('../server/control-plane.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/workers/managed-image-builds/claim'");
  const end = source.indexOf("app.post('/api/workers/managed-image-builds/:buildId/lease'", start);
  assert.ok(start >= 0 && end > start, 'managed image claim route must exist');
  const claim = source.slice(start, end);
  const recovery = claim.indexOf('update public.managed_hosting_image_builds');
  const capacity = claim.indexOf('const active = await client.query');
  assert.ok(recovery >= 0 && capacity > recovery, 'expired image-build leases must be recovered before capacity is checked');
  assert.match(claim, /where organization_id = \$1 and status = 'running' and lease_expires_at <= now\(\)/i);
  assert.match(claim, /where q\.organization_id = \$1 and q\.status = 'waiting_for_image'/i);
  assert.match(claim, /finished_at = case when attempt_count < 4 then null else now\(\) end/i);
  assert.match(claim, /Worker lease expired after retry budget was exhausted/i);
  const activeStart = claim.indexOf('const active = await client.query');
  const activeEnd = claim.indexOf('if (active.rows[0].count', activeStart);
  const activeQuery = claim.slice(activeStart, activeEnd);
  assert.equal((activeQuery.match(/lease_expires_at > now\(\)/g) || []).length, 2,
    'only unexpired job and image-build leases should consume worker concurrency');
});


test('managed image build release requeues an unstarted lease without consuming an attempt', async () => {
  const source = await readFile(new URL('../server/control-plane.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/workers/managed-image-builds/:buildId/release'");
  const end = source.indexOf("app.post('/api/workers/managed-image-builds/:buildId/lease'", start);
  assert.ok(start >= 0 && end > start, 'managed image build release route must exist');
  const release = source.slice(start, end);
  assert.match(release, /status = 'queued'/i);
  assert.match(release, /attempt_count = greatest\(attempt_count - 1, 0\)/i);
  assert.match(release, /worker_id = null, lease_token = null, lease_expires_at = null/i);
  assert.match(release, /started_at = null, finished_at = null, last_error = null/i);
  assert.match(release, /status = 'running' and lease_expires_at > now\(\)/i);
});

test('job release requeues a claim received during shutdown and preserves draining state', async () => {
  const source = await readFile(new URL('../server/control-plane.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/workers/jobs/:jobId/release'");
  const end = source.indexOf("// Job Completion", start);
  assert.ok(start >= 0 && end > start, 'job release route must exist');
  const release = source.slice(start, end);
  assert.match(release, /status = 'queued'/i);
  assert.match(release, /attempt = greatest\(attempt - 1, 0\)/i);
  assert.match(release, /state in \('draining','offline'\) then state/i);
  assert.match(release, /deployment_releases set status = 'queued'/i);
  assert.match(release, /status = 'running' and lease_expires_at > now\(\)/i);
});
