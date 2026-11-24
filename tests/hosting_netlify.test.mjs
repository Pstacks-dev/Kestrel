import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createNetlifyDeployment, deployNetlifySite, getNetlifyDeployment,
  getNetlifyDeploymentLogs, rollbackNetlifyDeployment,
} from '../server/lib/hosting-netlify.mjs';

const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});

const file = (path, content) => ({ path, content: Buffer.from(content).toString('base64') });

test('creates a Netlify site and uploads only files requested by the digest API', async () => {
  const calls = [];
  const result = await createNetlifyDeployment({
    authToken: 'netlify-token', projectName: 'Kestrel Demo 1234',
    branch: 'main', commitSha: 'a'.repeat(40),
    files: [file('index.html', '<h1>Hello</h1>'), file('assets/site.css', 'body{}')],
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/sites')) return response({ id: 'site-1', name: 'kestrel-demo-1234', url: 'https://kestrel-demo-1234.netlify.app' }, 201);
    if (url.endsWith('/sites/site-1/deploys')) {
      const body = JSON.parse(options.body);
      assert.equal(body.branch, 'main');
      assert.equal(body.commit_sha, 'a'.repeat(40));
      assert.equal(body.files['index.html'], crypto.createHash('sha1').update('<h1>Hello</h1>').digest('hex'));
      return response({ id: 'deploy-1', state: 'uploading', required: ['index.html'] }, 201);
    }
    assert.equal(url.endsWith('/deploys/deploy-1/files/index.html'), true);
    assert.equal(options.method, 'PUT');
    assert.equal(Buffer.from(options.body).toString(), '<h1>Hello</h1>');
    return response({}, 200);
  } });
  assert.equal(calls.length, 3);
  assert.equal(result.projectId, 'site-1');
  assert.equal(result.deploymentId, 'deploy-1');
  assert.equal(result.providerUrl, 'https://kestrel-demo-1234.netlify.app');
});

test('creates later Netlify deployments against the existing site', async () => {
  const result = await deployNetlifySite({
    authToken: 'x', siteId: 'site-1', files: [file('index.html', 'new version')],
  }, { fetchImpl: async (url, options) => {
    assert.equal(url.endsWith('/sites/site-1/deploys'), true);
    assert.equal(JSON.parse(options.body).files['index.html'], crypto.createHash('sha1').update('new version').digest('hex'));
    return response({ id: 'deploy-2', state: 'enqueued', required: [] }, 201);
  } });
  assert.equal(result.deploymentId, 'deploy-2');
});

test('polls Netlify deployment state and URL', async () => {
  const result = await getNetlifyDeployment({ authToken: 'x', deploymentId: 'deploy-1' }, {
    fetchImpl: async () => response({ id: 'deploy-1', state: 'ready', ssl_url: 'https://demo.netlify.app' }),
  });
  assert.equal(result.status, 'live');
  assert.equal(result.canRollback, true);
  assert.equal(result.providerUrl, 'https://demo.netlify.app');
});

test('returns Netlify build logs when a build exists and a clear message for direct uploads', async () => {
  const logs = await getNetlifyDeploymentLogs({ authToken: 'x', deploymentId: 'deploy-1' }, {
    fetchImpl: async (url) => url.endsWith('/deploys/deploy-1')
      ? response({ build_id: 'build-1' })
      : new Response('Build started\nBuild complete\n'),
  });
  assert.equal(logs.build.length, 2);

  const direct = await getNetlifyDeploymentLogs({ authToken: 'x', deploymentId: 'deploy-2' }, {
    fetchImpl: async () => response({ id: 'deploy-2', state: 'ready' }),
  });
  assert.equal(direct.unavailable, true);
});

test('restores a previous Netlify deploy', async () => {
  const result = await rollbackNetlifyDeployment({ authToken: 'x', siteId: 'site-1', deploymentId: 'deploy-old' }, {
    fetchImpl: async (url, options) => {
      assert.equal(url.endsWith('/sites/site-1/deploys/deploy-old/restore'), true);
      assert.equal(options.method, 'POST');
      return response({ id: 'deploy-restore', state: 'enqueued' }, 201);
    },
  });
  assert.equal(result.deploymentId, 'deploy-restore');
});

test('rejects unsafe artifact paths and empty file manifests', async () => {
  await assert.rejects(createNetlifyDeployment({
    authToken: 'x', projectName: 'demo', files: [file('../secret', 'bad')],
  }, { fetchImpl: async () => assert.fail('Netlify must not be called') }), /Invalid static artifact path/);
  await assert.rejects(deployNetlifySite({
    authToken: 'x', siteId: 'site-1', files: [],
  }, { fetchImpl: async () => assert.fail('Netlify must not be called') }), /between 1 and 5000/);
});
