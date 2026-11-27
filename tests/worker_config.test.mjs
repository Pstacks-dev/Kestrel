import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkerToken, resolveWorkerEgress, resolveWorkerExecutor, resolveWorkerJobNetwork } from '../worker/config.mjs';

test('production workers require a provisioned per-worker token', () => {
  assert.throws(() => resolveWorkerToken({ nodeEnv: 'production', token: undefined }), /provisioned KESTREL_WORKER_TOKEN/);
  assert.throws(() => resolveWorkerToken({ nodeEnv: 'production', token: 'short-worker-token' }), /at least 32 characters/);
});

test('accepts a sufficiently strong provisioned worker token', () => {
  const token = 'a'.repeat(64);
  assert.equal(resolveWorkerToken({ nodeEnv: 'production', token }), token);
});

test('missing NODE_ENV is fail-closed and cannot enable the development fallback', () => {
  assert.throws(() => resolveWorkerToken({ nodeEnv: undefined, token: undefined }), /provisioned KESTREL_WORKER_TOKEN/);
});
test('development fallback is isolated to non-production mode', () => {
  assert.match(resolveWorkerToken({ nodeEnv: 'development', token: undefined }), /^kestrel-development-only-worker-token/);
  assert.throws(() => resolveWorkerToken({ nodeEnv: 'production', token: undefined }), /provisioned KESTREL_WORKER_TOKEN/);
});

test('trims surrounding whitespace and rejects weak worker tokens', () => {
  assert.throws(() => resolveWorkerToken({ nodeEnv: 'production', token: ' '.repeat(40) }), /at least 32 characters/);
  assert.equal(resolveWorkerToken({ nodeEnv: 'production', token: '  ' + 'x'.repeat(32) + '  ' }), 'x'.repeat(32));
});

test('production workers require an explicit provisioned HTTPS control-plane connection', async () => {
  const { resolveWorkerConnection } = await import('../worker/config.mjs');
  assert.throws(() => resolveWorkerConnection({ nodeEnv: 'production', apiUrl: undefined, workerId: 'wrk_12345678' }), /KESTREL_API_URL is required/);
  assert.throws(() => resolveWorkerConnection({ nodeEnv: 'production', apiUrl: 'http://kestrel.internal', workerId: 'wrk_12345678' }), /HTTPS/);
  assert.throws(() => resolveWorkerConnection({ nodeEnv: 'production', apiUrl: 'https://user:secret@kestrel.example', workerId: 'wrk_12345678' }), /credential-free/);
  assert.throws(() => resolveWorkerConnection({ nodeEnv: 'production', apiUrl: 'https://kestrel.example', workerId: undefined }), /provisioned KESTREL_WORKER_ID/);
  assert.deepEqual(resolveWorkerConnection({
    nodeEnv: 'production', apiUrl: 'https://kestrel.example/', workerId: 'wrk_12345678',
  }), { api: 'https://kestrel.example', workerId: 'wrk_12345678' });
});

test('development worker connection retains the local default and generated identity', async () => {
  const { resolveWorkerConnection } = await import('../worker/config.mjs');
  const connection = resolveWorkerConnection({ nodeEnv: 'development', apiUrl: undefined, workerId: undefined, hostname: 'dev-worker' });
  assert.equal(connection.api, 'http://127.0.0.1:4000');
  assert.match(connection.workerId, /^dev-worker-[a-f0-9]{5}$/);
});


test('production Docker workers require explicit host egress hardening', () => {
  assert.throws(() => resolveWorkerEgress({
    nodeEnv: 'production', executor: 'docker', egressHardened: undefined,
  }), /host Docker egress firewall/);
  assert.equal(resolveWorkerEgress({
    nodeEnv: 'production', executor: 'docker', egressHardened: 'true',
  }), true);
});

test('development and non-Docker workers do not require production Docker egress attestation', () => {
  assert.equal(resolveWorkerEgress({
    nodeEnv: 'development', executor: 'docker', egressHardened: undefined,
  }), true);
  assert.equal(resolveWorkerEgress({
    nodeEnv: 'production', executor: 'local', egressHardened: undefined,
  }), true);
});


test('production workers cannot execute customer code in local or mock mode', () => {
  assert.equal(resolveWorkerExecutor({ nodeEnv: 'production', executor: 'docker' }), 'docker');
  assert.throws(() => resolveWorkerExecutor({ nodeEnv: 'production', executor: 'local' }), /isolated Docker executor/);
  assert.throws(() => resolveWorkerExecutor({ nodeEnv: 'production', executor: 'mock' }), /isolated Docker executor/);
});

test('unknown worker executors are rejected', () => {
  assert.throws(() => resolveWorkerExecutor({ nodeEnv: 'development', executor: 'shell' }), /must be docker, local or mock/);
});


test('missing NODE_ENV defaults to production safeguards', async () => {
  const { resolveWorkerConnection } = await import('../worker/config.mjs');
  assert.throws(() => resolveWorkerConnection({
    nodeEnv: undefined,
    apiUrl: 'http://127.0.0.1:4000',
    workerId: 'dev-worker',
  }), /HTTPS/);
  assert.throws(() => resolveWorkerEgress({
    nodeEnv: undefined, executor: 'docker', egressHardened: undefined,
  }), /host Docker egress firewall/);
  assert.throws(() => resolveWorkerExecutor({
    nodeEnv: undefined, executor: 'local',
  }), /isolated Docker executor/);
});


test('production job networking defaults to none and validates explicit modes', () => {
  assert.equal(resolveWorkerJobNetwork({ nodeEnv: 'production', network: undefined }), 'none');
  assert.equal(resolveWorkerJobNetwork({ nodeEnv: 'development', network: undefined }), 'bridge');
  assert.equal(resolveWorkerJobNetwork({ nodeEnv: 'production', network: 'bridge' }), 'bridge');
  assert.throws(() => resolveWorkerJobNetwork({ nodeEnv: 'production', network: 'host' }), /must be bridge or none/);
});
