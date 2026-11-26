import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.KESTREL_ENCRYPTION_KEY ||= 'kestrel-test-encryption-key-32-characters-minimum';

import {
  encryptSecret,
  decryptSecret,
  verifyGitHubSignature,
  redactSecrets,
} from '../server/lib/security.mjs';

test('encryptSecret and decryptSecret roundtrip with AES-256-GCM', () => {
  const secret = 'super-secret-api-key-12345';
  const encrypted = encryptSecret(secret);
  
  assert.ok(encrypted.encryptedValue);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.authTag);
  assert.notEqual(encrypted.encryptedValue, secret);

  const decrypted = decryptSecret(encrypted.encryptedValue, encrypted.iv, encrypted.authTag);
  assert.equal(decrypted, secret);
});

test('encryption refuses missing or weak dedicated keys instead of falling back to public secrets', () => {
  const original = process.env.KESTREL_ENCRYPTION_KEY;
  try {
    delete process.env.KESTREL_ENCRYPTION_KEY;
    assert.throws(() => encryptSecret('must-not-use-an-insecure-fallback'), /KESTREL_ENCRYPTION_KEY/);
    process.env.KESTREL_ENCRYPTION_KEY = 'short';
    assert.throws(() => encryptSecret('must-not-use-a-weak-key'), /at least 32 characters/);
  } finally {
    if (original === undefined) delete process.env.KESTREL_ENCRYPTION_KEY;
    else process.env.KESTREL_ENCRYPTION_KEY = original;
  }
});

test('decryptSecret fails when encrypted text or auth tag is tampered', () => {
  const secret = 'prod-db-password-xyz';
  const encrypted = encryptSecret(secret);

  // Tamper ciphertext
  const tamperedCipher = (encrypted.encryptedValue[0] === '0' ? '1' : '0') + encrypted.encryptedValue.slice(1);
  assert.throws(() => decryptSecret(tamperedCipher, encrypted.iv, encrypted.authTag));

  // Tamper auth tag
  const tamperedTag = (encrypted.authTag[0] === '0' ? '1' : '0') + encrypted.authTag.slice(1);
  assert.throws(() => decryptSecret(encrypted.encryptedValue, encrypted.iv, tamperedTag));
});

test('redactSecrets masks custom project secrets and standard credentials', () => {
  const customSecret = 'my-super-secret-token-val-999';
  const logMessage = `Connecting with ${customSecret} and Bearer eyJhbGciOiJIUzI1Ni.test.token`;
  
  const redacted = redactSecrets(logMessage, [customSecret]);
  assert.ok(!redacted.includes(customSecret));
  assert.ok(redacted.includes('[REDACTED_SECRET]'));
  assert.ok(redacted.includes('Bearer [REDACTED_TOKEN]'));
});

test('redactSecrets masks GitHub tokens and private keys', () => {
  const ghTokenLog = 'Fetching repo using ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  const redactedGh = redactSecrets(ghTokenLog);
  assert.ok(!redactedGh.includes('ghp_'));
  assert.ok(redactedGh.includes('gh[REDACTED_GITHUB_TOKEN]'));

  const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3X7...
-----END RSA PRIVATE KEY-----`;
  const keyLog = `Loaded key:\n${privateKey}`;
  const redactedKey = redactSecrets(keyLog);
  assert.ok(!redactedKey.includes('MIIEowIBAAKCAQEA0Y3X7'));
  assert.ok(redactedKey.includes('[REDACTED_PRIVATE_KEY]'));
});

test('verifyGitHubSignature correctly validates HMAC-SHA256 signatures', () => {
  const webhookSecret = 'test-webhook-secret-42';
  const payload = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'acme/webapp' } });
  
  const signature = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');

  // Valid signature
  assert.equal(verifyGitHubSignature(payload, signature, webhookSecret), true);

  // Tampered payload
  const tamperedPayload = JSON.stringify({ ref: 'refs/heads/hack' });
  assert.equal(verifyGitHubSignature(tamperedPayload, signature, webhookSecret), false);

  // Wrong secret
  assert.equal(verifyGitHubSignature(payload, signature, 'wrong-secret'), false);

  // Malformed signature header
  assert.equal(verifyGitHubSignature(payload, 'invalid-signature-header', webhookSecret), false);
  assert.equal(verifyGitHubSignature(payload, null, webhookSecret), false);
  for (const malformed of [
    'sha256=',
    'sha256=abcd',
    'sha256=' + 'g'.repeat(64),
    'sha256=' + 'a'.repeat(63),
    'sha256=' + 'a'.repeat(65),
    'sha1=' + 'a'.repeat(64),
    'sha256=' + 'a'.repeat(62) + 'zz',
    'sha256=' + 'a'.repeat(64) + '=',
  ]) {
    assert.equal(verifyGitHubSignature(payload, malformed, webhookSecret), false, malformed);
  }
  assert.equal(verifyGitHubSignature(null, signature, webhookSecret), false);
  assert.equal(verifyGitHubSignature(payload, signature, ''), false);
  assert.equal(verifyGitHubSignature(payload, ['sha256=' + 'a'.repeat(64)], webhookSecret), false);
  const rawBytes = Buffer.from(payload);
  const byteSignature = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBytes).digest('hex');
  assert.equal(verifyGitHubSignature(rawBytes, byteSignature, webhookSecret), true);
});
