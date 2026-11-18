import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDockerEnvFile, createLocalJobEnv } from '../worker/lib/job-env.mjs';

test('Docker job secrets are written to a private temporary env file and cleaned up', async () => {
  const env = await createDockerEnvFile({ API_TOKEN: 'secret=value', EMPTY_VALUE: '' });
  try {
    const stat = await fs.stat(env.path);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(await fs.readFile(env.path, 'utf8'), 'API_TOKEN=secret=value\nEMPTY_VALUE=\n');
  } finally {
    await env.cleanup();
  }
  await assert.rejects(fs.stat(env.path), { code: 'ENOENT' });
});

test('Docker env file rejects unsafe keys and multiline values', async () => {
  await assert.rejects(createDockerEnvFile({ 'BAD=KEY': 'value' }), /Invalid environment variable name/);
  await assert.rejects(createDockerEnvFile({ API_TOKEN: 'first\nsecond' }), /newline or NUL/);
});

test('local executor receives only a minimal host environment and explicit job secrets', () => {
  const env = createLocalJobEnv({
    PATH: '/usr/bin',
    HOME: '/home/worker',
    KESTREL_WORKER_TOKEN: 'worker-secret',
    SUPABASE_SERVICE_ROLE_KEY: 'service-secret',
  }, { BUILD_TOKEN: 'job-secret' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/worker');
  assert.equal(env.BUILD_TOKEN, 'job-secret');
  assert.equal(env.CI, 'true');
  assert.equal(env.KESTREL, 'true');
  assert.equal(env.KESTREL_WORKER_TOKEN, undefined);
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
});
