import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyHostingProvider } from '../server/lib/hosting-adapters.mjs';

const ok = (body = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('verifies Render, Railway, Fly.io, DigitalOcean and Heroku API credentials', async () => {
  const cases = [
    ['render', { apiKey: 'render-key' }, 'https://api.render.com/v1/services?limit=1'],
    ['railway', { token: 'railway-token' }, 'https://backboard.railway.com/graphql/v2'],
    ['flyio', { token: 'fly-token', orgSlug: 'personal' }, 'https://api.machines.dev/v1/apps?org_slug=personal'],
    ['digitalocean-app-platform', { accessToken: 'do-token' }, 'https://api.digitalocean.com/v2/account'],
    ['heroku', { apiKey: 'heroku-key' }, 'https://api.heroku.com/account'],
  ];
  for (const [provider, credentials, expectedUrl] of cases) {
    let called = false;
    const result = await verifyHostingProvider(provider, credentials, {
      fetchImpl: async (url, options) => {
        called = true;
        assert.equal(url, expectedUrl);
        assert.match(options.headers.Authorization, /^Bearer /);
        if (provider === 'railway') return ok({ data: { me: { id: 'acct', name: 'Kestrel test' } } });
        if (provider === 'digitalocean-app-platform') return ok({ account: { email: 'test@example.com' } });
        if (provider === 'heroku') return ok({ email: 'test@example.com' });
        return ok([]);
      },
    });
    assert.equal(called, true);
    assert.equal(result.verified, true);
  }
});

test('verifies AWS ECS Express Mode credentials using a signed ECS API request', async () => {
  let authorization = '';
  let target = '';
  let requestUrl = '';
  const result = await verifyHostingProvider('aws-ecs-express', {
    accessKeyId: 'AKIATESTKEY', secretAccessKey: 'test-secret', region: 'us-east-1',
  }, {
    now: Date.parse('2026-11-24T00:00:00.000Z'),
    fetchImpl: async (url, options) => {
      requestUrl = url;
      target = options.headers['x-amz-target'];
      authorization = options.headers.Authorization;
      return new Response('{}', { status: 200 });
    },
  });
  assert.match(authorization, /^AWS4-HMAC-SHA256 Credential=AKIATESTKEY\//);
  assert.equal(requestUrl, 'https://ecs.us-east-1.amazonaws.com/');
  assert.equal(target, 'AmazonEC2ContainerServiceV20141113.ListClusters');
  assert.equal(result.verified, true);
});

test('verifies Google Cloud Run service-account credentials with OAuth and the Cloud Run API', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccountJson = JSON.stringify({
    type: 'service_account', client_email: 'kestrel@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const calls = [];
  const result = await verifyHostingProvider('google-cloud-run', { projectId: 'kestrel-test', serviceAccountJson }, {
    now: Date.parse('2026-11-24T00:00:00.000Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.includes('oauth2.googleapis.com') ? ok({ access_token: 'google-access-token' }) : ok({});
    },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].options.headers.Authorization, /^Bearer google-access-token$/);
  assert.equal(result.account, 'kestrel-test');
});

test('rejects unsupported provider verification without making a network request', async () => {
  await assert.rejects(
    verifyHostingProvider('future-provider', { apiToken: 'x', accountId: 'y' }, { fetchImpl: async () => assert.fail('network should not be called') }),
    /not implemented/,
  );
});
