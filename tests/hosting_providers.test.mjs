import test from 'node:test';
import assert from 'node:assert/strict';
import { listHostingProviders, normalizeAppProfile, rankHostingProviders } from '../server/lib/hosting-providers.mjs';

test('catalog contains the ten selected hosting providers', () => {
  const providers = listHostingProviders({});
  assert.equal(providers.length, 10);
  assert.deepEqual(providers.map((provider) => provider.id), [
    'render','railway','flyio','google-cloud-run','aws-app-runner',
    'digitalocean-app-platform','heroku','vercel','netlify','cloudflare-pages',
  ]);
});

test('normalizes project deployment requirements', () => {
  assert.deepEqual(normalizeAppProfile({ runtime: 'Node', dockerfile: true, needsPersistentProcess: true }), {
    runtime: 'node', kind: 'web', isStatic: false, needsContainer: true,
    needsPersistentProcess: true, needsBackgroundWorker: false, needsDatabase: false,
  });
});

test('container and persistent backend projects exclude serverless-only providers', () => {
  const ranked = rankHostingProviders({ runtime: 'node', dockerfile: true, needsPersistentProcess: true }, {});
  const ids = ranked.map((provider) => provider.id);
  assert.ok(ids.includes('render'));
  assert.ok(ids.includes('railway'));
  assert.ok(ids.includes('flyio'));
  assert.ok(ids.includes('google-cloud-run'));
  assert.ok(ids.includes('aws-app-runner'));
  assert.ok(ids.includes('digitalocean-app-platform'));
  assert.ok(ids.includes('heroku'));
  assert.ok(!ids.includes('netlify'));
  assert.ok(!ids.includes('cloudflare-pages'));
});

test('static frontend projects can use all ten compatible platforms', () => {
  const ranked = rankHostingProviders({ runtime: 'javascript', kind: 'static', isStatic: true }, {});
  assert.equal(ranked.length, 10);
});

test('managed database requirement only returns providers with database offerings', () => {
  const ranked = rankHostingProviders({ runtime: 'node', needsDatabase: true }, {});
  assert.deepEqual(ranked.map((provider) => provider.id).sort(), [
    'digitalocean-app-platform','heroku','railway','render',
  ]);
});

test('credential readiness changes ranking but never makes an incompatible provider eligible', () => {
  const env = { RAILWAY_API_TOKEN: 'test-token' };
  const ranked = rankHostingProviders({ runtime: 'node', needsPersistentProcess: true }, env);
  assert.equal(ranked[0].id, 'railway');
  assert.equal(ranked[0].configured, true);
  assert.ok(!ranked.some((provider) => provider.id === 'cloudflare-pages'));
});
