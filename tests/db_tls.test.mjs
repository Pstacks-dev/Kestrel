import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { SUPABASE_ROOT_CA_BUNDLE } from '../server/lib/supabase-ca.mjs';

test('Supabase Postgres trust bundle contains valid current production CA certificates', () => {
  const pemCertificates = SUPABASE_ROOT_CA_BUNDLE.match(
    /-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----/g
  ) || [];
  assert.equal(pemCertificates.length, 2, 'expected both Supabase production CA generations');

  for (const pem of pemCertificates) {
    const certificate = new X509Certificate(pem);
    assert.equal(certificate.ca, true, 'certificate must be a CA trust anchor');
    assert.ok(Date.parse(certificate.validTo) > Date.now(), 'CA certificate must still be valid');
    assert.match(certificate.subject, /Supabase Root 2021 CA/);
  }
});
