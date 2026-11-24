import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret } from '../server/lib/security.mjs';
import { triggerManagedDeploymentForPipelineRun } from '../server/routes/managed-deployments.mjs';

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function fixture({ branch = 'main', duplicate = false } = {}) {
  const encrypted = encryptSecret(JSON.stringify({ apiKey: 'render-test-token', ownerId: 'owner-1' }));
  const run = {
    id: 'run-1', project_id: 'project-1', branch, commit_sha: 'a'.repeat(40),
    status: 'succeeded', triggered_by: 'user-1', organization_id: 'org-1',
    name: 'Demo App', repository_url: 'https://github.com/acme/demo',
    default_branch: 'main', source_type: 'git',
  };
  const calls = [];
  const triggerUpdates = [];
  const query = async (sql, params = []) => {
    if (sql.includes('select r.id, r.project_id')) return { rowCount: 1, rows: [run] };
    if (sql.includes('insert into public.managed_hosting_pipeline_triggers')) return { rowCount: duplicate ? 0 : 1, rows: duplicate ? [] : [{ pipeline_run_id: 'run-1' }] };
    if (sql.includes('from public.hosting_provider_connections')) return {
      rowCount: 1, rows: [{ provider_id: 'render', credentials_ciphertext: encrypted.encryptedValue, credentials_iv: encrypted.iv, credentials_auth_tag: encrypted.authTag }],
    };
    if (sql.includes('from public.artifacts') && sql.includes('select id')) return { rowCount: 0, rows: [] };
    if (sql.includes('from public.project_secrets')) return { rowCount: 0, rows: [] };
    if (sql.includes('from public.managed_hosting_resources')) return { rowCount: 0, rows: [] };
    if (sql.includes('update public.managed_hosting_pipeline_triggers')) {
      triggerUpdates.push(params);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const transaction = async (callback) => callback({
    query: async (sql, params = []) => {
      if (sql.includes('insert into public.managed_hosting_resources')) return { rowCount: 1, rows: [{ id: 'resource-1' }] };
      if (sql.includes('insert into public.managed_hosting_deployments')) return { rowCount: 1, rows: [{ id: 'deployment-1' }] };
      if (sql.includes('insert into public.audit_events')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
  });
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/contents/?ref=')) return json([{ type: 'file', name: 'package.json' }]);
    if (url.includes('/contents/package.json?ref=')) {
      const packageJson = Buffer.from(JSON.stringify({ scripts: { build: 'npm run build', start: 'node server.js' } })).toString('base64');
      return json({ content: packageJson });
    }
    if (url.endsWith('/services')) return json({ service: { id: 'render-service-1', serviceDetails: { url: 'https://demo.onrender.com' } } }, 201);
    if (url.endsWith('/services/render-service-1/deploys')) return json({ id: 'render-deploy-1', status: 'created' }, 201);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return { query, transaction, fetchImpl, calls, triggerUpdates };
}

test('queues a provider deployment exactly once after a successful default-branch pipeline', async () => {
  const f = fixture();
  const result = await triggerManagedDeploymentForPipelineRun({
    query: f.query, transaction: f.transaction, fetchImpl: f.fetchImpl,
  }, 'run-1');
  assert.equal(result.status, 'deploying');
  assert.equal(result.provider, 'render');
  assert.equal(result.deploymentId, 'deployment-1');
  assert.equal(f.calls.filter((call) => call.url.endsWith('/services')).length, 1);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/services/render-service-1/deploys')).length, 1);
  assert.equal(f.triggerUpdates.at(-1)[1], 'deploying');
});

test('does not create duplicate provider deployments for the same pipeline run', async () => {
  const f = fixture({ duplicate: true });
  const result = await triggerManagedDeploymentForPipelineRun({
    query: f.query, transaction: f.transaction, fetchImpl: f.fetchImpl,
  }, 'run-1');
  assert.equal(result.status, 'duplicate');
  assert.equal(f.calls.length, 0);
});

test('skips automatic production deployment for non-default branches', async () => {
  const f = fixture({ branch: 'feature/new-ui' });
  const result = await triggerManagedDeploymentForPipelineRun({
    query: f.query, transaction: f.transaction, fetchImpl: f.fetchImpl,
  }, 'run-1');
  assert.equal(result.status, 'skipped');
  assert.equal(f.calls.length, 0);
  assert.equal(f.triggerUpdates.at(-1)[1], 'skipped');
});
