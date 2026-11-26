import test from 'node:test';
import assert from 'node:assert/strict';
import { validateKestrelEnvironment } from '../server/lib/production-preflight.mjs';

const productionEnv = {
  NODE_ENV: 'production',
  SUPABASE_DB_URL: 'postgresql://kestrel:secret@db.example:5432/postgres',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 's'.repeat(40),
  KESTREL_ENCRYPTION_KEY: 'e'.repeat(64),
  JWT_SECRET: 'j'.repeat(64),
  KESTREL_CRON_SECRET: 'c'.repeat(64),
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nexample\\n-----END PRIVATE KEY-----',
};

test('accepts a complete production environment with verified database TLS defaults', () => {
  const result = validateKestrelEnvironment(productionEnv, '22.0.0');
  assert.deepEqual(result.errors, []);
});

test('rejects missing production encryption, auth, cron and storage secrets', () => {
  const result = validateKestrelEnvironment({ NODE_ENV: 'production', SUPABASE_DB_URL: productionEnv.SUPABASE_DB_URL }, '22.0.0');
  assert.ok(result.errors.some((error) => error.includes('KESTREL_ENCRYPTION_KEY')));
  assert.ok(result.errors.some((error) => error.includes('JWT_SECRET')));
  assert.ok(result.errors.some((error) => error.includes('CRON_SECRET')));
  assert.ok(result.errors.some((error) => error.includes('SUPABASE_SERVICE_ROLE_KEY')));
});

test('rejects insecure database transport settings in production', () => {
  const result = validateKestrelEnvironment({ ...productionEnv, DB_SSL: 'disable', DB_SSL_REJECT_UNAUTHORIZED: 'false' }, '22.0.0');
  assert.ok(result.errors.some((error) => error.includes('DB_SSL=disable')));
  assert.ok(result.errors.some((error) => error.includes('DB_SSL_REJECT_UNAUTHORIZED')));
});

test('rejects non-HTTPS Supabase storage endpoints in production', () => {
  const result = validateKestrelEnvironment({ ...productionEnv, SUPABASE_URL: 'http://project.supabase.co' }, '22.0.0');
  assert.ok(result.errors.some((error) => error.includes('HTTPS URL')));
});

test('requires a valid PostgreSQL connection URL', () => {
  const result = validateKestrelEnvironment({ ...productionEnv, SUPABASE_DB_URL: 'https://example.com/db' }, '22.0.0');
  assert.ok(result.errors.some((error) => error.includes('PostgreSQL protocol')));
});

test('warns about optional integrations without failing a secure core configuration', () => {
  const result = validateKestrelEnvironment({ ...productionEnv, GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '' }, '22.0.0');
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((warning) => warning.includes('GitHub App credentials')));
});

test('allows built-in JWT development mode but still requires a PostgreSQL database', () => {
  const result = validateKestrelEnvironment({ NODE_ENV: 'development', SUPABASE_DB_URL: productionEnv.SUPABASE_DB_URL }, '22.0.0');
  assert.deepEqual(result.errors, []);
});

test('rejects unsupported Node versions', () => {
  const result = validateKestrelEnvironment(productionEnv, '18.19.0');
  assert.ok(result.errors.some((error) => error.includes('Node.js version >= 20')));
});
