import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseGitHubRepository, isValidGitHubInstallationId, registerGitImportRoutes } from '../server/routes/git-import.mjs';

test('parses ordinary GitHub repository URLs', () => {
  assert.deepEqual(parseGitHubRepository('https://github.com/acme/store'), { owner: 'acme', repo: 'store' });
  assert.deepEqual(parseGitHubRepository('https://github.com/acme/store.git'), { owner: 'acme', repo: 'store' });
  assert.deepEqual(parseGitHubRepository('https://github.com/Acme/store/'), { owner: 'Acme', repo: 'store' });
});

test('rejects unsafe or unsupported repository URLs', () => {
  for (const value of [
    'http://github.com/acme/store',
    'https://github.com.evil.test/acme/store',
    'https://user:pass@github.com/acme/store',
    'https://github.com/acme/store?token=secret',
    'https://github.com/acme/store/tree/main',
    'https://gitlab.com/acme/store',
    'javascript:alert(1)',
    '',
    null,
  ]) assert.equal(parseGitHubRepository(value), null, String(value));
});


test('accepts numeric GitHub App installation IDs and rejects malformed values', () => {
  assert.equal(isValidGitHubInstallationId('123456789'), true);
  assert.equal(isValidGitHubInstallationId('0'), false);
  assert.equal(isValidGitHubInstallationId('9223372036854775807'), true);
  for (const value of ['', '00', '12a34', '-123', '123.4', ' 123', '123 ', '9223372036854775808', null, 123]) {
    assert.equal(isValidGitHubInstallationId(value), false, String(value));
  }
});


test('private repository import forwards the injected HTTP client through the route', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const saved = {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
  };
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_SLUG = 'kestrel-app';
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });

  try {
    let handler;
    const app = { post: (_path, _auth, callback) => { handler = callback; } };
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/access_tokens')) {
        return new Response(JSON.stringify({
          token: 'route-installation-token',
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
    };
    const query = async (sql) => {
      if (sql.includes('organization_members')) {
        return { rowCount: 1, rows: [{ role: 'developer' }] };
      }
      if (sql.includes('github_app_installations')) {
        return { rowCount: 1, rows: [{ installation_id: '987' }] };
      }
      throw new Error('Unexpected query');
    };
    const transaction = async (callback) => callback({
      query: async (sql) => {
        if (sql.includes('insert into public.projects')) {
          return { rowCount: 1, rows: [{
            id: 'project-1', organizationId: 'org-1', name: 'Private App',
            repositoryUrl: 'https://github.com/acme/private-app',
            defaultBranch: 'main', sourceType: 'git', githubInstallationId: '987',
            createdAt: '2026-11-27T12:00:00.000Z',
          }] };
        }
        if (sql.includes('insert into public.github_webhooks')) {
          return { rowCount: 1, rows: [{ id: 'webhook-1' }] };
        }
        if (sql.includes('insert into public.audit_events')) return { rowCount: 1, rows: [] };
        throw new Error('Unexpected transaction query');
      },
    });
    registerGitImportRoutes(app, { userAuth: (_req, _res, next) => next(), query, transaction, fetchImpl });

    const response = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
    };
    await handler({
      user: { id: 'user-1' },
      body: {
        organizationId: 'org-1',
        name: 'Private App',
        repositoryUrl: 'https://github.com/acme/private-app',
        installationId: '987',
      },
    }, response);

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.repository.private, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /installations\/987\/access_tokens$/);
    assert.equal(calls[1].url, 'https://api.github.com/repos/acme/private-app');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer route-installation-token');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
