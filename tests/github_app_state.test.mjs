import test from 'node:test';
import assert from 'node:assert/strict';
import { signInstallationState, verifyInstallationState } from '../server/routes/github-app.mjs';

const secret = 'test-secret-that-is-long-enough-for-hmac-signing';

test('installation state is signed, scoped, and expires after ten minutes', () => {
  const now = 1_800_000_000_000;
  const token = signInstallationState({ purpose: 'github_app_install', organizationId: 'org-1', userId: 'user-1' }, secret, now);
  const state = verifyInstallationState(token, secret, now + 599_000);
  assert.equal(state.organizationId, 'org-1');
  assert.equal(state.userId, 'user-1');
  assert.equal(verifyInstallationState(token, secret, now + 601_000), null);
});

test('installation state rejects tampering and weak secrets', () => {
  const token = signInstallationState({ purpose: 'github_app_install', organizationId: 'org-1', userId: 'user-1' }, secret, 1_800_000_000_000);
  assert.equal(verifyInstallationState(token + 'x', secret, 1_800_000_000_000), null);
  assert.equal(verifyInstallationState(token, 'short', 1_800_000_000_000), null);
  assert.throws(() => signInstallationState({}, 'short', 1_800_000_000_000));
});
