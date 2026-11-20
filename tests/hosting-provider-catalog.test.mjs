import test from 'node:test';
import assert from 'node:assert/strict';
import { HOSTING_PROVIDERS, getHostingProvider, normalizeSubdomain, providerDomainCandidates } from '../server/deploy/providers/catalog.mjs';

test('hosting catalog includes ten providers with unique ids', () => {
  assert.equal(HOSTING_PROVIDERS.length, 10);
  assert.equal(new Set(HOSTING_PROVIDERS.map((p) => p.id)).size, 10);
  assert.equal(getHostingProvider('render').adapterStatus, 'credential-verification');
  assert.ok(HOSTING_PROVIDERS.filter((p) => p.id !== 'render').every((p) => p.adapterStatus === 'planned');
});

test('provider lookup is explicit and unknown ids return null', () => {
  assert.equal(getHostingProvider('render').name, 'Render');
  assert.equal(getHostingProvider('not-a-provider'), null);
});

test('normalizes project subdomain input and rejects invalid length', () => {
  assert.equal(normalizeSubdomain(' My App '), 'my-app');
  assert.equal(normalizeSubdomain('a'), null);
  assert.equal(normalizeSubdomain('x'.repeat(64)), null);
  assert.equal(normalizeSubdomain('../bad'), null);
});

test('produces provider hostname candidates without claiming reservation', () => {
  assert.deepEqual(providerDomainCandidates('render', 'sample-app'), [
    { domain: 'onrender.com', hostname: 'sample-app.onrender.com' },
  ]);
  assert.deepEqual(providerDomainCandidates('missing', 'sample-app'), []);
  assert.deepEqual(providerDomainCandidates('railway', '../bad'), []);
});
