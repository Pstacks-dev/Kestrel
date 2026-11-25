import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret } from '../server/lib/security.mjs';
import {
  isSafeProviderHealthUrl, normalizeProviderDeploymentStatus, probeProviderReadiness,
  reconcileManagedDeploymentReadiness,
} from '../server/lib/managed-deployment-readiness.mjs';

test('normalizes provider lifecycle states into Kestrel deployment states', () => {
  assert.equal(normalizeProviderDeploymentStatus('READY'), 'live');
  assert.equal(normalizeProviderDeploymentStatus('in progress'), 'deploying');
  assert.equal(normalizeProviderDeploymentStatus('cancelled'), 'failed');
  assert.equal(normalizeProviderDeploymentStatus('unknown-provider-state'), 'unknown');
});

test('health checks accept only HTTPS provider-owned hostnames', () => {
  assert.equal(isSafeProviderHealthUrl('render', 'https://sample.onrender.com/'), true);
  assert.equal(isSafeProviderHealthUrl('vercel', 'https://sample.vercel.app/'), true);
  assert.equal(isSafeProviderHealthUrl('render', 'http://sample.onrender.com/'), false);
  assert.equal(isSafeProviderHealthUrl('render', 'https://127.0.0.1/'), false);
  assert.equal(isSafeProviderHealthUrl('render', 'https://localhost/'), false);
  assert.equal(isSafeProviderHealthUrl('render', 'https://attacker.example/'), false);
  assert.equal(isSafeProviderHealthUrl('cloudflare-pages', 'https://sample.pages.dev/'), true);
});

test('probes provider URL with HEAD and falls back to a bounded GET when unsupported', async () => {
  const methods = [];
  const result = await probeProviderReadiness('render', 'https://sample.onrender.com/', {
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return new Response(null, { status: options.method === 'HEAD' ? 405 : 200 });
    },
  });
  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.equal(result.healthy, true);
  assert.equal(result.statusCode, 200);
});

test('rejects unsafe health-check URLs without making a network request', async () => {
  let called = false;
  const result = await probeProviderReadiness('render', 'https://127.0.0.1/', {
    fetchImpl: async () => { called = true; throw new Error('must not fetch'); },
  });
  assert.equal(called, false);
  assert.equal(result.healthy, false);
});

test('reconciles a live deployment only after its provider URL responds successfully', async () => {
  const updates = [];
  const calls = [];
  const encrypted = encryptSecret(JSON.stringify({ apiKey: 'render-test-key' }));
  const result = await reconcileManagedDeploymentReadiness({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^\s*select d\./i.test(sql)) return { rowCount: 1, rows: [{
        id: 'deployment-1', provider_id: 'render', provider_deployment_id: 'provider-deploy-1',
        provider_url: 'https://sample.onrender.com/', health_attempt_count: 0,
        credentials_ciphertext: encrypted.encryptedValue, credentials_iv: encrypted.iv, credentials_auth_tag: encrypted.authTag,
        provider_service_id: 'srv-1', provider_project_id: 'project-1',
      }] };
      updates.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (url === 'https://api.render.com/v1/services/srv-1/deploys/provider-deploy-1') {
        return new Response(JSON.stringify({ id: 'provider-deploy-1', status: 'live' }), { status: 200 });
      }
      if (url === 'https://api.render.com/v1/services/srv-1') {
        return new Response(JSON.stringify({ service: { serviceDetails: { url: 'https://sample.onrender.com/' } } }), { status: 200 });
      }
      return new Response(null, { status: 200 });
    },
    logger: { warn() {} },
  }, 5);
  assert.deepEqual(result, { checked: 1, healthy: 1, unhealthy: 0, pending: 0 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[3], 'healthy');
  assert.ok(calls.some((call) => call.url === 'https://sample.onrender.com/' && call.method === 'HEAD'));
});
