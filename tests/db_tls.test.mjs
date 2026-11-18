import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { SUPABASE_ROOT_CA_BUNDLE } from '../server/lib/supabase-ca.mjs';
import { normalizeConnectionString } from '../server/lib/db.mjs';

test('Supabase Postgres trust bundle contains valid current production CA certificates', () => {
  const pemCertificates = SUPABASE_ROOT_CA_BUNDLE.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
  ) || [];
  assert.equal(pemCertificates.length, 2, 'expected both Supabase production CA generations');

  for (const pem of pemCertificates) {
    const certificate = new X509Certificate(pem);
    assert.equal(certificate.ca, true, 'certificate must be a CA trust anchor');
    assert.ok(Date.parse(certificate.validTo) > Date.now(), 'CA certificate must still be valid');
    assert.match(certificate.subject, /Supabase Root 2021 CA/);
  }
});

test('connection string SSL parameters cannot override the pinned TLS trust bundle', () => {
  const original = 'postgresql://postgres:encoded%40password@pooler.example.com:6543/postgres?sslmode=require&sslrootcert=%2Ftmp%2Fother.crt&application_name=kestrel';
  const normalized = new URL(normalizeConnectionString(original));
  assert.equal(normalized.hostname, 'pooler.example.com');
  assert.equal(normalized.port, '6543');
  assert.equal(normalized.searchParams.get('application_name'), 'kestrel');
  assert.equal(normalized.searchParams.has('sslmode'), false);
  assert.equal(normalized.searchParams.has('sslrootcert'), false);
  assert.equal(normalized.username, 'postgres');
  assert.equal(normalized.password, 'encoded%40password');
});
