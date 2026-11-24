import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHerokuDeployment, deployHerokuApp, getHerokuDeployment,
  getHerokuDeploymentLogs, rollbackHerokuDeployment,
} from '../server/lib/hosting-heroku.mjs';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('creates a Heroku app and builds the exact public GitHub commit archive', async () => {
  const calls = [];
  const result = await createHerokuDeployment({
    apiKey: 'heroku-token', repositoryUrl: 'https://github.com/acme/demo.git',
    branch: 'main', commitSha: 'a'.repeat(40), projectName: 'Kestrel Demo 12345678',
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/apps')) return response({ id: 'app-1', name: 'kestrel-demo-12345678', web_url: 'https://kestrel-demo-12345678.herokuapp.com' }, 201);
    return response({ id: 'build-1', status: 'pending' }, 201);
  } });
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].options.body).stack, 'heroku-24');
  const build = JSON.parse(calls[1].options.body);
  assert.equal(build.source_blob.version, 'a'.repeat(40));
  assert.equal(build.source_blob.url, `https://github.com/acme/demo/archive/${'a'.repeat(40)}.tar.gz`);
  assert.equal(result.projectId, 'app-1');
  assert.equal(result.deploymentId, 'build-1');
  assert.equal(result.status, 'queued');
});

test('builds later commits in the existing Heroku app', async () => {
  const result = await deployHerokuApp({
    apiKey: 'heroku-token', appId: 'app-1', repositoryUrl: 'https://github.com/acme/demo', commitSha: 'b'.repeat(40),
  }, { fetchImpl: async (url, options) => {
    assert.equal(url.endsWith('/apps/app-1/builds'), true);
    assert.equal(JSON.parse(options.body).source_blob.version, 'b'.repeat(40));
    return response({ id: 'build-2', status: 'pending' }, 201);
  } });
  assert.equal(result.deploymentId, 'build-2');
});

test('reports live only when the successful build has an active web formation', async () => {
  const result = await getHerokuDeployment({ apiKey: 'x', appId: 'app-1', deploymentId: 'build-1' }, {
    fetchImpl: async (url) => {
      if (url.endsWith('/builds/build-1')) return response({ id: 'build-1', status: 'succeeded', release: { id: 'release-1' } });
      if (url.endsWith('/formation')) return response([{ type: 'web', quantity: 1 }]);
      return response({ id: 'app-1', status: 'active', web_url: 'https://demo.herokuapp.com' });
    },
  });
  assert.equal(result.status, 'live');
  assert.equal(result.providerUrl, 'https://demo.herokuapp.com');
});

test('retrieves Heroku build output and rolls back to a previous release', async () => {
  const logs = await getHerokuDeploymentLogs({ apiKey: 'x', appId: 'app-1', deploymentId: 'build-1' }, {
    fetchImpl: async (url) => url.includes('/builds/build-1')
      ? response({ output_stream_url: 'https://logs.heroku.example/signed' })
      : new Response('-----> Build started\n-----> Build succeeded\n'),
  });
  assert.equal(logs.build.length, 2);
  assert.equal(logs.build[1].message, '-----> Build succeeded');

  const rollback = await rollbackHerokuDeployment({ apiKey: 'x', appId: 'app-1', deploymentId: 'build-old' }, {
    fetchImpl: async (url, options) => {
      if (url.endsWith('/builds/build-old')) return response({ id: 'build-old', status: 'succeeded', release: { id: 'release-old' } });
      assert.equal(url.endsWith('/apps/app-1/releases'), true);
      assert.deepEqual(JSON.parse(options.body), { rollback: { release: 'release-old' } });
      return response({ id: 'release-rollback' }, 201);
    },
  });
  assert.equal(rollback.deploymentId, 'release-rollback');
});

test('rejects invalid source URLs and commit SHAs before creating Heroku resources', async () => {
  const noNetwork = async () => assert.fail('Heroku API must not be called');
  await assert.rejects(createHerokuDeployment({
    apiKey: 'x', repositoryUrl: 'https://gitlab.com/acme/demo', commitSha: 'a'.repeat(40),
  }, { fetchImpl: noNetwork }), /public GitHub repository/);
  await assert.rejects(deployHerokuApp({
    apiKey: 'x', appId: 'app-1', repositoryUrl: 'https://github.com/acme/demo', commitSha: 'bad',
  }, { fetchImpl: noNetwork }), /verified Git commit SHA/);
});
