import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRailwayDeployment, deployRailwayService, getRailwayDeployment,
  getRailwayDeploymentLogs, rollbackRailwayDeployment,
} from '../server/lib/hosting-railway.mjs';

function response(data) {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('creates a Railway project, GitHub service and deployment for the exact commit', async () => {
  const calls = [];
  const responses = [
    { projectCreate: { id: 'project-1', name: 'Demo' } },
    { project: { id: 'project-1', environments: { edges: [{ node: { id: 'env-1', name: 'production' } }] } } },
    { serviceCreate: { id: 'service-1', name: 'Demo API' } },
    { variableCollectionUpsert: true },
    { serviceInstanceDeployV2: 'deployment-1' },
  ];
  const result = await createRailwayDeployment({
    token: 'railway-test-token', repositoryUrl: 'https://github.com/acme/demo.git',
    branch: 'main', commitSha: 'a'.repeat(40), projectName: 'Demo', serviceName: 'Demo API',
    workspaceId: 'workspace-1', env: { DATABASE_URL: 'postgres://secret' },
  }, {
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      assert.equal(options.headers.Authorization, 'Bearer railway-test-token');
      return response(responses[calls.length - 1]);
    },
  });
  assert.equal(calls.length, 5);
  assert.equal(calls[0].variables.input.workspaceId, 'workspace-1');
  assert.deepEqual(calls[2].variables.input.source, { repo: 'acme/demo' });
  assert.equal(calls[2].variables.input.branch, 'main');
  assert.equal(calls[3].query.includes('variableCollectionUpsert'), true);
  assert.equal(calls[3].variables.input.variables.DATABASE_URL, 'postgres://secret');
  assert.equal(calls[3].variables.input.skipDeploys, true);
  assert.equal(calls[4].variables.commitSha, 'a'.repeat(40));
  assert.equal(result.deploymentId, 'deployment-1');
  assert.equal(result.status, 'queued');
});

test('rejects invalid repository URLs, branch names and commit SHAs before network access', async () => {
  const noNetwork = async () => assert.fail('Railway API must not be called');
  await assert.rejects(createRailwayDeployment({
    token: 'x', repositoryUrl: 'https://gitlab.com/acme/demo', commitSha: 'a'.repeat(40), projectName: 'Demo',
  }, { fetchImpl: noNetwork }), /valid GitHub repository/);
  await assert.rejects(createRailwayDeployment({
    token: 'x', repositoryUrl: 'https://github.com/acme/demo', branch: '../main', commitSha: 'a'.repeat(40), projectName: 'Demo',
  }, { fetchImpl: noNetwork }), /Invalid deployment branch/);
  await assert.rejects(createRailwayDeployment({
    token: 'x', repositoryUrl: 'https://github.com/acme/demo', commitSha: 'not-a-sha', projectName: 'Demo',
  }, { fetchImpl: noNetwork }), /verified Git commit SHA/);
});

test('normalizes Railway deployment status and returns the provider URL', async () => {
  const result = await getRailwayDeployment({ token: 'x', deploymentId: 'deployment-1' }, {
    fetchImpl: async () => response({ deployment: {
      id: 'deployment-1', status: 'SUCCESS', url: 'https://demo.up.railway.app',
      canRollback: true, canRedeploy: true, createdAt: '2026-11-24T00:00:00Z',
    } }),
  });
  assert.equal(result.status, 'live');
  assert.equal(result.providerUrl, 'https://demo.up.railway.app');
  assert.equal(result.canRollback, true);
});

test('retrieves bounded build and runtime logs from Railway', async () => {
  const result = await getRailwayDeploymentLogs({ token: 'x', deploymentId: 'deployment-1', limit: 50000 }, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.variables.limit, 1000);
      return response(body.query.includes('BuildLogs')
        ? { buildLogs: [{ message: 'build complete' }] }
        : { deploymentLogs: [{ message: 'server ready' }] });
    },
  });
  assert.equal(result.build[0].message, 'build complete');
  assert.equal(result.runtime[0].message, 'server ready');
});

test('rolls back only deployments Railway marks as rollback-capable', async () => {
  const calls = [];
  const result = await rollbackRailwayDeployment({ token: 'x', deploymentId: 'old-deployment' }, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.query);
      return body.query.includes('GetDeployment')
        ? response({ deployment: { id: 'old-deployment', status: 'SUCCESS', canRollback: true } })
        : response({ deploymentRollback: { id: 'rollback-1', status: 'DEPLOYING' } });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.deploymentId, 'rollback-1');
  assert.equal(result.status, 'deploying');
});

test('deploys new commits to an existing Railway service without creating duplicate projects', async () => {
  const requests = [];
  const result = await deployRailwayService({
    token: 'railway-token', projectId: 'project-1', serviceId: 'service-1', environmentId: 'env-1', commitSha: 'b'.repeat(40), env: { API_KEY: 'secret' },
  }, {
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body); requests.push(request);
      return response(request.query.includes('variableCollectionUpsert') ? { variableCollectionUpsert: true } : { serviceInstanceDeployV2: 'deployment-2' });
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].query.includes('variableCollectionUpsert'), true);
  assert.equal(requests[0].variables.input.variables.API_KEY, 'secret');
  assert.equal(requests[1].query.includes('serviceInstanceDeployV2'), true);
  assert.equal(requests[1].variables.serviceId, 'service-1');
  assert.equal(requests[1].variables.environmentId, 'env-1');
  assert.equal(result.deploymentId, 'deployment-2');
});


test('configures a Railway service root directory before deploying a nested monorepo commit', async () => {
  const calls = [];
  const responses = [
    { projectCreate: { id: 'project-2', name: 'Monorepo' } },
    { project: { id: 'project-2', environments: { edges: [{ node: { id: 'env-2', name: 'production' } }] } } },
    { serviceCreate: { id: 'service-2', name: 'API' } },
    { serviceInstanceUpdate: true },
    { serviceInstanceDeployV2: 'deployment-2' },
  ];
  const result = await createRailwayDeployment({
    token: 'railway-token',
    repositoryUrl: 'https://github.com/acme/monorepo',
    branch: 'main',
    commitSha: 'c'.repeat(40),
    projectName: 'Monorepo',
    serviceName: 'API',
    profile: { rootDir: 'apps/api', needsContainer: true, dockerfilePath: './Dockerfile' },
    env: {},
  }, {
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      return response(responses[calls.length - 1]);
    },
  });
  assert.equal(calls.length, 5);
  assert.equal(calls[3].query.includes('serviceInstanceUpdate'), true);
  assert.deepEqual(calls[3].variables.input, { rootDirectory: '/apps/api' });
  assert.equal(calls[4].query.includes('serviceInstanceDeployV2'), true);
  assert.equal(result.deploymentId, 'deployment-2');
});

test('updates an existing Railway service root directory before deploying', async () => {
  const calls = [];
  const result = await deployRailwayService({
    token: 'railway-token',
    projectId: 'project-1',
    serviceId: 'service-1',
    environmentId: 'env-1',
    commitSha: 'd'.repeat(40),
    profile: { rootDir: '.' },
    env: {},
  }, {
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      return response(request.query.includes('serviceInstanceUpdate')
        ? { serviceInstanceUpdate: true }
        : { serviceInstanceDeployV2: 'deployment-3' });
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].variables.input, { rootDirectory: null });
  assert.equal(calls[1].query.includes('serviceInstanceDeployV2'), true);
  assert.equal(result.deploymentId, 'deployment-3');
});
