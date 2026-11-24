import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fetchGitHubRepositoryWithInstallation } from '../server/routes/github-app.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { appId: '12345', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), appSlug: 'kestrel-app' };

test('fetches a private repository with a short-lived token scoped to that repository', async () => {
  const calls = [];
  const result = await fetchGitHubRepositoryWithInstallation('99', 'acme/private-app', {
    config,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/access_tokens')) {
        assert.deepEqual(JSON.parse(options.body), { repositories: ['private-app'] });
        return new Response(JSON.stringify({ token: 'ephemeral-installation-token', expires_at: '2026-11-24T18:00:00Z' }), { status: 201 });
      }
      assert.match(options.headers.Authorization, /^Bearer ephemeral-installation-token$/);
      return new Response(JSON.stringify({ full_name: 'acme/private-app', private: true, default_branch: 'main' }), { status: 200 });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.private, true);
  assert.equal(result.full_name, 'acme/private-app');
});

test('does not send credentials for malformed repository names', async () => {
  await assert.rejects(() => fetchGitHubRepositoryWithInstallation('99', 'https://github.com/acme/private-app', {
    config,
    fetchImpl: () => assert.fail('network must not run'),
  }));
});
