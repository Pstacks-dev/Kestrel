import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubRepository, isValidGitHubInstallationId } from '../server/routes/git-import.mjs';

test('parses ordinary GitHub repository URLs', () => {
  assert.deepEqual(parseGitHubRepository('https://github.com/acme/store'), { owner: 'acme', repo: 'store' });
  assert.deepEqual(parseGitHubRepository('https://github.com/acme/store.git'), { owner: 'acme', repo: 'store' });
  assert.deepEqual(parseGitHubRepository('https://github.com/Acme/store/'), { owner: 'Acme', repo: 'store' });
});

test('rejects unsafe or unsupported repository URLs', () => {
  for (const value of [
    'http://github.com/acme/store',
    'https://github.com.evil.test/acme/store',
    'https://user:pass@github.com/acme/store',
    'https://github.com/acme/store?token=secret',
    'https://github.com/acme/store/tree/main',
    'https://gitlab.com/acme/store',
    'javascript:alert(1)',
    '',
    null,
  ]) assert.equal(parseGitHubRepository(value), null, String(value));
});


test('accepts numeric GitHub App installation IDs and rejects malformed values', () => {
  assert.equal(isValidGitHubInstallationId('123456789'), true);
  assert.equal(isValidGitHubInstallationId('0'), true);
  for (const value of ['', '12a34', '-123', '123.4', ' 123', '123 ', null, 123]) {
    assert.equal(isValidGitHubInstallationId(value), false, String(value));
  }
});
