import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signJwt, verifyJwt } from '../server/lib/auth.mjs';

test('JWT signing refuses missing or weak fallback secrets', () => {
  const oldJwt = process.env.JWT_SECRET;
  const oldEncryption = process.env.KESTREL_ENCRYPTION_KEY;
  try {
    delete process.env.JWT_SECRET;
    delete process.env.KESTREL_ENCRYPTION_KEY;
    assert.throws(() => signJwt({ sub: 'user-1' }), /at least 32 characters/);
  } finally {
    if (oldJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwt;
    if (oldEncryption === undefined) delete process.env.KESTREL_ENCRYPTION_KEY;
    else process.env.KESTREL_ENCRYPTION_KEY = oldEncryption;
  }
});

test('built-in JWT roundtrips and rejects expired, malformed and non-HS256 tokens', () => {
  const oldJwt = process.env.JWT_SECRET;
  const oldEncryption = process.env.KESTREL_ENCRYPTION_KEY;
  process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';
  delete process.env.KESTREL_ENCRYPTION_KEY;
  try {
    const token = signJwt({ sub: 'user-1', email: 'test@example.com' }, 60);
    assert.equal(verifyJwt(token)?.sub, 'user-1');
    assert.equal(verifyJwt('not-a-token'), null);
    assert.equal(verifyJwt(signJwt({ sub: 'user-1' }, 0)), null);
    const [head, body] = token.split('.');
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const unsigned = `${noneHeader}.${body}.signature`;
    assert.equal(verifyJwt(unsigned), null);

    const tampered = `${head}.${Buffer.from(JSON.stringify({ sub: 'attacker', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')}.${token.split('.')[2]}`;
    assert.equal(verifyJwt(tampered), null);
  } finally {
    if (oldJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwt;
    if (oldEncryption === undefined) delete process.env.KESTREL_ENCRYPTION_KEY;
    else process.env.KESTREL_ENCRYPTION_KEY = oldEncryption;
  }
});
