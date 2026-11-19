import test from 'node:test';
import assert from 'node:assert/strict';
import { createVercelSandboxClient, sandboxCredentials, SandboxProviderError, makeSandboxName } from '../server/lib/vercel-sandbox.mjs';

test('sandbox credentials fail closed when required Vercel credentials are missing', () => {
  assert.throws(() => sandboxCredentials({}), (error) => error instanceof SandboxProviderError && error.status === 503);
  assert.deepEqual(sandboxCredentials({ VERCEL_TOKEN: 'token', VERCEL_PROJECT_ID: 'project', VERCEL_TEAM_ID: 'team' }), {
    token: 'token', projectId: 'project', teamId: 'team',
  });
});

test('sandbox provider client sends project, team, resource and persistence settings on create', async () => {
  let captured;
  const client = createVercelSandboxClient({
    env: { VERCEL_TOKEN: 'secret', VERCEL_PROJECT_ID: 'project-id', VERCEL_TEAM_ID: 'team-id' },
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ sandbox: { name: 'sbx-name', currentSessionId: 'session-id', status: 'running' }, session: { id: 'session-id' }, routes: [] }), { status: 201 });
    },
  });
  const response = await client.create({ name: 'kestrel-abc', vcpus: 2, timeoutMs: 900000, region: 'fra1', tags: { managedBy: 'kestrel' } });
  assert.equal(response.sandbox.name, 'sbx-name');
  assert.match(captured.url, /teamId=team-id/);
  assert.equal(captured.init.method, 'POST');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.projectId, 'project-id');
  assert.equal(body.resources.vcpus, 2);
  assert.equal(body.persistent, true);
  assert.equal(body.timeout, 900000);
});

test('sandbox provider client executes a command and captures bounded NDJSON output', async () => {
  const lines = [
    { command: { id: 'cmd-1', exitCode: null } },
    { stream: 'stdout', data: 'hello\n' },
    { stream: 'stderr', data: 'warning\n' },
    { command: { id: 'cmd-1', exitCode: 0, durationMs: 10 } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n';
  const client = createVercelSandboxClient({
    env: { VERCEL_TOKEN: 'secret', VERCEL_PROJECT_ID: 'project-id', VERCEL_TEAM_ID: 'team-id' },
    fetchImpl: async (_url, init) => {
      assert.equal(init.method, 'POST');
      return new Response(lines, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    },
  });
  const result = await client.runCommand('session-id', { command: 'node', args: ['-e', 'console.log(1)'], timeoutMs: 30000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello\n');
  assert.equal(result.stderr, 'warning\n');
});

test('sandbox API errors are normalized without leaking request credentials', async () => {
  const client = createVercelSandboxClient({
    env: { VERCEL_TOKEN: 'secret', VERCEL_PROJECT_ID: 'project-id', VERCEL_TEAM_ID: 'team-id' },
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 }),
  });
  await assert.rejects(client.get('name'), (error) => error instanceof SandboxProviderError && error.status === 400 && !error.message.includes('secret'));
});

test('sandbox names use a provider-safe prefix', () => {
  assert.match(makeSandboxName('a1-b2'), /^kestrel-a1b2$/);
});
