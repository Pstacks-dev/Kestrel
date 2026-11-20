import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

test('decryptSecret fails when encrypted text or auth tag is tampered', () => {
  const secret = 'prod-db-password-xyz';
  const encrypted = encryptSecret(secret);

  // Tamper ciphertext
  const tamperedCipher = encrypted.encryptedValue.slice(0, -2) + '00';
  assert.throws(
    () => decryptSecret(tamperedCipher, encrypted.iv, encrypted.authTag),
    /Unsupported state or unable to authenticate data/
  );

  // Tamper auth tag
  const tamperedTag = encrypted.authTag.slice(0, -2) + 'ff';
  assert.throws(
    () => decryptSecret(encrypted.encryptedValue, encrypted.iv, tamperedTag),
    /Unsupported state or unable to authenticate data/
  );
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
});


test('production control plane rejects missing or weak encryption and JWT secrets', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../server/control-plane.mjs', import.meta.url), 'utf8'));
  assert.match(source, /NODE_ENV === 'production'/);
  assert.match(source, /KESTREL_ENCRYPTION_KEY.*length < 32/);
  assert.match(source, /JWT_SECRET.*length < 32/);
  assert.match(source, /Production security configuration is incomplete/);
});

test('production worker rejects default or short worker tokens', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../worker/agent.mjs', import.meta.url), 'utf8'));
  assert.match(source, /NODE_ENV === 'production'/);
  assert.match(source, /dev-worker-token-change-me/);
  assert.match(source, /TOKEN\.length < 32/);
  assert.match(source, /Production workers require a separately provisioned KESTREL_WORKER_TOKEN/);
});
