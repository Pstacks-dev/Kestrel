import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVercelDeployment, deployVercelProject, getVercelDeployment,
  getVercelDeploymentLogs, rollbackVercelDeployment,
} from '../server/lib/hosting-vercel.mjs';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('creates a Git-connected Vercel project and deploys the exact Git commit', async () => {
  const calls = [];
  const result = await createVercelDeployment({
    token: 'vercel-token', teamId: 'team-1', repositoryUrl: 'https://github.com/acme/demo.git',
    branch: 'main', commitSha: 'a'.repeat(40), projectName: 'Demo App', profile: { framework: 'nextjs' },
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/v9/projects/')) return response({ error: { code: 'not_found' } }, 404);
    if (url.includes('/v11/projects')) return response({ id: 'prj-1', name: 'demo-app' }, 200);
    return response({ id: 'dpl-1', url: 'demo-app-abc.vercel.app', readyState: 'BUILDING' }, 200);
  } });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.endsWith('?teamId=team-1'), true);
  const project = JSON.parse(calls[1].options.body);
  assert.deepEqual(project.gitRepository, { type: 'github', repo: 'acme/demo' });
  assert.equal(project.gitProviderOptions.createDeployments, 'disabled');
  assert.equal(project.gitProviderOptions.disableRepositoryDispatchEvents, true);
  const deployment = JSON.parse(calls[2].options.body);
  assert.equal(deployment.project, 'prj-1');
  assert.equal(deployment.gitSource.sha, 'a'.repeat(40));
  assert.equal(deployment.gitSource.ref, 'main');
  assert.equal(calls[2].url.includes('&teamId=team-1'), true);
  assert.equal(result.projectId, 'prj-1');
  assert.equal(result.deploymentId, 'dpl-1');
  assert.equal(result.status, 'deploying');
});

test('deploys later commits to the existing Vercel project', async () => {
  const result = await deployVercelProject({
    token: 'vercel-token', projectId: 'prj-1', projectName: 'demo-app',
    repositoryUrl: 'https://github.com/acme/demo', branch: 'release',
    commitSha: 'b'.repeat(40), profile: { framework: 'nextjs' },
  }, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.project, 'prj-1');
    assert.equal(body.gitSource.sha, 'b'.repeat(40));
    return response({ id: 'dpl-2', readyState: 'QUEUED', url: 'demo-preview.vercel.app' });
  } });
  assert.equal(result.deploymentId, 'dpl-2');
  assert.equal(result.status, 'queued');
});

test('polls Vercel status, retrieves build events and redeploys a prior deployment', async () => {
  const current = await getVercelDeployment({ token: 'x', teamId: 'team-1', deploymentId: 'dpl-1' }, {
    fetchImpl: async (url) => {
      assert.equal(url.includes('teamId=team-1'), true);
      return response({ id: 'dpl-1', readyState: 'READY', url: 'demo.vercel.app' });
    },
  });
  assert.equal(current.status, 'live');
  assert.equal(current.providerUrl, 'https://demo.vercel.app');

  const logs = await getVercelDeploymentLogs({ token: 'x', deploymentId: 'dpl-1', limit: 2000 }, {
    fetchImpl: async (url) => {
      assert.equal(url.includes('limit=1000'), true);
      return response([{ type: 'command', created: 123, payload: { text: 'Build completed' } }]);
    },
  });
  assert.equal(logs.build[0].message, 'Build completed');

  const rollback = await rollbackVercelDeployment({
    token: 'x', projectId: 'prj-1', projectName: 'demo-app', deploymentId: 'dpl-previous',
  }, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.deploymentId, 'dpl-previous');
    assert.equal(body.project, 'prj-1');
    return response({ id: 'dpl-rollback', readyState: 'QUEUED' });
  } });
  assert.equal(rollback.deploymentId, 'dpl-rollback');
  assert.equal(rollback.status, 'queued');
});

test('rejects invalid GitHub URLs and unverified commit SHAs before provider calls', async () => {
  const noNetwork = async () => assert.fail('Vercel API must not be called');
  await assert.rejects(createVercelDeployment({
    token: 'x', repositoryUrl: 'https://gitlab.com/acme/demo', commitSha: 'a'.repeat(40),
  }, { fetchImpl: noNetwork }), /public GitHub repository/);
  await assert.rejects(deployVercelProject({
    token: 'x', projectId: 'prj-1', projectName: 'demo', repositoryUrl: 'https://github.com/acme/demo', commitSha: 'bad',
  }, { fetchImpl: noNetwork }), /verified Git commit SHA/);
});


test('syncs encrypted Kestrel project secrets to Vercel before deployment', async () => {
  const calls = [];
  const result = await deployVercelProject({
    token: 'vercel-token', projectId: 'prj-1', projectName: 'demo-app',
    repositoryUrl: 'https://github.com/acme/demo', branch: 'main',
    commitSha: 'c'.repeat(40), env: { DATABASE_URL: 'postgres://secret' },
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/v10/projects/prj-1/env')) {
      const body = JSON.parse(options.body);
      assert.equal(body.key, 'DATABASE_URL');
      assert.equal(body.value, 'postgres://secret');
      assert.equal(body.type, 'sensitive');
      assert.equal(body.visibility, 'secret');
      assert.deepEqual(body.target, ['production', 'preview', 'development']);
      return response({ created: { id: 'env-1' } });
    }
    return response({ id: 'dpl-env', readyState: 'BUILDING' });
  } });
  assert.equal(calls.length, 2);
  assert.equal(result.deploymentId, 'dpl-env');
});

test('disables native Git auto-deploys on an existing Vercel project before Kestrel-controlled deployment', async () => {
  const calls = [];
  await createVercelDeployment({
    token: 'vercel-token', teamId: 'team-1', repositoryUrl: 'https://github.com/acme/demo',
    branch: 'main', commitSha: 'c'.repeat(40), projectName: 'demo-app',
  }, { fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/v9/projects/demo-app')) return response({ id: 'prj-existing', link: { repo: 'acme/demo' } });
    if (url.includes('/v9/projects/prj-existing')) {
      assert.equal(options.method, 'PATCH');
      const body = JSON.parse(options.body);
      assert.equal(body.gitProviderOptions.createDeployments, 'disabled');
      assert.equal(body.gitProviderOptions.disableRepositoryDispatchEvents, true);
      return response({ id: 'prj-existing' });
    }
    return response({ id: 'dpl-existing', readyState: 'BUILDING' });
  } });
  assert.equal(calls.length, 3);
});
