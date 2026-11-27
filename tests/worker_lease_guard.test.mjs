import test from 'node:test';
import assert from 'node:assert/strict';
import { abortIfLeaseLost } from '../worker/lease-guard.mjs';

test('aborts active work when the control plane rejects a lease as expired', () => {
  const controller = new AbortController();
  assert.equal(abortIfLeaseLost(new Error('/lease: 409 lease expired'), controller), true);
  assert.equal(controller.signal.aborted, true);
});

test('does not abort active work for transient heartbeat failures', () => {
  const controller = new AbortController();
  assert.equal(abortIfLeaseLost(new Error('fetch failed: network timeout'), controller), false);
  assert.equal(controller.signal.aborted, false);
});

test('aborts when a structured conflict status is supplied', () => {
  const controller = new AbortController();
  assert.equal(abortIfLeaseLost({ status: 409, message: 'Conflict' }, controller), true);
  assert.equal(controller.signal.aborted, true);
});
