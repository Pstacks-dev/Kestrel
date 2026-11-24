import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlyDeployment, deployFlyApp, getFlyDeployment,
  getFlyDeploymentLogs, rollbackFlyDeployment,
} from '../server/lib/hosting-flyio.mjs';

const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});

function sandboxStub({ exitCode = 0, stdout = 'KESTREL_MACHINE_ID=machine-1\\n' } = {}) {
  const state = { created: null, command: null, deleted: [] };
  return {
    state,
    client: {
      async create(input) {
        state.created = input;
        return { sandbox: { name: input.name, currentSessionId: 'session-1' }, session: { id: 'session-1' } };
      },
      async runCommand(sessionId, input) {
        assert.equal(sessionId, 'session-1');
        state.command = input;
        return { exitCode, stdout, stderr: exitCode ? 'remote builder failed' : '' };
      },
      async delete(name) { state.deleted.push(name); },
    },
  };
}

test('creates a Fly app and deploys the exact Git commit using Fly remote builders in an isolated Vercel sandbox', async () => {
  const calls = [];
  const sandbox = sandboxStub();
  const result = await createFlyDeployment({
    token: 'fly-token', orgSlug: 'personal', projectName: 'kestrel-demo-1234abcd',
    repositoryUrl: 'https://github.com/acme/demo', commitSha: 'a'.repeat(40),
    port: 8080, region: 'lhr', env: { NODE_ENV: 'production', SECRET_VALUE: 'not-in-logs' },
  }, { sandboxClient: sandbox.client, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/apps/kestrel-demo-1234abcd')) return response({}, 404);
    if (url.endsWith('/v1/apps')) return response({ id: 'app-id' }, 201);
    if (url.includes('api.fly.io/graphql')) return response({ data: { allocateIpAddress: { app: { sharedIpAddress: '203.0.113.1' } } } });
    throw new Error(`Unexpected request: ${url}`);
  } });
  assert.equal(result.projectId, 'kestrel-demo-1234abcd');
  assert.equal(result.deploymentId, 'machine-1');
  assert.equal(result.providerUrl, 'https://kestrel-demo-1234abcd.fly.dev');
  assert.equal(sandbox.state.created.source.revision, 'a'.repeat(40));
  assert.equal(sandbox.state.created.source.url, 'https://github.com/acme/demo');
  assert.equal(sandbox.state.command.env.FLY_API_TOKEN, 'fly-token');
  assert.deepEqual(JSON.parse(sandbox.state.command.env.KESTREL_ENV_JSON), { NODE_ENV: 'production', SECRET_VALUE: 'not-in-logs' });
  assert.match(sandbox.state.command.args[1], /flyctl deploy --remote-only/);
  assert.match(sandbox.state.command.args[1], /flyctl secrets import/);
  assert.equal(sandbox.state.deleted.length, 1);
  assert.equal(calls.length, 3);
});

test('reuses an existing Fly app and builds a later immutable commit remotely', async () => {
  const sandbox = sandboxStub({ stdout: 'build output\\nKESTREL_MACHINE_ID=machine-2\\n' });
  const calls = [];
  const result = await deployFlyApp({
    token: 'fly-token', appName: 'kestrel-existing',
    repositoryUrl: 'https://github.com/acme/demo', commitSha: 'b'.repeat(40),
    env: {}, port: 3000,
  }, { sandboxClient: sandbox.client });
  assert.equal(result.deploymentId, 'machine-2');
  assert.equal(sandbox.state.created.source.revision, 'b'.repeat(40));
  assert.equal(calls.length, 0);
});

test('rejects non-GitHub repositories and non-immutable revisions before creating a sandbox', async () => {
  const sandbox = sandboxStub();
  await assert.rejects(createFlyDeployment({
    token: 'x', orgSlug: 'personal', projectName: 'demo',
    repositoryUrl: 'https://gitlab.com/acme/demo', commitSha: 'main',
  }, { sandboxClient: sandbox.client, fetchImpl: async () => assert.fail('Fly API must not be called') }), /public GitHub repository/);
  assert.equal(sandbox.state.created, null);
});

test('cleans up the isolated sandbox when the remote build fails', async () => {
  const sandbox = sandboxStub({ exitCode: 1, stdout: '' });
  await assert.rejects(deployFlyApp({
    token: 'x', appName: 'demo', repositoryUrl: 'https://github.com/acme/demo', commitSha: 'c'.repeat(40),
  }, { sandboxClient: sandbox.client }), /remote source build or deployment failed/);
  assert.equal(sandbox.state.deleted.length, 1);
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
