import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createManagedOciBuildScript, startManagedOciBuild, pollManagedOciBuild,
} from '../server/lib/managed-oci-builds.mjs';

const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});

function sandboxMock() {
  const calls = [];
  return {
    calls,
    async create(input) {
      calls.push({ method: 'create', input });
      return { sandbox: { name: input.name }, session: { id: 'session-1' } };
    },
    async startCommand(sessionId, input) {
      calls.push({ method: 'startCommand', sessionId, input });
      return { id: 'command-1' };
    },
    async getCommand(sessionId, commandId) {
      calls.push({ method: 'getCommand', sessionId, commandId });
      return { id: commandId, exitCode: null };
    },
    async getCommandLogs(sessionId, commandId) {
      calls.push({ method: 'getCommandLogs', sessionId, commandId });
      return { stdout: 'KESTREL_IMAGE_REF=registry.fly.io/kestrel-demo:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
    },
    async stop(sessionId) { calls.push({ method: 'stop', sessionId }); },
    async delete(name) { calls.push({ method: 'delete', name }); },
  };
}

test('OCI build script pins the source commit, supports Dockerfiles and buildpacks, and pushes the image', () => {
  const script = createManagedOciBuildScript();
  assert.match(script, /git -C "\$WORKSPACE" checkout --detach "\$COMMIT_SHA"/);
  assert.match(script, /docker build --pull --platform linux\/amd64/);
  assert.match(script, /paketobuildpacks\/builder-jammy-base/);
  assert.match(script, /docker push "\$IMAGE_REF"/);
});

test('starts a detached Fly.io OCI build in an isolated Vercel sandbox', async () => {
  const sandboxClient = sandboxMock();
  const flyCalls = [];
  const result = await startManagedOciBuild({
    providerId: 'flyio',
    credentials: { token: 'fly-token', orgSlug: 'p-stacks' },
    projectName: 'kestrel-demo',
    repositoryUrl: 'https://github.com/pstacks/demo.git',
    commitSha: 'a'.repeat(40),
    runId: '123e4567-e89b-42d3-a456-426614174000',
    sandboxClient,
    fetchImpl: async (url, options = {}) => {
      flyCalls.push({ url: String(url), options });
      if (options.method === 'POST') return response({ id: 'app-1', name: 'kestrel-demo' });
      return response({ error: 'not found' }, 404);
    },
  });
  assert.equal(result.sandboxName, 'kestrel-build-123e4567e89b');
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.commandId, 'command-1');
  assert.equal(result.imageRef, `registry.fly.io/kestrel-demo:${'a'.repeat(40)}`);
  assert.equal(flyCalls.length, 2);
  const command = sandboxClient.calls.find((call) => call.method === 'startCommand');
  assert.equal(command.input.env.REGISTRY_PASSWORD, 'fly-token');
  assert.equal(command.input.env.COMMIT_SHA, 'a'.repeat(40));
  assert.equal(command.input.sudo, true);
  assert.match(command.input.args[1], /docker build/);
});

test('prepares Artifact Registry and uses a short-lived Google OAuth token for the image push', async () => {
  const sandboxClient = sandboxMock();
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccountJson = JSON.stringify({
    type: 'service_account', project_id: 'project-1',
    client_email: 'kestrel@project-1.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const calls = [];
  const result = await startManagedOciBuild({
    providerId: 'google-cloud-run',
    credentials: { projectId: 'project-1', serviceAccountJson, region: 'us-central1' },
    projectName: 'kestrel-demo',
    repositoryUrl: 'https://github.com/pstacks/demo.git',
    commitSha: 'b'.repeat(40),
    runId: '123e4567-e89b-42d3-a456-426614174000',
    sandboxClient,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url) === 'https://oauth2.googleapis.com/token') return response({ access_token: 'google-short-lived-token' });
      if (options.method === 'POST') return response({ name: 'projects/project-1/locations/us-central1/repositories/kestrel' });
      return response({ error: { code: 404 } }, 404);
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(result.imageRef, 'us-central1-docker.pkg.dev/project-1/kestrel/kestrel-demo:' + 'b'.repeat(40));
  const command = sandboxClient.calls.find((call) => call.method === 'startCommand');
  assert.equal(command.input.env.REGISTRY_HOST, 'us-central1-docker.pkg.dev');
  assert.equal(command.input.env.REGISTRY_PASSWORD, 'google-short-lived-token');
});

test('polls detached OCI builds and cleans up the sandbox after successful image publishing', async () => {
  const sandboxClient = sandboxMock();
  const running = await pollManagedOciBuild({ sandboxName: 'build-1', sessionId: 'session-1', commandId: 'command-1' }, { sandboxClient });
  assert.deepEqual(running, { state: 'building' });
  sandboxClient.getCommand = async () => ({ id: 'command-1', exitCode: 0 });
  const completed = await pollManagedOciBuild({ sandboxName: 'build-1', sessionId: 'session-1', commandId: 'command-1' }, { sandboxClient });
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.imageRef, `registry.fly.io/kestrel-demo:${'a'.repeat(40)}`);
  assert.ok(sandboxClient.calls.some((call) => call.method === 'stop'));
  assert.ok(sandboxClient.calls.some((call) => call.method === 'delete'));
});
