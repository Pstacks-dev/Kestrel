import crypto from 'node:crypto';

// Encryption key derivation: uses KESTREL_ENCRYPTION_KEY or a SHA-256 derived from server secret
function getEncryptionKey() {
  const secret = process.env.KESTREL_ENCRYPTION_KEY || process.env.SUPABASE_ANON_KEY || 'kestrel-default-dev-encryption-key-32';
  return crypto.createHash('sha256').update(secret).digest();
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
  if (!signatureHeader || !secret) return false;
  
  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') return false;
  
  const expectedSignature = parts[1];
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const computedSignature = hmac.digest('hex');
  
  try {
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const computedBuf = Buffer.from(computedSignature, 'hex');
    if (expectedBuf.length !== computedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, computedBuf);
  } catch {
    return false;
  }
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
