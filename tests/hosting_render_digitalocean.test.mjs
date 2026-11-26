import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRenderDeployment, deployRenderService, getRenderDeployment, rollbackRenderDeployment,
} from '../server/lib/hosting-render.mjs';
import {
  createDigitalOceanDeployment, deployDigitalOceanApp, getDigitalOceanDeployment, rollbackDigitalOceanDeployment,
} from '../server/lib/hosting-digitalocean.mjs';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('creates a Render web service with autodeploy disabled and deploys the verified commit', async () => {
  const calls = [];
  const result = await createRenderDeployment({
    apiKey: 'render-token', ownerId: 'owner-123', repositoryUrl: 'https://github.com/acme/demo.git',
    branch: 'main', commitSha: 'a'.repeat(40), projectName: 'Demo App', profile: { runtime: 'node', isStatic: false }, env: { DATABASE_URL: 'postgres://secret' },
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST' && url.endsWith('/services')) return response({ service: { id: 'srv-1', serviceDetails: { url: 'https://demo.onrender.com' } } }, 201);
    if (url.endsWith('/services/srv-1/env-vars')) { assert.equal(options.method, 'PUT'); assert.equal(JSON.parse(options.body)[0].key, 'DATABASE_URL'); return response({}); }
    return response({ id: 'dep-1', status: 'created' }, 201);
  } });
  assert.equal(calls.length, 3);
  const service = JSON.parse(calls[0].options.body);
  assert.equal(service.autoDeployTrigger, 'off');
  assert.equal(service.repo, 'https://github.com/acme/demo');
  assert.equal(service.serviceDetails.runtime, 'node');
  assert.deepEqual(service.serviceDetails.envSpecificDetails, {
    buildCommand: 'npm install && npm run build',
    startCommand: 'npm start',
  });
  assert.equal(service.serviceDetails.plan, 'starter');
  assert.equal(service.serviceDetails.region, 'oregon');
  assert.equal(JSON.parse(calls[2].options.body).commitId, 'a'.repeat(40));
  assert.equal(result.serviceId, 'srv-1');
  assert.equal(result.deploymentId, 'dep-1');
});

test('uses framework-specific static output directories and configured build commands on Render', async () => {
  const cases = [
    { outputDirectory: 'public', buildCommand: 'npm run build:docs' },
    { outputDirectory: 'build', buildCommand: 'npm run build' },
    { outputDirectory: 'dist/site/browser', buildCommand: 'npm ci && npm run build' },
  ];
  for (const [index, config] of cases.entries()) {
    let serviceBody;
    await createRenderDeployment({
      apiKey: 'render-token', ownerId: 'owner-123',
      repositoryUrl: 'https://github.com/acme/demo',
      commitSha: String(index + 1).repeat(40), projectName: 'Static Demo',
      profile: { runtime: 'node', isStatic: true, outputDirectory: config.outputDirectory },
      buildCommand: config.buildCommand,
    }, {
      fetchImpl: async (url, options) => {
        if (url.endsWith('/services')) {
          serviceBody = JSON.parse(options.body);
          return response({ service: { id: `static-${index}` } }, 201);
        }
        if (url.endsWith('/deploys')) return response({ id: `deployment-${index}`, status: 'created' }, 201);
        return response({});
      },
    });
    assert.equal(serviceBody.serviceDetails.publishPath, config.outputDirectory);
    assert.equal(serviceBody.serviceDetails.buildCommand, config.buildCommand);
  }
});

test('rejects unsafe Render static publish paths before creating a service', async () => {
  const noNetwork = async () => assert.fail('Render API must not be called');
  await assert.rejects(createRenderDeployment({
    apiKey: 'render-token', ownerId: 'owner-123',
    repositoryUrl: 'https://github.com/acme/demo', commitSha: 'a'.repeat(40),
    profile: { isStatic: true, outputDirectory: '../outside' },
  }, { fetchImpl: noNetwork }), /Invalid Render static publish directory/);
});

test('deploys, polls and rolls back a Render service', async () => {
  const deployed = await deployRenderService({ apiKey: 'x', serviceId: 'srv-1', commitSha: 'b'.repeat(40) }, {
    fetchImpl: async () => response({ id: 'dep-2', status: 'queued' }, 201),
  });
  assert.equal(deployed.deploymentId, 'dep-2');
  const current = await getRenderDeployment({ apiKey: 'x', serviceId: 'srv-1', deploymentId: 'dep-2' }, {
    fetchImpl: async (url) => url.endsWith('/deploys/dep-2')
      ? response({ id: 'dep-2', status: 'live' })
      : response({ service: { serviceDetails: { url: 'https://demo.onrender.com' } } }),
  });
  assert.equal(current.status, 'live');
  assert.equal(current.providerUrl, 'https://demo.onrender.com');
  const rollback = await rollbackRenderDeployment({ apiKey: 'x', serviceId: 'srv-1', deploymentId: 'dep-old' }, {
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).deployId, 'dep-old');
      return response({ id: 'dep-3', status: 'created' }, 201);
    },
  });
  assert.equal(rollback.deploymentId, 'dep-3');
});

test('creates a DigitalOcean App Platform app and starts its first deployment', async () => {
  const calls = [];
  const result = await createDigitalOceanDeployment({
    accessToken: 'do-token', region: 'nyc', repositoryUrl: 'https://github.com/acme/demo',
    branch: 'main', commitSha: 'c'.repeat(40), projectName: 'Demo App', profile: { runtime: 'node' }, env: { NODE_ENV: 'production' },
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/apps')) return response({ app: { id: 'app-1', live_url: 'https://demo.ondigitalocean.app' } }, 201);
    return response({ deployment: { id: 'do-dep-1', phase: 'PENDING' } }, 201);
  } });
  assert.equal(calls.length, 2);
  const spec = JSON.parse(calls[0].options.body).spec;
  assert.equal(spec.services[0].github.repo, 'acme/demo');
  assert.equal(spec.services[0].github.deploy_on_push, false);
  assert.equal(spec.services[0].envs[0].key, 'NODE_ENV');
  assert.equal(spec.services[0].envs[0].type, 'SECRET');
  assert.equal(result.projectId, 'app-1');
  assert.equal(result.deploymentId, 'do-dep-1');
  assert.equal(result.status, 'queued');
});

test('deploys, polls and rolls back a DigitalOcean app', async () => {
  const deployed = await deployDigitalOceanApp({ accessToken: 'x', appId: 'app-1', commitSha: 'd'.repeat(40), env: { API_KEY: 'secret' } }, {
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') return response({ app: { id: 'app-1', spec: { services: [{ name: 'api', envs: [] }] } } });
      assert.equal(options.method, 'PUT');
      const spec = JSON.parse(options.body).spec;
      assert.equal(spec.services[0].envs[0].key, 'API_KEY');
      return response({ app: { id: 'app-1', in_progress_deployment: { id: 'do-dep-2', phase: 'PENDING', services: [{ source_commit_hash: 'd'.repeat(40) }] } } }, 200);
    },
  });
  assert.equal(deployed.deploymentId, 'do-dep-2');
  assert.equal(deployed.status, 'queued');
  const current = await getDigitalOceanDeployment({ accessToken: 'x', appId: 'app-1', deploymentId: 'do-dep-2' }, {
    fetchImpl: async (url) => url.endsWith('/apps/app-1')
      ? response({ app: { id: 'app-1', live_url: 'https://demo.ondigitalocean.app' } })
      : response({ deployment: { id: 'do-dep-2', phase: 'ACTIVE' } }),
  });
  assert.equal(current.status, 'live');
  assert.equal(current.providerUrl, 'https://demo.ondigitalocean.app');
  const rollback = await rollbackDigitalOceanDeployment({ accessToken: 'x', appId: 'app-1', deploymentId: 'do-old' }, {
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).deployment_id, 'do-old');
      return response({ deployment: { id: 'do-dep-3', phase: 'PENDING' } }, 201);
    },
  });
  assert.equal(rollback.deploymentId, 'do-dep-3');
});

test('rejects malformed GitHub URLs and invalid commit SHAs before calling providers', async () => {
  const noNetwork = async () => assert.fail('Provider API must not be called');
  await assert.rejects(createRenderDeployment({
    apiKey: 'x', ownerId: 'owner-123', repositoryUrl: 'https://gitlab.com/acme/demo', commitSha: 'a'.repeat(40),
  }, { fetchImpl: noNetwork }), /public GitHub repository/);
  await assert.rejects(createDigitalOceanDeployment({
    accessToken: 'x', repositoryUrl: 'https://github.com/acme/demo', commitSha: 'bad',
  }, { fetchImpl: noNetwork }), /verified Git commit SHA/);
});


test('creates a Render Docker service using the configured monorepo root and Docker context', async () => {
  const calls = [];
  const result = await createRenderDeployment({
    apiKey: 'render-token',
    ownerId: 'owner-123',
    repositoryUrl: 'https://github.com/acme/monorepo',
    branch: 'main',
    commitSha: 'e'.repeat(40),
    projectName: 'API Service',
    profile: {
      runtime: 'node',
      isStatic: false,
      needsContainer: true,
      rootDir: 'apps/api',
      dockerfilePath: './Dockerfile',
      dockerContext: '.',
    },
    env: {},
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/services')) return response({
        service: { id: 'srv-docker', serviceDetails: { url: 'https://api.onrender.com' } },
      }, 201);
      return response({ id: 'dep-docker', status: 'created' }, 201);
    },
  });
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.rootDir, 'apps/api');
  assert.equal(body.serviceDetails.runtime, 'docker');
  assert.deepEqual(body.serviceDetails.envSpecificDetails, {
    dockerfilePath: './Dockerfile',
    dockerContext: '.',
  });
  assert.equal(body.serviceDetails.buildCommand, undefined);
  assert.equal(body.serviceDetails.startCommand, undefined);
  assert.equal(result.serviceId, 'srv-docker');
  assert.equal(result.deploymentId, 'dep-docker');
});
