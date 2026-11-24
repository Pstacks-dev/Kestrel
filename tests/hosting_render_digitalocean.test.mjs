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
    branch: 'main', commitSha: 'a'.repeat(40), projectName: 'Demo App', profile: { runtime: 'node', isStatic: false },
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST' && url.endsWith('/services')) return response({ service: { id: 'srv-1', serviceDetails: { url: 'https://demo.onrender.com' } } }, 201);
    return response({ id: 'dep-1', status: 'created' }, 201);
  } });
  assert.equal(calls.length, 2);
  const service = JSON.parse(calls[0].options.body);
  assert.equal(service.autoDeployTrigger, 'off');
  assert.equal(service.repo, 'https://github.com/acme/demo');
  assert.equal(JSON.parse(calls[1].options.body).commitId, 'a'.repeat(40));
  assert.equal(result.serviceId, 'srv-1');
  assert.equal(result.deploymentId, 'dep-1');
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
    branch: 'main', commitSha: 'c'.repeat(40), projectName: 'Demo App', profile: { runtime: 'node' },
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/apps')) return response({ app: { id: 'app-1', live_url: 'https://demo.ondigitalocean.app' } }, 201);
    return response({ deployment: { id: 'do-dep-1', phase: 'PENDING' } }, 201);
  } });
  assert.equal(calls.length, 2);
  const spec = JSON.parse(calls[0].options.body).spec;
  assert.equal(spec.services[0].github.repo, 'acme/demo');
  assert.equal(spec.services[0].github.deploy_on_push, false);
  assert.equal(result.projectId, 'app-1');
  assert.equal(result.deploymentId, 'do-dep-1');
});

test('deploys, polls and rolls back a DigitalOcean app', async () => {
  const deployed = await deployDigitalOceanApp({ accessToken: 'x', appId: 'app-1', commitSha: 'd'.repeat(40) }, {
    fetchImpl: async () => response({ deployment: { id: 'do-dep-2', phase: 'PENDING' } }, 201),
  });
  assert.equal(deployed.deploymentId, 'do-dep-2');
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
