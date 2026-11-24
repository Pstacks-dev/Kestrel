import test from 'node:test';
import assert from 'node:assert/strict';
import { createVercelSandboxClient, SandboxProviderError } from './vercel-sandbox.mjs';

const env = {
  VERCEL_TOKEN: 'test-token',
  VERCEL_PROJECT_ID: 'prj_test',
  VERCEL_TEAM_ID: 'team_test',
};

test('starts a detached sandbox command without waiting for completion', async () => {
  let request;
  const client = createVercelSandboxClient({
    env,
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return new Response(JSON.stringify({ command: { id: 'cmd_123', name: 'bash', exitCode: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const command = await client.startCommand('session_123', {
    command: 'bash',
    args: ['-lc', 'npm run build'],
    cwd: '/vercel/sandbox',
    timeoutMs: 600_000,
  });

  assert.equal(command.id, 'cmd_123');
  assert.equal(request.url.pathname, '/v2/sandboxes/sessions/session_123/cmd');
  assert.equal(request.url.searchParams.get('teamId'), 'team_test');
  assert.equal(request.options.method, 'POST');
  const body = JSON.parse(request.options.body);
  assert.equal(body.wait, false);
  assert.equal(body.timeout, 600_000);
  assert.deepEqual(body.args, ['-lc', 'npm run build']);
});

test('retrieves detached command status without blocking', async () => {
  let requestedUrl;
  const client = createVercelSandboxClient({
    env,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return new Response(JSON.stringify({ command: { id: 'cmd_123', exitCode: 0, durationMs: 1234 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const command = await client.getCommand('session_123', 'cmd_123');
  assert.equal(command.exitCode, 0);
  assert.equal(requestedUrl.pathname, '/v2/sandboxes/sessions/session_123/cmd/cmd_123');
  assert.equal(requestedUrl.searchParams.get('wait'), 'false');
});

test('rejects command timeouts above the provider limit before making a request', async () => {
  let called = false;
  const client = createVercelSandboxClient({
    env,
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
  });

  await assert.rejects(
    client.startCommand('session_123', { command: 'bash', timeoutMs: 18_000_001 }),
    (error) => error instanceof SandboxProviderError && error.code === 'sandbox_invalid_timeout',
  );
  assert.equal(called, false);
});

test('collects detached command stdout and stderr logs', async () => {
  const stream = [
    JSON.stringify({ stream: 'stdout', data: 'installing dependencies\n' }),
    JSON.stringify({ stream: 'stderr', data: 'warning: optional package\n' }),
  ].join('\n') + '\n';
  const client = createVercelSandboxClient({
    env,
    fetchImpl: async (url) => {
      assert.match(String(url), /\/cmd\/cmd_123\/logs/);
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    },
  });

  const logs = await client.getCommandLogs('session_123', 'cmd_123');
  assert.match(logs.stdout, /installing dependencies/);
  assert.match(logs.stderr, /optional package/);
  assert.equal(logs.truncated, false);
});

test('creates a sandbox from an exact public Git revision', async () => {
  let body;
  const client = createVercelSandboxClient({
    env,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ sandbox: { name: 'sandbox', currentSessionId: 'session' }, session: { id: 'session' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  await client.create({
    name: 'kestrel-build', vcpus: 2, timeoutMs: 600000, region: 'iad1',
    source: { type: 'git', url: 'https://github.com/acme/demo', revision: 'a'.repeat(40) },
  });
  assert.equal(body.source.revision, 'a'.repeat(40));
  assert.equal(body.source.type, 'git');
});

test('passes tenant build secrets only in the sandbox command environment', async () => {
  let body;
  const stream = [
    JSON.stringify({ stream: 'stdout', data: 'build complete\\n' }),
    JSON.stringify({ command: { id: 'cmd_env', exitCode: 0, durationMs: 50 } }),
  ].join('\\n') + '\\n';
  const client = createVercelSandboxClient({
    env,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    },
  });
  const result = await client.runCommand('session_123', {
    command: 'bash', args: ['-lc', 'echo build'], cwd: '/vercel/sandbox',
    timeoutMs: 60000, env: { FLY_API_TOKEN: 'tenant-secret' },
  });
  assert.equal(body.env.FLY_API_TOKEN, 'tenant-secret');
  assert.equal(result.exitCode, 0);
});
