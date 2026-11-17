import crypto from 'node:crypto';

function getJwtSecret() {
  return (
    process.env.JWT_SECRET ||
    process.env.KESTREL_ENCRYPTION_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    'kestrel-builtin-jwt-secret-minimum-32-chars-long'
  );
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
    if (computedBuf.length !== storedBuf.length) return false;
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
  const header = { alg: 'HS256', typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  
  const body = {
    ...payload,
    iat: nowSec,
    exp: nowSec + expiresInSeconds,
  };

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const headStr = b64(header);
  const bodyStr = b64(body);

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${headStr}.${bodyStr}`)
    .digest('base64url');

  return `${headStr}.${bodyStr}.${signature}`;
}

/**
 * Verify signed JWT (HS256)
 */
export function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headStr, bodyStr, signature] = parts;
  const secret = getJwtSecret();

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headStr}.${bodyStr}`)
    .digest('base64url');

  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return null;
  if (!crypto.timingSafeEqual(expectedBuf, signatureBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(bodyStr, 'base64url').toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}
