import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubRepository } from '../server/routes/git-import.mjs';

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
