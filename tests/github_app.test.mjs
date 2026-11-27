import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGitHubAppJwt, createGitHubInstallationToken, getGitHubInstallation } from '../server/lib/github-app.mjs';
import { fetchGitHubRepositoryWithInstallation } from '../server/routes/github-app.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { appId: '12345', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), appSlug: 'kestrel-app' };

test('creates a short-lived RS256 GitHub App JWT', () => {
  const token = createGitHubAppJwt({ appId: config.appId, privateKey: config.privateKey, now: 1_800_000_000_000 });
  const [header, payload, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, config.appId);
  assert.equal(claims.exp - claims.iat, 540);
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(header + '.' + payload), publicKey, Buffer.from(signature, 'base64url')), true);
});

test('mints an installation token scoped to one repository', async () => {
  let request;
  const result = await createGitHubInstallationToken('987', {
    repository: 'acme/private-app', config,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ token: 'short-lived-token', expires_at: '2026-11-24T12:00:00Z', permissions: { contents: 'read' } }), { status: 201 });
    },
  });
  assert.match(request.url, /installations\/987\/access_tokens$/);
  assert.deepEqual(JSON.parse(request.options.body), { repositories: ['private-app'] });
  assert.equal(result.token, 'short-lived-token');
  assert.equal(result.permissions.contents, 'read');
});

test('rejects invalid installation and repository identifiers before network access', async () => {
  await assert.rejects(() => createGitHubInstallationToken('x', { config, fetchImpl: () => assert.fail('network must not run') }));
  await assert.rejects(() => createGitHubInstallationToken('1', { repository: 'https://github.com/acme/app', config, fetchImpl: () => assert.fail('network must not run') }));
});

test('looks up an installation with an App JWT', async () => {
  let authorization;
  const result = await getGitHubInstallation('42', { config, fetchImpl: async (_url, options) => {
    authorization = options.headers.Authorization;
    return new Response(JSON.stringify({ id: 42, account: { login: 'acme', type: 'Organization' } }), { status: 200 });
  }});
  assert.match(authorization, /^Bearer [^.]+\./);
  assert.equal(result.account.login, 'acme');
});


test('private repository lookup uses the injected fetch client for token minting and metadata', async () => {
  const calls = [];
  const result = await fetchGitHubRepositoryWithInstallation('987', 'acme/private-app', {
    config,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/access_tokens')) {
        return new Response(JSON.stringify({
          token: 'installation-token',
          expires_at: '2026-11-27T12:00:00Z',
          permissions: { contents: 'read' },
        }), { status: 201 });
      }
      return new Response(JSON.stringify({
        full_name: 'acme/private-app',
        name: 'private-app',
        private: true,
        default_branch: 'main',
      }), { status: 200 });
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /installations\/987\/access_tokens$/);
  assert.equal(calls[1].url, 'https://api.github.com/repos/acme/private-app');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer installation-token');
  assert.equal(result.private, true);
  assert.equal(result.default_branch, 'main');
});
