import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkerToken } from '../worker/config.mjs';

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
