import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProviderDeployRequest, normalizeProviderStatus, assertProviderAdapter, ProviderAdapterError } from '../server/deploy/providers/adapter-contract.mjs';

test('provider request requires a valid slug and validated artifact or digest image', () => {
  const staticRequest = { projectSlug: 'docs-site', appType: 'static', artifact: { path: 'dist' } };
  assert.equal(validateProviderDeployRequest('netlify', staticRequest).ok, true);
  assert.equal(validateProviderDeployRequest('netlify', { ...staticRequest, projectSlug: 'x' }).ok, false);
  assert.equal(validateProviderDeployRequest('netlify', { projectSlug: 'docs-site', appType: 'docker', image: 'latest' }).ok, false);
  assert.equal(validateProviderDeployRequest('render', { projectSlug: 'api', appType: 'docker', image: 'repo/app@sha256:' + 'a'.repeat(64) }).ok, true);
});

test('normalizes provider statuses to Kestrel deployment states', () => {
  assert.equal(normalizeProviderStatus('READY'), 'live');
  assert.equal(normalizeProviderStatus('running'), 'deploying');
  assert.equal(normalizeProviderStatus('failed'), 'failed');
  assert.equal(normalizeProviderStatus('provider-new-state'), 'unknown');
});

test('rejects adapters that do not implement the lifecycle contract', () => {
  assert.throws(() => assertProviderAdapter({ validate() {} }, 'render'), (error) => error instanceof ProviderAdapterError && error.code === 'ADAPTER_CONTRACT_INVALID');
  const adapter = Object.fromEntries(['validate', 'provision', 'getStatus', 'getLogs', 'cancel', 'delete'].map((method) => [method, async () => {}]));
  assert.equal(assertProviderAdapter(adapter, 'render'), adapter);
});
