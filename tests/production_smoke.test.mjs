import test from 'node:test';
import assert from 'node:assert/strict';
import { runProductionSmoke } from '../server/lib/production-smoke.mjs';

test('production smoke verifies liveness and readiness endpoints', async () => {
  const calls = [];
  const result = await runProductionSmoke({
    productionUrl: 'https://kestrel.example.com',
    now: new Date('2026-11-26T12:00:00.000Z'),
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/health')) {
        return new Response(JSON.stringify({
          ok: true, service: 'kestrel-control-plane', database: 'connected',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true, service: 'kestrel-control-plane', database: 'connected',
        schema: 'ready', artifactStorage: 'configured',
        workers: { status: 'ready', online: 2, minimum: 1 },
      }), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.checkedAt, '2026-11-26T12:00:00.000Z');
  assert.deepEqual(calls, [
    'https://kestrel.example.com/api/health',
    'https://kestrel.example.com/api/ready',
  ]);
  assert.equal(result.results[1].workers.online, 2);
});

test('production smoke fails closed when worker readiness is degraded', async () => {
  await assert.rejects(runProductionSmoke({
    productionUrl: 'https://kestrel.example.com',
    fetchImpl: async (url) => String(url).endsWith('/api/health')
      ? new Response(JSON.stringify({ ok: true, service: 'kestrel-control-plane', database: 'connected' }), { status: 200 })
      : new Response(JSON.stringify({
        ok: false, service: 'kestrel-control-plane', database: 'connected',
        schema: 'ready', artifactStorage: 'configured',
        workers: { status: 'degraded', online: 0, minimum: 1 },
      }), { status: 503 }),
  }), /workers=degraded/);
});

test('production smoke rejects insecure or ambiguous production origins', async () => {
  for (const productionUrl of [
    'http://kestrel.example.com',
    'https://user:password@kestrel.example.com',
    'https://kestrel.example.com/control-plane',
    'https://kestrel.example.com?token=secret',
  ]) {
    await assert.rejects(runProductionSmoke({ productionUrl }), /clean HTTPS origin/);
  }
});

test('production smoke enforces bounded request timeouts', async () => {
  await assert.rejects(runProductionSmoke({
    productionUrl: 'https://kestrel.example.com',
    timeoutMs: 100,
  }), /between 1000 and 60000/);
});
