import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerReleaseRoutes } from '../server/lib/release-routes.mjs';

test('worker artifact registration, signed upload authorization, and byte verification', async () => {
  const bytes = Buffer.from('kestrel-artifact-content');
  const digest = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('select run_id from public.jobs')) return { rowCount: 1, rows: [{ run_id: 'run-1' }] };
    if (sql.includes('insert into public.artifacts')) return { rowCount: 1, rows: [{ id: 'artifact-1', objectKey: 'runs/run-1/jobs/job-1/artifact-1/dist/index.html' }] };
    if (sql.includes('select a.object_key,a.uploaded_at')) return { rowCount: 1, rows: [{ object_key: 'runs/run-1/jobs/job-1/artifact-1/dist/index.html', uploaded_at: null }] };
    if (sql.includes('select a.object_key,a.size_bytes,a.sha256 as expected_sha256')) return { rowCount: 1, rows: [{ object_key: 'runs/run-1/jobs/job-1/artifact-1/dist/index.html', size_bytes: bytes.length, expected_sha256: digest, uploaded_at: null }] };
    return { rowCount: 1, rows: [] };
  };
  const supabaseAdmin = {
    storage: {
      from: (bucket) => {
        assert.equal(bucket, 'kestrel-artifacts');
        return {
          createSignedUploadUrl: async (path, options) => {
            assert.equal(path, 'runs/run-1/jobs/job-1/artifact-1/dist/index.html');
            assert.equal(options.upsert, false);
            return { data: { path, token: 'short-lived-upload-token' }, error: null };
          },
          download: async () => ({ data: new Blob([bytes]), error: null }),
        };
      },
    },
  };
  const app = express();
  app.use(express.json());
  const passUser = (req, _res, next) => { req.user = { id: 'user-1' }; next(); };
  const passWorker = (req, _res, next) => { req.worker = { id: 'worker-1' }; next(); };
  registerReleaseRoutes(app, {
    userAuth: passUser,
    workerAuth: passWorker,
    sensitiveLimiter: (_req, _res, next) => next(),
    query,
    transaction: async (fn) => fn({ query }),
    encryptSecret: () => ({ encryptedValue: 'enc', iv: 'iv', authTag: 'tag' }),
    decryptSecret: () => 'provider-token',
    supabaseAdmin,
  });

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const registered = await fetch(base + '/api/workers/jobs/job-1/artifacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'lease-1', name: 'dist/index.html', sizeBytes: bytes.length, sha256: digest, contentType: 'text/html' }),
    });
    assert.equal(registered.status, 201);
    assert.equal((await registered.json()).id, 'artifact-1');

    const signed = await fetch(base + '/api/workers/jobs/job-1/artifacts/artifact-1/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'lease-1' }),
    });
    assert.equal(signed.status, 200);
    assert.equal((await signed.json()).token, 'short-lived-upload-token');

    const finalized = await fetch(base + '/api/workers/jobs/job-1/artifacts/artifact-1/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'lease-1', sha256: digest }),
    });
    assert.equal(finalized.status, 200);
    const result = await finalized.json();
    assert.equal(result.ok, true);
    assert.equal(result.sha256, digest);
    assert.ok(calls.some((call) => call.sql.includes('checksum_verified_at')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
