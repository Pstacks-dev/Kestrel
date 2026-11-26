import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAndPublishOciImage, runProcess } from '../server/lib/oci-image-builder.mjs';

const digest = 'sha256:' + 'a'.repeat(64);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kestrel-oci-test-'));
  await writeFile(path.join(root, 'Dockerfile'), 'FROM node:22-alpine\n');
  return root;
}
const base = (contextDir) => ({
  contextDir, image: 'registry.example.test/team/service:abc1234',
  commitSha: 'b'.repeat(40), registryUsername: 'kestrel', registryPassword: 'do-not-log-me',
});

test('logs in through stdin, pushes a commit-labelled image and returns the registry digest', async () => {
  const contextDir = await fixture();
  const calls = [];
  try {
    const result = await buildAndPublishOciImage(base(contextDir), {
      run: async (command, args, options) => {
        calls.push({ command, args, input: options.input, env: options.env });
        const metadata = args[args.indexOf('--metadata-file') + 1];
        if (metadata) await writeFile(metadata, JSON.stringify({ 'containerimage.digest': digest }));
        return { stdout: '', stderr: '' };
      },
    });
    assert.equal(calls[0].args[0], 'login');
    assert.equal(calls[0].input, 'do-not-log-me');
    assert.ok(!calls[0].args.includes('do-not-log-me'));
    const buildCall = calls.find((call) => call.args[0] === 'buildx' && call.args[1] === 'build');
    assert.ok(calls.some((call) => call.args[0] === 'buildx' && call.args[1] === 'create'));
    assert.ok(calls.some((call) => call.args[0] === 'buildx' && call.args[1] === 'inspect'));
    assert.ok(calls.some((call) => call.args[0] === 'buildx' && call.args[1] === 'rm'));
    assert.ok(buildCall.args.includes('--push'));
    assert.ok(buildCall.args.includes('--label'));
    assert.equal(result.imageDigestRef, 'registry.example.test/team/service@' + digest);
    assert.equal(result.commitSha, 'b'.repeat(40));
    await assert.rejects(stat(calls[0].env.DOCKER_CONFIG));
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(contextDir, { recursive: true, force: true });
  }
});

test('rejects mismatched registry credentials before invoking Docker', async () => {
  const contextDir = await fixture();
  let invoked = false;
  try {
    await assert.rejects(buildAndPublishOciImage({ ...base(contextDir), registry: 'other.example.test' }, {
      run: async () => { invoked = true; },
    }), /Registry credentials do not match/);
    assert.equal(invoked, false);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(contextDir, { recursive: true, force: true });
  }
});

test('rejects invalid commit SHAs and unsafe Dockerfile paths', async () => {
  const contextDir = await fixture();
  try {
    await assert.rejects(buildAndPublishOciImage({ ...base(contextDir), commitSha: 'main' }), /full Git commit SHA/);
    await assert.rejects(buildAndPublishOciImage({ ...base(contextDir), dockerfile: '../Dockerfile' }), /safe path/);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(contextDir, { recursive: true, force: true });
  }
});


test('terminates an active Docker subprocess when its worker drain signal is aborted', async () => {
  const controller = new AbortController();
  const command = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    abortSignal: controller.signal, timeoutMs: 5000,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(command, /was aborted/);
});
