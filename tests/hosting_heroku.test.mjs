import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHerokuDeployment, deployHerokuApp, getHerokuDeployment,
  getHerokuDeploymentLogs, rollbackHerokuDeployment, configureHerokuFormation,
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
      if (url.endsWith('/formation')) return response([{ type: 'web', quantity: 1, dyno_size: { name: 'basic' } }]);
      return response({ id: 'app-1', status: 'active', web_url: 'https://demo.herokuapp.com' });
    },
  });
  assert.equal(result.status, 'live');
  assert.equal(result.providerUrl, 'https://demo.herokuapp.com');
});

test('applies an approved Heroku dyno size and quantity through the formation API', async () => {
  const calls = [];
  const result = await configureHerokuFormation({
    apiKey: 'heroku-token', appId: 'app-1', dynoSize: 'standard-1x', dynoQuantity: 2,
  }, {
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === 'PATCH') return response([{ type: 'web', quantity: 2, dyno_size: { name: 'standard-1x' } }]);
      return response([{ type: 'web', quantity: 1, dyno_size: { name: 'basic' } }]);
    },
  });
  assert.equal(result.configured, true);
  assert.equal(result.changed, true);
  assert.equal(calls[0].url, 'https://api.heroku.com/apps/app-1/formation');
  assert.equal(calls[1].url, 'https://api.heroku.com/apps/app-1/formation/web');
  assert.equal(calls[1].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    dyno_size: { name: 'standard-1x' }, quantity: 2,
  });
});

test('does not claim a Heroku deployment is live when the approved formation is not applied', async () => {
  const result = await getHerokuDeployment({
    apiKey: 'x', appId: 'app-1', deploymentId: 'build-1',
    dynoSize: 'standard-1x', dynoQuantity: 2,
  }, {
    fetchImpl: async (url) => {
      if (url.endsWith('/builds/build-1')) return response({ id: 'build-1', status: 'succeeded', release: { id: 'release-1' } });
      if (url.endsWith('/formation')) return response([{ type: 'web', quantity: 1, dyno_size: { name: 'basic' } }]);
      return response({ id: 'app-1', status: 'active', web_url: 'https://demo.herokuapp.com' });
    },
  });
  assert.equal(result.status, 'deploying');
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
      assert.deepEqual(JSON.parse(options.body), { release: 'release-old' });
      return response({ id: 'release-rollback' }, 201);
    },
  });
  assert.equal(rollback.deploymentId, 'release-rollback');
});

test('rejects invalid source URLs and commit SHAs before creating Heroku resources', async () => {
  const noNetwork = async () => assert.fail('Heroku API must not be called');
  await assert.rejects(createHerokuDeployment({
    apiKey: 'x', repositoryUrl: 'https://gitlab.com/acme/demo', commitSha: 'a'.repeat(40),
  }, { fetchImpl: noNetwork }), /GitHub repository URL/);
  await assert.rejects(deployHerokuApp({
    apiKey: 'x', appId: 'app-1', repositoryUrl: 'https://github.com/acme/demo', commitSha: 'bad',
  }, { fetchImpl: noNetwork }), /verified Git commit SHA/);
});


test('resolves private GitHub source archives through a short-lived signed codeload URL', async () => {
  const { resolveHerokuSourceArchiveUrl } = await import('../server/lib/hosting-heroku.mjs');
  const commitSha = 'a'.repeat(40);
  let request;
  const url = await resolveHerokuSourceArchiveUrl({
    repositoryUrl: 'https://github.com/acme/private-app',
    commitSha,
    installationToken: 'short-lived-installation-token',
    fetchImpl: async (input, options) => {
      request = { input, options };
      return new Response(null, {
        status: 302,
        headers: { location: `https://codeload.github.com/acme/private-app/legacy.tar.gz/${commitSha}?token=signed-temporary-token` },
      });
    },
  });
  assert.equal(url, `https://codeload.github.com/acme/private-app/legacy.tar.gz/${commitSha}?token=signed-temporary-token`);
  assert.equal(request.options.headers.authorization, 'Bearer short-lived-installation-token');
  assert.equal(request.options.redirect, 'manual');
  assert.ok(request.input.includes(commitSha));
});

test('uses the public archive URL for public repositories without an installation token', async () => {
  const { resolveHerokuSourceArchiveUrl } = await import('../server/lib/hosting-heroku.mjs');
  const commitSha = 'b'.repeat(40);
  const url = await resolveHerokuSourceArchiveUrl({
    repositoryUrl: 'https://github.com/acme/public-app',
    commitSha,
    fetchImpl: async () => assert.fail('Public source should not require a GitHub API token'),
  });
  assert.equal(url, `https://github.com/acme/public-app/archive/${commitSha}.tar.gz`);
});

test('rejects untrusted or mismatched private source archive redirects', async () => {
  const { resolveHerokuSourceArchiveUrl } = await import('../server/lib/hosting-heroku.mjs');
  const commitSha = 'c'.repeat(40);
  await assert.rejects(resolveHerokuSourceArchiveUrl({
    repositoryUrl: 'https://github.com/acme/private-app',
    commitSha,
    installationToken: 'token',
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/archive.tar.gz' } }),
  }), /invalid signed source archive URL/i);
});


test('passes a signed private-repository archive URL to the Heroku build API', async () => {
  const sourceArchiveUrl = `https://codeload.github.com/acme/private-app/legacy.tar.gz/${'d'.repeat(40)}?token=signed-temporary-token`;
  await deployHerokuApp({
    apiKey: 'heroku-token', appId: 'app-1',
    repositoryUrl: 'https://github.com/acme/private-app',
    commitSha: 'd'.repeat(40), sourceArchiveUrl,
  }, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(url, 'https://api.heroku.com/apps/app-1/builds');
      assert.equal(body.source_blob.url, sourceArchiveUrl);
      assert.equal(body.source_blob.version, 'd'.repeat(40));
      return response({ id: 'build-private-1', status: 'pending' }, 201);
    },
  });
});


test('syncs Heroku environment variables and removes only previously managed keys', async () => {
  const { syncHerokuEnvironment } = await import('../server/lib/hosting-heroku.mjs');
  let body;
  const result = await syncHerokuEnvironment({
    apiKey: 'heroku-token', appId: 'app-1',
    env: { DATABASE_URL: 'postgres://example', NODE_ENV: 'production' },
    managedEnvKeys: ['DATABASE_URL', 'OLD_SECRET', 'UNMANAGED_KEY'],
  }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.heroku.com/apps/app-1/config-vars');
      assert.equal(options.method, 'PATCH');
      body = JSON.parse(options.body);
      return response({ DATABASE_URL: 'postgres://example', NODE_ENV: 'production' });
    },
  });
  assert.deepEqual(body, {
    DATABASE_URL: 'postgres://example',
    NODE_ENV: 'production',
    OLD_SECRET: null,
    UNMANAGED_KEY: null,
  });
  assert.deepEqual(result, { updated: true, keys: ['DATABASE_URL', 'NODE_ENV'] });
});

test('does not call Heroku when no environment values or previously managed keys exist', async () => {
  const { syncHerokuEnvironment } = await import('../server/lib/hosting-heroku.mjs');
  const result = await syncHerokuEnvironment({ apiKey: 'x', appId: 'app-1' }, {
    fetchImpl: async () => assert.fail('No config-vars update is needed'),
  });
  assert.deepEqual(result, { updated: false, keys: [] });
});

test('deletes a newly created Heroku app if its build fails', async () => {
  const calls = [];
  await assert.rejects(createHerokuDeployment({
    apiKey: 'heroku-token', repositoryUrl: 'https://github.com/acme/demo',
    commitSha: 'e'.repeat(40), projectName: 'kestrel-cleanup-12345678',
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/apps') && options.method === 'POST') {
        return response({ id: 'app-cleanup', name: 'kestrel-cleanup-12345678' }, 201);
      }
      if (url.endsWith('/builds')) return response({ error: 'build rejected' }, 500);
      if (url.endsWith('/apps/app-cleanup') && options.method === 'DELETE') return response({}, 200);
      return response({});
    },
  }), /Heroku API request failed/);
  assert.ok(calls.some(call => call.url.endsWith('/apps/app-cleanup') && call.options.method === 'DELETE'));
});
