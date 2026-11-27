import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDockerEnvironment } from '../worker/docker-environment.mjs';

test('passes Docker secrets through child environment, not command arguments', () => {
  const secret = 'sensitive-value-with-equals=a';
  const result = buildDockerEnvironment({ API_TOKEN: secret, MULTILINE: 'line one\nline two' }, { PATH: '/usr/bin' });
  assert.deepEqual(result.args, ['--env', 'API_TOKEN', '--env', 'MULTILINE']);
  assert.equal(result.env.API_TOKEN, secret);
  assert.equal(result.env.MULTILINE, 'line one\nline two');
  assert.equal(result.args.includes(secret), false);
  assert.equal(result.env.PATH, '/usr/bin');
});

test('ignores invalid environment keys and nullish values', () => {
  const result = buildDockerEnvironment({
    'BAD=KEY': 'ignored',
    '9INVALID': 'ignored',
    EMPTY: null,
    GOOD_KEY: 'kept',
  }, {});
  assert.deepEqual(result.args, ['--env', 'GOOD_KEY']);
  assert.deepEqual(result.env, { GOOD_KEY: 'kept' });
});

test('does not enumerate arrays or primitive secret payloads', () => {
  assert.deepEqual(buildDockerEnvironment(['x'], {}).args, []);
  assert.deepEqual(buildDockerEnvironment('not-an-object', {}).args, []);
});
