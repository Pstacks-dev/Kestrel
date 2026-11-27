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
  assert.equal(ranked.length, 7);
  assert.ok(!ranked.some((provider) => ['flyio', 'google-cloud-run', 'aws-ecs-express'].includes(provider.id)));
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


test('detects modern JavaScript frameworks and their static output directories', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  const cases = [
    ['astro', { astro: '^5.0.0' }, 'astro', 'dist'],
    ['angular', { '@angular/core': '^19.0.0' }, 'angular', 'dist'],
    ['vue', { vue: '^3.0.0', vite: '^6.0.0' }, 'vue', 'dist'],
    ['svelte', { svelte: '^5.0.0', vite: '^6.0.0' }, 'svelte', 'dist'],
    ['gatsby', { gatsby: '^5.0.0' }, 'gatsby', 'public'],
    ['react-scripts', { 'react-scripts': '^5.0.0' }, 'create-react-app', 'build'],
  ];
  for (const [label, dependencies, framework, outputDirectory] of cases) {
    const profile = detectProjectProfile({ files: ['apps/web/package.json'], packageJson: { dependencies, scripts: { build: 'framework build' } } });
    assert.equal(profile.framework, framework, label);
    assert.equal(profile.isStatic, true, label);
    assert.equal(profile.outputDirectory, outputDirectory, label);
  }
});

test('detects nested Dockerfiles and Java build manifests', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  const docker = detectProjectProfile({ files: ['services/api/Dockerfile', 'services/api/package.json'] });
  assert.equal(docker.needsContainer, true);
  const java = detectProjectProfile({ files: ['pom.xml'] });
  assert.equal(java.runtime, 'java');
  assert.equal(java.kind, 'unknown');
  assert.equal(java.needsPersistentProcess, false);
});

test('keeps Next.js and Nuxt server projects out of static-only classification', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  const next = detectProjectProfile({ files: ['package.json'], packageJson: { dependencies: { next: '^15.0.0' }, scripts: { start: 'next start' } } });
  const nuxt = detectProjectProfile({ files: ['package.json'], packageJson: { dependencies: { nuxt: '^3.0.0' }, scripts: { start: 'node .output/server/index.mjs' } } });
  assert.equal(next.framework, 'nextjs');
  assert.equal(next.isStatic, false);
  assert.equal(next.needsPersistentProcess, true);
  assert.equal(nuxt.framework, 'nuxt');
  assert.equal(nuxt.isStatic, false);
  assert.equal(nuxt.needsPersistentProcess, true);
});


test('detects the repository package manager and uses its build script command', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  const cases = [
    { files: ['package.json', 'package-lock.json'], packageJson: { scripts: { build: 'vite build' } }, manager: 'npm', command: 'npm run build' },
    { files: ['package.json', 'pnpm-lock.yaml'], packageJson: { packageManager: 'pnpm@10.0.0', scripts: { build: 'vite build' } }, manager: 'pnpm', command: 'pnpm run build' },
    { files: ['package.json', 'yarn.lock'], packageJson: { scripts: { build: 'vite build' } }, manager: 'yarn', command: 'yarn build' },
    { files: ['package.json', 'bun.lock'], packageJson: { scripts: { build: 'vite build' } }, manager: 'bun', command: 'bun run build' },
  ];
  for (const item of cases) {
    const profile = detectProjectProfile({ files: item.files, packageJson: item.packageJson });
    assert.equal(profile.packageManager, item.manager);
    assert.equal(profile.buildCommand, item.command);
  }
});

test('does not invent a JavaScript build script when package.json has none', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  const profile = detectProjectProfile({
    files: ['package.json', 'pnpm-lock.yaml'],
    packageJson: { packageManager: 'pnpm@10.0.0', scripts: { start: 'node server.js' } },
  });
  assert.equal(profile.packageManager, 'pnpm');
  assert.equal(profile.buildCommand, undefined);
});


test('detects a broad set of languages, frameworks and build systems in mixed repositories', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  const profile = detectProjectProfile({
    files: [
      'apps/web/package.json', 'apps/web/tsconfig.json', 'apps/web/pnpm-lock.yaml',
      'services/api/pyproject.toml', 'services/worker/go.mod', 'crates/core/Cargo.toml',
      'services/payments/composer.json', 'services/legacy/Gemfile',
      'services/auth/pom.xml', 'services/desktop/App.csproj',
      'mobile/pubspec.yaml', 'mobile/lib/main.dart', 'native/Package.swift',
      'contracts/foundry.toml', 'native/CMakeLists.txt', 'native/src/main.cpp',
      'scripts/deploy.sh', 'Dockerfile',
    ],
    packageJson: {
      packageManager: 'pnpm@10.0.0',
      dependencies: { next: '^15.0.0', react: '^19.0.0' },
      scripts: { build: 'next build', start: 'next start' },
    },
  });
  for (const language of ['javascript','typescript','python','go','rust','php','ruby','java','dotnet','dart','swift','solidity','cpp','shell','docker']) {
    assert.ok(profile.languages.includes(language), 'expected ' + language + ' to be detected');
  }
  assert.equal(profile.framework, 'nextjs');
  assert.equal(profile.packageManager, 'pnpm');
  assert.ok(profile.buildSystems.includes('cargo'));
  assert.equal(profile.needsContainer, true);
  assert.equal(profile.detectionStatus, 'detected');
});

test('detects individual language source files even without root manifests', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  const cases = [
    ['src/main.py', 'python'], ['cmd/api/main.go', 'go'], ['src/lib.rs', 'rust'],
    ['src/index.php', 'php'], ['lib/app.rb', 'ruby'], ['src/Main.java', 'java'],
    ['src/Program.cs', 'dotnet'], ['Sources/App.swift', 'swift'], ['lib/main.dart', 'dart'],
    ['src/main.zig', 'zig'], ['src/main.hs', 'haskell'], ['src/main.ex', 'elixir'],
    ['src/main.lua', 'lua'], ['src/main.sol', 'solidity'],
  ];
  for (const [file, language] of cases) {
    const profile = detectProjectProfile({ files: [file] });
    assert.ok(profile.languages.includes(language), file + ' should detect ' + language);
  }
});

test('does not classify language-only source repositories as deployable web services', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  for (const file of ['src/main.py', 'cmd/main.go', 'src/lib.rs', 'src/Main.java', 'src/Program.cs']) {
    const profile = detectProjectProfile({ files: [file] });
    assert.equal(profile.kind, 'unknown', file);
    assert.equal(profile.needsPersistentProcess, false, file);
    assert.deepEqual(rankHostingProviders(profile, {}), [], file);
  }
  const django = detectProjectProfile({ files: ['requirements.txt', 'manage.py'] });
  assert.equal(django.kind, 'web');
  assert.equal(django.needsPersistentProcess, true);
  const docker = detectProjectProfile({ files: ['Dockerfile', 'src/main.py'] });
  assert.equal(docker.kind, 'web');
  assert.equal(docker.needsContainer, true);
});

test('reports unknown projects explicitly instead of guessing a language', async () => {
  const { detectProjectProfile } = await import('../server/lib/hosting-providers.mjs');
  const profile = detectProjectProfile({ files: ['README.md', 'LICENSE'] });
  assert.equal(profile.runtime, 'unknown');
  assert.deepEqual(profile.languages, []);
  assert.equal(profile.detectionStatus, 'unknown');
});


test('does not recommend source-build providers for unsupported detected languages', () => {
  for (const runtime of ['swift', 'dart', 'elixir', 'erlang', 'haskell', 'ocaml', 'perl', 'r', 'julia', 'lua', 'solidity', 'cpp', 'c', 'zig']) {
    assert.deepEqual(rankHostingProviders({ runtime, needsPersistentProcess: true }, {}), [], runtime);
  }
  const java = rankHostingProviders({ runtime: 'java', needsPersistentProcess: true }, {}).map((provider) => provider.id);
  assert.ok(java.includes('railway'));
  assert.ok(java.includes('digitalocean-app-platform'));
  assert.ok(!java.includes('render'));
  assert.ok(!java.includes('vercel'));
});

test('allows unknown runtimes only when the repository supplies a container build contract', () => {
  assert.deepEqual(rankHostingProviders({ runtime: 'unknown', needsPersistentProcess: true }, {}), []);
  const container = rankHostingProviders({ runtime: 'unknown', needsContainer: true, needsPersistentProcess: true }, {}).map((provider) => provider.id);
  assert.ok(container.includes('render'));
  assert.ok(container.includes('railway'));
  assert.ok(container.includes('flyio'));
});

test('keeps Node-built static projects eligible for Cloudflare Pages', () => {
  const ids = rankHostingProviders({ runtime: 'node', isStatic: true }, {}).map((provider) => provider.id);
  assert.ok(ids.includes('cloudflare-pages'));
});


test('JavaScript and TypeScript receive the same provider compatibility score as Node.js', () => {
  const node = rankHostingProviders({ runtime: 'node', needsPersistentProcess: true }, {});
  const javascript = rankHostingProviders({ runtime: 'javascript', needsPersistentProcess: true }, {});
  const typescript = rankHostingProviders({ runtime: 'typescript', needsPersistentProcess: true }, {});
  const summarize = (items) => items.map(({ id, score, reasons }) => ({
    id, score, supportsRuntime: reasons.includes('Supports the detected runtime'),
  }));
  assert.deepEqual(summarize(javascript), summarize(node));
  assert.deepEqual(summarize(typescript), summarize(node));
});
