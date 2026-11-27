import test from 'node:test';
import assert from 'node:assert/strict';
import { isEphemeralRunnerAuthorized } from '../server/routes/ephemeral-runners.mjs';

test('accepts only an exact configured runner secret', () => {
  const secret = 'a'.repeat(48);
  assert.equal(isEphemeralRunnerAuthorized(secret, secret), true);
  assert.equal(isEphemeralRunnerAuthorized(secret + 'x', secret), false);
});

test('rejects missing, short, or malformed runner secrets', () => {
  assert.equal(isEphemeralRunnerAuthorized('', 'a'.repeat(48)), false);
  assert.equal(isEphemeralRunnerAuthorized('a'.repeat(48), ''), false);
  assert.equal(isEphemeralRunnerAuthorized('a'.repeat(48), 'short'), false);
  assert.equal(isEphemeralRunnerAuthorized(null, 'a'.repeat(48)), false);
});
