import test from 'node:test';
import assert from 'node:assert/strict';
import { registerManagedDeploymentRoutes } from '../server/routes/managed-deployments.mjs';
import { encryptSecret } from '../server/lib/security.mjs';

function registerRoute({ project, query, fetchImpl, createInstallationToken, body = { branch: 'main' } }) {
  let handler;
  const app = {
    post(path, _auth, callback) {
      if (path === '/api/projects/:projectId/managed-deployments') handler = callback;
    },
    get() {},
  };
  registerManagedDeploymentRoutes(app, {
    userAuth: (_req, _res, next) => next?.(),
    query,
    transaction: async () => { throw new Error('No transaction should be opened'); },
    fetchImpl,
    createInstallationToken,
  });
  assert.equal(typeof handler, 'function');
  return async () => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handler({
      params: { projectId: 'project-1' },
      user: { id: 'user-1' },
      body,
    }, res);
    return res;
  };
}

const project = (installationId) => ({
  id: 'project-1',
  organization_id: 'org-1',
  name: 'Private App',
  repository_url: 'https://github.com/acme/private-app',
  default_branch: 'main',
  source_type: 'git',
  github_installation_id: installationId,
  role: 'owner',
});

test('manual deployment source inspection uses a short-lived installation token for private repositories', async () => {
  const token = 'ghs-private-source-token';
  const calls = [];
  let tokenRequest = null;
  const run = registerRoute({
    project: project('12345'),
    query: async (sql, params) => {
      if (/from public\.projects p/i.test(sql)) return { rowCount: 1, rows: [project('12345')] };
      if (/from public\.github_app_installations/i.test(sql)) {
        assert.deepEqual(params, ['12345', 'org-1']);
        return { rowCount: 1, rows: [{ installation_id: '12345' }] };
      }
      if (/from public\.hosting_provider_connections/i.test(sql)) return { rowCount: 0, rows: [] };
      throw new Error('Unexpected query: ' + sql);
    },
    createInstallationToken: async (installationId, options) => {
      tokenRequest = { installationId, options };
      return { token, expiresAt: '2026-11-26T14:00:00Z' };
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      if (url.endsWith('/commits/main')) return new Response(JSON.stringify({ sha: 'a'.repeat(40) }), { status: 200 });
      if (url.includes('/contents/?ref=main')) {
        return new Response(JSON.stringify([{ name: 'package.json', type: 'file' }]), { status: 200 });
      }
      if (url.includes('/contents/package.json?ref=main')) {
        return new Response(JSON.stringify({
          content: Buffer.from(JSON.stringify({ dependencies: { vite: '^6.0.0' }, scripts: { build: 'vite build' } })).toString('base64'),
        }), { status: 200 });
      }
      throw new Error('Unexpected GitHub URL: ' + url);
    },
  });
  const response = await run();
  assert.equal(response.statusCode, 409); // Source inspection succeeded; no provider account is connected in this test.
  assert.match(response.body.error, /No verified compatible managed provider/);
  assert.equal(tokenRequest.installationId, '12345');
  assert.equal(tokenRequest.options.repository, 'acme/private-app');
  assert.deepEqual(tokenRequest.options.permissions, { contents: 'read' });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.authorization === `Bearer ${token}`));
});

test('public repository deployments do not require a GitHub App installation token', async () => {
  const calls = [];
  const run = registerRoute({
    project: project(null),
    query: async (sql) => {
      if (/from public\.projects p/i.test(sql)) return { rowCount: 1, rows: [project(null)] };
      if (/from public\.hosting_provider_connections/i.test(sql)) return { rowCount: 0, rows: [] };
      throw new Error('Unexpected query: ' + sql);
    },
    createInstallationToken: async () => { assert.fail('Public repository must not mint an installation token'); },
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      assert.equal(options.headers.Authorization, undefined);
      if (url.endsWith('/commits/main')) return new Response(JSON.stringify({ sha: 'b'.repeat(40) }), { status: 200 });
      if (url.includes('/contents/?ref=main')) {
        return new Response(JSON.stringify([{ name: 'index.html', type: 'file' }]), { status: 200 });
      }
      throw new Error('Unexpected GitHub URL: ' + url);
    },
  });
  const response = await run();
  assert.equal(response.statusCode, 409);
  assert.equal(calls.length, 2);
});

test('private repository deployment fails closed when its GitHub App installation is suspended or missing', async () => {
  let sourceCalls = 0;
  const run = registerRoute({
    project: project('12345'),
    query: async (sql) => {
      if (/from public\.projects p/i.test(sql)) return { rowCount: 1, rows: [project('12345')] };
      if (/from public\.github_app_installations/i.test(sql)) return { rowCount: 0, rows: [] };
      throw new Error('Unexpected query: ' + sql);
    },
    createInstallationToken: async () => { assert.fail('A missing installation must not mint a token'); },
    fetchImpl: async () => { sourceCalls += 1; throw new Error('GitHub API must not be called'); },
  });
  const response = await run();
  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /missing, suspended, or not connected/);
  assert.equal(sourceCalls, 0);
});

test('private repository deployment reports missing GitHub App configuration as a setup error', async () => {
  const run = registerRoute({
    project: project('12345'),
    query: async (sql) => {
      if (/from public\.projects p/i.test(sql)) return { rowCount: 1, rows: [project('12345')] };
      if (/from public\.github_app_installations/i.test(sql)) return { rowCount: 1, rows: [{ installation_id: '12345' }] };
      throw new Error('Unexpected query: ' + sql);
    },
    createInstallationToken: async () => { throw new Error('GitHub App is not configured'); },
    fetchImpl: async () => { assert.fail('Source inspection must not start without a token'); },
  });
  const response = await run();
  assert.equal(response.statusCode, 503);
  assert.match(response.body.error, /GitHub App is not configured/);
});


test('manual deployment refuses Netlify when project secrets cannot be synchronized', async () => {
  const secret = encryptSecret('postgres://private-db');
  let artifactLookup = false;
  const calls = [];
  const run = registerRoute({
    project: {
      ...project(null),
      repository_url: 'https://github.com/acme/static-app',
    },
    body: { branch: 'main', artifactIds: ['11111111-1111-4111-8111-111111111111'] },
    query: async (sql) => {
      if (/from public\.projects p/i.test(sql)) return {
        rowCount: 1,
        rows: [{
          ...project(null),
          repository_url: 'https://github.com/acme/static-app',
        }],
      };
      if (/from public\.hosting_provider_connections/i.test(sql)) return {
        rowCount: 1,
        rows: [{
          provider_id: 'netlify',
          credentials_ciphertext: 'not-decrypted',
          credentials_iv: 'not-decrypted',
          credentials_auth_tag: 'not-decrypted',
        }],
      };
      if (/from public\.project_secrets/i.test(sql)) return {
        rowCount: 1,
        rows: [{
          name: 'DATABASE_URL',
          encrypted_value: secret.encryptedValue,
          iv: secret.iv,
          auth_tag: secret.authTag,
        }],
      };
      if (/from public\.artifacts/i.test(sql)) {
        artifactLookup = true;
        return { rowCount: 1, rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
      }
      throw new Error('Unexpected query: ' + sql);
    },
    createInstallationToken: async () => { assert.fail('Public repository must not mint an installation token'); },
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (url.endsWith('/commits/main')) return new Response(JSON.stringify({ sha: 'c'.repeat(40) }), { status: 200 });
      if (url.includes('/contents/?ref=main')) {
        return new Response(JSON.stringify([{ name: 'package.json', type: 'file' }]), { status: 200 });
      }
      if (url.includes('/contents/package.json?ref=main')) {
        return new Response(JSON.stringify({
          content: Buffer.from(JSON.stringify({ dependencies: { astro: '^5.0.0' }, scripts: { build: 'astro build' } })).toString('base64'),
        }), { status: 200 });
      }
      throw new Error('Unexpected GitHub URL: ' + url);
    },
  });
  const response = await run();
  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /Netlify requires completed static build artifacts and cannot currently deploy projects with Kestrel-managed secrets/);
  assert.equal(artifactLookup, false);
  assert.equal(calls.length, 3);
});
