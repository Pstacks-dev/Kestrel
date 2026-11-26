import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCloudflarePagesDeployment, deployCloudflarePagesProject,
  getCloudflarePagesDeployment, getCloudflarePagesDeploymentLogs,
  rollbackCloudflarePagesDeployment,
} from '../server/lib/hosting-cloudflare-pages.mjs';

const response = (result, status = 200) => new Response(JSON.stringify({
  success: true, errors: [], result,
}), { status, headers: { 'content-type': 'application/json' } });

test('creates a Git-connected Pages project and deploys an exact commit', async () => {
  const calls = [];
  const result = await createCloudflarePagesDeployment({
    apiToken: 'cf-token', accountId: 'a'.repeat(32),
    projectName: 'Kestrel Demo', repositoryUrl: 'https://github.com/acme/demo.git',
    branch: 'main', commitSha: 'b'.repeat(40),
    buildCommand: 'npm run build', destinationDir: 'dist',
  }, { fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/pages/projects/kestrel-demo')) return new Response(JSON.stringify({
      success: false, errors: [{ message: 'not found' }], result: null,
    }), { status: 404 });
    if (url.endsWith('/pages/projects')) {
      const body = JSON.parse(options.body);
      assert.equal(body.source.type, 'github');
      assert.equal(body.source.config.owner, 'acme');
      assert.equal(body.source.config.repo_name, 'demo');
      assert.equal(body.source.config.production_deployments_enabled, false);
      assert.equal(body.build_config.destination_dir, 'dist');
      return response({ name: 'kestrel-demo', subdomain: 'kestrel-demo' });
    }
    assert.equal(url.endsWith('/pages/projects/kestrel-demo/deployments'), true);
    const form = options.body;
    assert.equal(form.get('branch'), 'main');
    assert.equal(form.get('commit_hash'), 'b'.repeat(40));
    assert.equal(form.get('commit_dirty'), 'false');
    return response({ id: 'deploy-1', url: 'https://deploy-1.kestrel-demo.pages.dev', latest_stage: { name: 'queued', status: 'active' } }, 200);
  } });
  assert.equal(calls.length, 3);
  assert.equal(result.projectId, 'a'.repeat(32));
  assert.equal(result.serviceId, 'kestrel-demo');
  assert.equal(result.deploymentId, 'deploy-1');
  assert.equal(result.status, 'deploying');
});

test('reuses a matching Cloudflare Pages project for subsequent commits', async () => {
  const result = await deployCloudflarePagesProject({
    apiToken: 'cf-token', accountId: 'a'.repeat(32), projectName: 'kestrel-demo',
    branch: 'main', commitSha: 'c'.repeat(40), env: { API_KEY: 'secret' },
  }, { fetchImpl: async (url, options) => {
    if (url.endsWith('/pages/projects/kestrel-demo')) {
      assert.equal(options.method, 'PATCH');
      assert.equal(JSON.parse(options.body).deployment_configs.production.env_vars.API_KEY.type, 'secret_text');
      return response({ name: 'kestrel-demo' });
    }
    assert.equal(url.endsWith('/pages/projects/kestrel-demo/deployments'), true);
    assert.equal(options.body.get('commit_hash'), 'c'.repeat(40));
    return response({ id: 'deploy-2', latest_stage: { name: 'deploy', status: 'active' } });
  } });
  assert.equal(result.deploymentId, 'deploy-2');
});

test('updates build settings on an existing Pages project and preserves previously configured variables', async () => {
  const calls = [];
  const result = await createCloudflarePagesDeployment({
    apiToken: 'cf-token', accountId: 'a'.repeat(32),
    projectName: 'kestrel-demo', repositoryUrl: 'https://github.com/acme/demo',
    branch: 'main', commitSha: 'd'.repeat(40),
    buildCommand: 'npm run build:docs', destinationDir: 'public', rootDir: '/docs',
    env: { NEW_SECRET: 'new-value' },
  }, { fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'GET') return response({
      name: 'kestrel-demo', subdomain: 'kestrel-demo',
      source: { type: 'github', config: { owner: 'acme', repo_name: 'demo' } },
      deployment_configs: {
        production: { env_vars: { EXISTING_SECRET: { type: 'secret_text', value: 'keep-me' } } },
        preview: { env_vars: { PREVIEW_ONLY: { type: 'secret_text', value: 'also-keep' } } },
      },
    });
    if (options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.build_config, {
        build_command: 'npm run build:docs', destination_dir: 'public',
        root_dir: '/docs', build_caching: true,
      });
      assert.equal(body.deployment_configs.production.env_vars.EXISTING_SECRET.value, 'keep-me');
      assert.equal(body.deployment_configs.production.env_vars.NEW_SECRET.value, 'new-value');
      assert.equal(body.deployment_configs.preview.env_vars.PREVIEW_ONLY.value, 'also-keep');
      return response({ name: 'kestrel-demo', subdomain: 'kestrel-demo' });
    }
    return response({ id: 'deploy-existing', latest_stage: { name: 'queued', status: 'active' } });
  } });
  assert.equal(calls[0].options.method || 'GET', 'GET');
  assert.equal(calls[1].options.method, 'PATCH');
  assert.equal(result.deploymentId, 'deploy-existing');
});

test('polls Pages deployment stage and provider URL', async () => {
  const result = await getCloudflarePagesDeployment({
    apiToken: 'x', accountId: 'a'.repeat(32), projectName: 'kestrel-demo', deploymentId: 'deploy-1',
  }, { fetchImpl: async () => response({
    id: 'deploy-1', environment: 'production', url: 'https://kestrel-demo.pages.dev',
    latest_stage: { name: 'deploy', status: 'success' },
  }) });
  assert.equal(result.status, 'live');
  assert.equal(result.canRollback, true);
  assert.equal(result.providerUrl, 'https://kestrel-demo.pages.dev');
});

test('retrieves Cloudflare Pages build logs', async () => {
  const logs = await getCloudflarePagesDeploymentLogs({
    apiToken: 'x', accountId: 'a'.repeat(32), projectName: 'kestrel-demo', deploymentId: 'deploy-1',
  }, { fetchImpl: async () => response({
    data: [{ ts: '2026-11-24T10:00:00Z', line: 'Build completed' }],
    includes_container_logs: false, total: 1,
  }) });
  assert.equal(logs.build[0].message, 'Build completed');
  assert.equal(logs.unavailable, false);
});

test('rolls back a Pages production deployment through the rollback endpoint', async () => {
  const result = await rollbackCloudflarePagesDeployment({
    apiToken: 'x', accountId: 'a'.repeat(32), projectName: 'kestrel-demo', deploymentId: 'deploy-old',
  }, { fetchImpl: async (url, options) => {
    assert.equal(url.endsWith('/deployments/deploy-old/rollback'), true);
    assert.equal(options.method, 'POST');
    return response({ id: 'deploy-rollback', latest_stage: { name: 'deploy', status: 'active' } });
  } });
  assert.equal(result.deploymentId, 'deploy-rollback');
});

test('rejects unsafe Cloudflare Pages output directories before API calls', async () => {
  for (const destinationDir of ['/var/www', 'C:/site', '../outside', 'dist//site', 'dist\\\\assets', 'dist\\0evil']) {
    await assert.rejects(createCloudflarePagesDeployment({
      apiToken: 'x', accountId: 'a'.repeat(32), projectName: 'demo',
      repositoryUrl: 'https://github.com/acme/demo', commitSha: 'a'.repeat(40),
      destinationDir,
    }, { fetchImpl: async () => assert.fail('Cloudflare API must not be called') }), /Invalid Cloudflare Pages build directory/);
  }
});

test('rejects invalid repositories, commit SHAs and build paths', async () => {
  await assert.rejects(createCloudflarePagesDeployment({
    apiToken: 'x', accountId: 'a'.repeat(32), projectName: 'demo',
    repositoryUrl: 'https://gitlab.com/acme/demo', commitSha: 'b'.repeat(40),
  }, { fetchImpl: async () => assert.fail('Cloudflare API must not be called') }), /public GitHub repository/);
  await assert.rejects(deployCloudflarePagesProject({
    apiToken: 'x', accountId: 'a'.repeat(32), projectName: 'demo', commitSha: 'bad',
  }, { fetchImpl: async () => assert.fail('Cloudflare API must not be called') }), /verified Git commit SHA/);
});
