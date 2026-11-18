import test from 'node:test';
import assert from 'node:assert/strict';
import { validImage, validHealthPath, validPublicUrl } from '../server/routes/deployments.mjs';
import { validArtifactName } from '../server/routes/artifacts.mjs';

test('accepts valid registry image references', () => {
  assert.equal(validImage('nginx:1.27'), true);
  assert.equal(validImage('ghcr.io/acme/web:2026.11'), true);
  assert.equal(validImage('ghcr.io/acme/web@sha256:' + 'a'.repeat(64)), true);
});

test('rejects unsafe image references', () => {
  assert.equal(validImage('nginx; rm -rf /'), false);
  assert.equal(validImage('../private/image'), false);
  assert.equal(validImage('https://example.com/app'), false);
});

test('validates local health-check paths', () => {
  assert.equal(validHealthPath('/health'), true);
  assert.equal(validHealthPath('/ready?full=1'), true);
  assert.equal(validHealthPath('../../admin'), false);
  assert.equal(validHealthPath('https://example.com/health'), false);
});

test('accepts only credential-free HTTP application URLs', () => {
  assert.equal(validPublicUrl('https://app.example.com'), 'https://app.example.com');
  assert.equal(validPublicUrl('javascript:alert(1)'), null);
  assert.equal(validPublicUrl('https://user:pass@example.com'), null);
});

test('allows nested artifact paths but rejects traversal and absolute paths', () => {
  assert.equal(validArtifactName('dist/assets/app.js'), true);
  assert.equal(validArtifactName('../secret'), false);
  assert.equal(validArtifactName('dist/../../secret'), false);
  assert.equal(validArtifactName('/etc/passwd'), false);
  assert.equal(validArtifactName('dist\\secret'), false);
  assert.equal(validArtifactName('dist//app.js'), false);
});
