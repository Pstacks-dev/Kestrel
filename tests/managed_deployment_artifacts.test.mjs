import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadStaticArtifactFiles } from '../server/routes/managed-deployments.mjs';

const bytes = Buffer.from('<!doctype html><title>Kestrel</title>');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const artifact = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  name: 'dist/index.html',
  object_key: 'org/project/run/index.html',
  size_bytes: bytes.length,
  sha256,
};

function withStorageEnv(fn) {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://storage.example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  return Promise.resolve().then(fn).finally(() => {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  });
}

test('loads only project-owned artifacts and verifies downloaded bytes', async () => withStorageEnv(async () => {
  let requestedUrl;
  const files = await loadStaticArtifactFiles(
    async () => ({ rowCount: 1, rows: [artifact] }),
    'project-1',
    [artifact.id],
    async (url, options) => {
      requestedUrl = url;
      assert.equal(options.headers.Authorization, 'Bearer test-service-key');
      return new Response(bytes, { status: 200 });
    },
  );
  assert.equal(requestedUrl, 'https://storage.example.test/storage/v1/object/kestrel-artifacts/org/project/run/index.html');
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'index.html');
  assert.deepEqual(files[0].content, bytes);
}));

test('rejects artifact IDs that are not UUIDs before querying', async () => {
  let queried = false;
  await assert.rejects(
    loadStaticArtifactFiles(async () => { queried = true; return { rowCount: 0, rows: [] }; }, 'project-1', ['../../secret']),
    /unique completed build artifacts/,
  );
  assert.equal(queried, false);
});

test('rejects artifacts that do not belong to the requested project', async () => withStorageEnv(async () => {
  await assert.rejects(
    loadStaticArtifactFiles(async () => ({ rowCount: 0, rows: [] }), 'project-1', [artifact.id]),
    /missing or do not belong/,
  );
}));

test('rejects tampered artifact bytes using the stored SHA-256 digest', async () => withStorageEnv(async () => {
  await assert.rejects(
    loadStaticArtifactFiles(async () => ({ rowCount: 1, rows: [artifact] }), 'project-1', [artifact.id],
      async () => new Response(Buffer.from('tampered'), { status: 200 })),
    /integrity check/,
  );
}));

test('rejects unsafe artifact paths before download', async () => withStorageEnv(async () => {
  let downloaded = false;
  await assert.rejects(
    loadStaticArtifactFiles(async () => ({ rowCount: 1, rows: [{ ...artifact, name: 'dist/../secret' }] }), 'project-1', [artifact.id],
      async () => { downloaded = true; return new Response(bytes); }),
    /unsafe file path/,
  );
  assert.equal(downloaded, false);
}));

test('rejects successful artifacts produced by a different commit', async () => withStorageEnv(async () => {
  let parameters;
  await assert.rejects(
    loadStaticArtifactFiles(async (_sql, values) => {
      parameters = values;
      return { rowCount: 0, rows: [] };
    }, 'project-1', [artifact.id], async () => new Response(bytes), '', 'b'.repeat(40)),
    /missing or do not belong/,
  );
  assert.equal(parameters[2], 'b'.repeat(40));
}));
