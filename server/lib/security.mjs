import crypto from 'node:crypto';

// Provider credentials, project secrets and registry credentials must never be
// encrypted with a public Supabase key or a predictable development fallback.
function getEncryptionKey() {
  const secret = process.env.KESTREL_ENCRYPTION_KEY;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('KESTREL_ENCRYPTION_KEY must be configured with at least 32 characters');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Encrypt a secret value using AES-256-GCM
 */
export function encryptSecret(plainText) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(String(plainText), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return {
    encryptedValue: encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

/**
 * Decrypt a secret value using AES-256-GCM
 */
export function decryptSecret(encryptedValue, ivHex, authTagHex) {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  
  let decrypted = decipher.update(encryptedValue, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Verify GitHub webhook HMAC-SHA256 signature
 */
export function verifyGitHubSignature(rawBody, signatureHeader, secret) {
  // GitHub sends exactly 32 digest bytes encoded as 64 hexadecimal characters.
  // Reject malformed encodings before Buffer.from(), which otherwise accepts
  // truncated and partially valid hexadecimal input.
  if ((typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) ||
      typeof signatureHeader !== 'string' ||
      !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader) ||
      typeof secret !== 'string' || secret.length === 0) {
    return false;
  }

  const expectedSignature = signatureHeader.slice('sha256='.length);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const expectedBuf = Buffer.from(expectedSignature, 'hex');
  const computedBuf = hmac.digest();

  return expectedBuf.length === computedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, computedBuf);
}

/**
 * Redact sensitive patterns and specific known secret values from logs/strings
 */
export function redactSecrets(text, knownSecrets = []) {
  if (!text || typeof text !== 'string') return text;
  
  let result = text;

  // 1. Redact known registered secrets
  for (const secret of knownSecrets) {
    if (secret && typeof secret === 'string' && secret.trim().length >= 4) {
      // Escape special regex characters in the secret value
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), '[REDACTED_SECRET]');
    }
  }

  // 2. Redact standard bearer tokens / JWTs
  result = result.replace(/Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/gi, 'Bearer [REDACTED_TOKEN]');

  // 3. Redact GitHub Personal Access Tokens and Fine-grained tokens
  result = result.replace(/gh[pousr]_[A-Za-z0-9_]{36,255}/g, 'gh[REDACTED_GITHUB_TOKEN]');

  // 4. Redact Private Keys (RSA, EC, OPENSSH)
  result = result.replace(/-----BEGIN[ A-Z0-9_-]+PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9_-]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');

  // 5. Redact HTTP Basic Auth / URL credentials (e.g., https://user:pass@host)
  result = result.replace(/(https?:\/\/)([^:\s]+):([^@\s]+)@/g, '$1$2:[REDACTED_AUTH]@');

  // 6. Redact worker tokens
  result = result.replace(/(KESTREL_WORKER_TOKEN=)([^\s]+)/g, '$1[REDACTED_WORKER_TOKEN]');

  return result;
}
