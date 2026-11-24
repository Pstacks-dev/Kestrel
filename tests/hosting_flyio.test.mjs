import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlyDeployment, deployFlyApp, getFlyDeployment,
  getFlyDeploymentLogs, rollbackFlyDeployment,
} from '../server/lib/hosting-flyio.mjs';

const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});

test('creates an app, allocates public routing and launches a Machine from an OCI image', async () => {
  const calls = [];
  const result = await createFlyDeployment({
    token: 'fly-token', orgSlug: 'personal', projectName: 'kestrel-demo-1234abcd',
    containerImage: 'ghcr.io/acme/demo:sha-a1b2c3d4', port: 8080, region: 'lhr',
    env: { NODE_ENV: 'production' }, memoryMb: 1024,
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/apps/kestrel-demo-1234abcd')) return response({}, 404);
    if (url.endsWith('/v1/apps')) return response({ id: 'app-id' }, 201);
    if (url.includes('api.fly.io/graphql')) return response({ data: { allocateIpAddress: { app: { sharedIpAddress: '203.0.113.1' } } } });
    if (url.endsWith('/machines')) {
      const body = JSON.parse(options.body);
      assert.equal(body.region, 'lhr');
      assert.equal(body.config.image, 'ghcr.io/acme/demo:sha-a1b2c3d4');
      assert.equal(body.config.services[0].internal_port, 8080);
      assert.equal(body.config.env.NODE_ENV, 'production');
      assert.equal(body.config.guest.memory_mb, 1024);
      return response({ id: 'machine-1', state: 'created' }, 200);
    }
    throw new Error(`Unexpected request: ${url}`);
  } });
  assert.equal(result.projectId, 'kestrel-demo-1234abcd');
  assert.equal(result.deploymentId, 'machine-1');
  assert.equal(result.providerUrl, 'https://kestrel-demo-1234abcd.fly.dev');
  assert.equal(calls.length, 4);
});

test('reuses an existing Fly app for retry-safe deployment creation', async () => {
  const calls = [];
  await createFlyDeployment({
    token: 'fly-token', orgSlug: 'personal', projectName: 'kestrel-existing',
    containerImage: 'ghcr.io/acme/demo:latest',
  }, { fetchImpl: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/apps/kestrel-existing')) return response({ name: 'kestrel-existing', organization: { slug: 'personal' } });
    if (url.includes('graphql')) return response({ data: { allocateIpAddress: { app: { sharedIpAddress: '203.0.113.2' } } } });
    if (url.endsWith('/machines')) return response({ id: 'machine-2', state: 'created' });
    throw new Error(`Unexpected request: ${url}`);
  } });
  assert.equal(calls.some((url) => url.endsWith('/v1/apps')), false);
});

test('polls Machine state and stops older running Machines after replacement is started', async () => {
  const stopped = [];
  const result = await getFlyDeployment({ token: 'x', appName: 'demo', deploymentId: 'new-machine' }, {
    fetchImpl: async (url, options) => {
      if (url.endsWith('/machines/new-machine')) return response({ id: 'new-machine', state: 'started' });
      if (url.endsWith('/machines')) return response([{ id: 'old-machine', state: 'started' }, { id: 'new-machine', state: 'started' }]);
      if (url.endsWith('/old-machine/stop')) { stopped.push(url); return response({}); }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  assert.equal(result.status, 'live');
  assert.equal(result.canRollback, true);
  assert.equal(stopped.length, 1);
});

test('returns Fly lifecycle events as runtime diagnostics without claiming stdout access', async () => {
  const logs = await getFlyDeploymentLogs({ token: 'x', appName: 'demo', deploymentId: 'machine-1' }, {
    fetchImpl: async () => response({ events: [{ type: 'launch', status: 'succeeded', source: 'user', timestamp: '2026-11-24T00:00:00Z' }] }),
  });
  assert.equal(logs.runtime.length, 1);
  assert.equal(logs.unavailable, true);
  assert.match(logs.message, /log drain/);
});

test('rolls back by restarting a previous Machine and stopping the current one', async () => {
  const stopped = [];
  const result = await rollbackFlyDeployment({ token: 'x', appName: 'demo', deploymentId: 'old-machine' }, {
    fetchImpl: async (url, options) => {
      if (url.endsWith('/machines/old-machine')) return response({ id: 'old-machine', state: 'stopped' });
      if (url.endsWith('/old-machine/start')) return response({ id: 'old-machine', state: 'started' });
      if (url.endsWith('/machines')) return response([{ id: 'old-machine', state: 'started' }, { id: 'new-machine', state: 'started' }]);
      if (url.endsWith('/new-machine/stop')) { stopped.push(url); return response({}); }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  assert.equal(result.deploymentId, 'old-machine');
  assert.equal(stopped.length, 1);
});

test('rejects invalid OCI image references before creating Fly resources', async () => {
  await assert.rejects(createFlyDeployment({
    token: 'x', orgSlug: 'personal', projectName: 'demo', containerImage: 'not-an-image',
  }, { fetchImpl: async () => assert.fail('Fly API must not be called') }), /published OCI image/);
});
