import test from 'node:test';
import assert from 'node:assert/strict';
import { listHostingProviders, normalizeAppProfile, rankHostingProviders } from '../server/lib/hosting-providers.mjs';

test('catalog contains the ten selected hosting providers', () => {
  const providers = listHostingProviders({});
  assert.equal(providers.length, 10);
  assert.deepEqual(providers.map((provider) => provider.id), [
    'render','railway','flyio','google-cloud-run','aws-ecs-express',
    'digitalocean-app-platform','heroku','vercel','netlify','cloudflare-pages',
  ]);
});

test('normalizes project deployment requirements', () => {
  assert.deepEqual(normalizeAppProfile({ runtime: 'Node', dockerfile: true, needsPersistentProcess: true }), {
    runtime: 'node', framework: null, kind: 'web', isStatic: false, needsContainer: true,
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
  assert.ok(ids.includes('aws-ecs-express'));
  assert.ok(ids.includes('digitalocean-app-platform'));
  assert.ok(ids.includes('heroku'));
  assert.ok(!ids.includes('netlify'));
  assert.ok(!ids.includes('cloudflare-pages'));
});

test('static frontend projects can use compatible platforms without image-only providers', () => {
  const ranked = rankHostingProviders({ runtime: 'javascript', kind: 'static', isStatic: true }, {});
  assert.equal(ranked.length, 8);
  assert.ok(!ranked.some((provider) => ['google-cloud-run', 'aws-ecs-express'].includes(provider.id)));
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

test('detects static Vite frontend from its package manifest', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  const profile = detectProjectProfile({
    files: ['package.json', 'index.html', 'vite.config.js'],
    packageJson: { dependencies: { vite: '^6.0.0', react: '^19.0.0' }, scripts: { build: 'vite build' } },
  });
  assert.equal(profile.runtime, 'node');
  assert.equal(profile.framework, 'vite');
  assert.equal(profile.isStatic, true);
  assert.equal(profile.needsPersistentProcess, false);
});

test('detects a Docker-backed application as a persistent container workload', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  const profile = detectProjectProfile({ files: ['Dockerfile', 'package.json'], packageJson: { scripts: { start: 'node server.js' } } });
  assert.equal(profile.needsContainer, true);
  assert.equal(profile.needsPersistentProcess, true);
});

test('detects Python, Go, Rust, PHP, Ruby and .NET manifests', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  for (const [file, runtime] of [
    ['requirements.txt', 'python'], ['go.mod', 'go'], ['Cargo.toml', 'rust'],
    ['composer.json', 'php'], ['Gemfile', 'ruby'], ['Api.csproj', 'dotnet'],
  ]) {
    assert.equal(detectProjectProfile({ files: [file] }).runtime, runtime, file);
  }
});

test('AWS ECS Express Mode is recommended only when a container image is available', () => {
  const sourceBuild = rankHostingProviders({ runtime: 'node', needsPersistentProcess: true }, {});
  assert.ok(!sourceBuild.some((provider) => provider.id === 'aws-ecs-express'));
  const containerBuild = rankHostingProviders({ runtime: 'node', dockerfile: true, needsPersistentProcess: true }, {});
  assert.ok(containerBuild.some((provider) => provider.id === 'aws-ecs-express'));
});


test('Vercel accepts framework-managed Next.js functions without accepting arbitrary persistent servers', () => {
  const next = rankHostingProviders({ runtime: 'node', framework: 'nextjs', needsPersistentProcess: true }, {});
  assert.ok(next.some((provider) => provider.id === 'vercel'));
  const customServer = rankHostingProviders({ runtime: 'node', needsPersistentProcess: true }, {});
  assert.ok(!customServer.some((provider) => provider.id === 'vercel'));
});
