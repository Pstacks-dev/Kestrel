import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRelativePath } from '../server/routes/project-files.mjs';

test('accepts ordinary nested project paths', () => {
  assert.equal(cleanRelativePath('src/components/App.tsx'), 'src/components/App.tsx');
  assert.equal(cleanRelativePath('README.md'), 'README.md');
});

test('normalizes Windows separators to portable object paths', () => {
  assert.equal(cleanRelativePath('src\\components\\App.tsx'), 'src/components/App.tsx');
});

test('rejects absolute, traversal, empty and control-character paths', () => {
  for (const value of ['', '/etc/passwd', '../secret', 'src/../../secret', 'src//file', 'bad\u0000name']) {
    assert.equal(cleanRelativePath(value), null, JSON.stringify(value));
  }
});

test('rejects path segments longer than 255 characters and paths over 1024 characters', () => {
  assert.equal(cleanRelativePath('a'.repeat(256)), null);
  assert.equal(cleanRelativePath('a/'.repeat(513) + 'b'), null);
});
