import crypto from 'node:crypto';

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || process.env.KESTREL_ENCRYPTION_KEY || '').trim();
  if (secret.length < 32) {
    throw new Error('JWT_SECRET or KESTREL_ENCRYPTION_KEY must contain at least 32 characters; refusing to use a fallback signing key.');
  }
  return secret;
}

/**
 * Hash password with PBKDF2 (100,000 iterations, SHA-512)
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 100_000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

/**
 * Verify password against stored PBKDF2 hash
 */
export function verifyPassword(password, salt, storedHash) {
  try {
    const computed = crypto.pbkdf2Sync(String(password), salt, 100_000, 64, 'sha512').toString('hex');
    const computedBuf = Buffer.from(computed, 'hex');
    const storedBuf = Buffer.from(storedHash, 'hex');
    if (computedBuf.length !== storedBuf.length || computedBuf.length === 0) return false;
    return crypto.timingSafeEqual(computedBuf, storedBuf);
  } catch {
    return false;
  }
}

/**
 * Issue a standard signed JWT (HS256)
 */
export function signJwt(payload, expiresInSeconds = 7 * 86400) {
  const secret = getJwtSecret();
  const ttl = Number(expiresInSeconds);
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 30 * 86400) {
    throw new Error('JWT lifetime must be between 1 second and 30 days.');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: nowSec, exp: nowSec + ttl };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const headStr = b64({ alg: 'HS256', typ: 'JWT' });
  const bodyStr = b64(body);
  const signature = crypto.createHmac('sha256', secret).update(`${headStr}.${bodyStr}`).digest('base64url');
  return `${headStr}.${bodyStr}.${signature}`;
}

/**
 * Verify signed JWT (HS256). Invalid tokens fail closed.
 */
export function verifyJwt(token) {
  if (!token || typeof token !== 'string' || token.length > 16_384) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;

  try {
    const [headStr, bodyStr, signature] = parts;
    const header = JSON.parse(Buffer.from(headStr, 'base64url').toString('utf8'));
    if (header?.alg !== 'HS256' || header?.typ !== 'JWT') return null;

    const secret = getJwtSecret();
    const expected = crypto.createHmac('sha256', secret).update(`${headStr}.${bodyStr}`).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

    const payload = JSON.parse(Buffer.from(bodyStr, 'base64url').toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (!Number.isSafeInteger(payload.exp) || payload.exp <= nowSec) return null;
    if (payload.iat !== undefined && (!Number.isSafeInteger(payload.iat) || payload.iat > nowSec + 60)) return null;
    return payload;
  } catch {
    return null;
  }
}
