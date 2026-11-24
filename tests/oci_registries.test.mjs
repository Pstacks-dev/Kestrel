import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { provisionProviderImageRegistry } from '../server/lib/oci-registries.mjs';

const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});
const sha = 'a'.repeat(40);

test('provisions an idempotent Fly registry destination using the verified app token', async () => {
  const calls = [];
  const result = await provisionProviderImageRegistry('flyio', {
    token: 'fly-secret', orgSlug: 'personal',
  }, 'web-app', sha, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/apps/kestrel-web-app')) return response({ name: 'kestrel-web-app', organization: { slug: 'personal' } });
    throw new Error('Unexpected Fly request');
  } });
  assert.equal(result.image, `registry.fly.io/kestrel-web-app:sha-${sha}`);
  assert.equal(result.username, 'x');
  assert.equal(result.password, 'fly-secret');
  assert.equal(calls.length, 1);
});

test('creates Google Artifact Registry repository and returns Docker JSON-key auth', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccountJson = JSON.stringify({
    type: 'service_account', project_id: 'demo-project',
    client_email: 'kestrel@demo-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const calls = [];
  const result = await provisionProviderImageRegistry('google-cloud-run', {
    projectId: 'demo-project', region: 'europe-west1', serviceAccountJson,
  }, 'web-app', sha, { fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url === 'https://oauth2.googleapis.com/token') return response({ access_token: 'google-token' });
    if (url.endsWith('/repositories/kestrel-images')) return response({ error: 'not found' }, 404);
    if (url.includes('repositoryId=kestrel-images')) {
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).format, 'DOCKER');
      return response({ name: 'projects/demo-project/locations/europe-west1/repositories/kestrel-images' }, 200);
    }
    throw new Error(`Unexpected Google request: ${url}`);
  } });
  assert.equal(result.registry, 'europe-west1-docker.pkg.dev');
  assert.equal(result.image, `europe-west1-docker.pkg.dev/demo-project/kestrel-images/web-app:sha-${sha}`);
  assert.equal(result.username, '_json_key');
  assert.equal(result.password, serviceAccountJson);
  assert.equal(calls.length, 3);
});

test('creates immutable ECR repository and obtains short-lived push credentials', async () => {
  const calls = [];
  const token = Buffer.from('AWS:short-lived-password').toString('base64');
  const result = await provisionProviderImageRegistry('aws-ecs-express', {
    accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'aws-secret', region: 'us-east-1',
  }, 'web-app', sha, { fetchImpl: async (url, options) => {
    const target = options.headers['x-amz-target'];
    calls.push(target);
    const body = JSON.parse(options.body);
    if (target.endsWith('.CreateRepository')) {
      assert.equal(body.imageTagMutability, 'IMMUTABLE');
      assert.equal(body.imageScanningConfiguration.scanOnPush, true);
      return response({ repository: { repositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/kestrel/web-app' } });
    }
    if (target.endsWith('.GetAuthorizationToken')) return response({
      authorizationData: [{ authorizationToken: token, proxyEndpoint: 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com' }],
    });
    throw new Error(`Unexpected ECR target: ${target}`);
  } });
  assert.equal(result.registry, '123456789012.dkr.ecr.us-east-1.amazonaws.com');
  assert.equal(result.image, `123456789012.dkr.ecr.us-east-1.amazonaws.com/kestrel/web-app:sha-${sha}`);
  assert.equal(result.username, 'AWS');
  assert.equal(result.password, 'short-lived-password');
  assert.equal(calls.length, 2);
});

test('requires a full immutable commit SHA and rejects unsupported providers', async () => {
  await assert.rejects(provisionProviderImageRegistry('flyio', { token: 'x', orgSlug: 'personal' }, 'demo', 'main'), /full Git commit SHA/);
  await assert.rejects(provisionProviderImageRegistry('render', {}, 'demo', sha), /not supported/);
});
