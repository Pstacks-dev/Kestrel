import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRenderCredential } from '../server/deploy/providers/render.mjs';

test('Render credential verification accepts a valid API response', async () => {
  const result = await verifyRenderCredential('test-token-value', { fetchImpl: async (url, options) => {
    assert.match(url, /\/v1\/services\?limit=1$/);
    assert.equal(options.headers.Authorization, 'Bearer test-token-value');
    return { ok: true, status: 200, json: async () => [{ id: 'srv-test' }] };
  }});
  assert.deepEqual(result, { ok: true, provider: 'render', serviceCountSample: 1 });
});

test('Render verification rejects invalid tokens without leaking them', async () => {
  const result = await verifyRenderCredential('test-token-value', { fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /test-token-value/);
});

test('Render verification handles provider errors, malformed payloads and timeouts safely', async () => {
  const apiError = await verifyRenderCredential('test-token-value', { fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(apiError.error, 'Render API returned HTTP 503');
  const malformed = await verifyRenderCredential('test-token-value', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) }) });
  assert.equal(malformed.error, 'Render API returned an unexpected response');
  const timeout = await verifyRenderCredential('test-token-value', { fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } });
  assert.equal(timeout.error, 'Render API verification timed out');
  const network = await verifyRenderCredential('test-token-value', { fetchImpl: async () => { throw new Error('private details'); } });
  assert.deepEqual(network, { ok: false, error: 'Could not reach Render API' });
});
