import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { deployNetlifyArtifacts } from '../server/lib/netlify-deploy.mjs';

test('Netlify deployment is created from the exact verified run artifacts', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === 'POST') {
      return new Response(JSON.stringify({
        id: 'netlify-deploy-1',
        url: 'https://release.example.net',
        state: 'building',
        required: ['/index.html'],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 200 });
  };
  try {
    const bytes = Buffer.from('<h1>Kestrel</h1>');
    const query = async (_sql, params) => {
      assert.deepEqual(params, ['run-123']);
      return {
        rowCount: 1,
        rows: [{ name: 'dist/index.html', object_key: 'runs/run-123/index.html', content_type: 'text/html' }],
      };
    };
    const supabaseAdmin = {
      storage: {
        from: (bucket) => {
          assert.equal(bucket, 'kestrel-artifacts');
          return { download: async () => ({ data: new Blob([bytes]), error: null }) };
        },
      },
    };
    const result = await deployNetlifyArtifacts({
      siteId: 'site-123', token: 'n'.repeat(32), branch: 'main', commitSha: 'a'.repeat(40),
      runId: 'run-123', query, supabaseAdmin, bucket: 'kestrel-artifacts',
    });
    assert.equal(result.id, 'netlify-deploy-1');
    assert.equal(result.url, 'https://release.example.net');
    assert.equal(calls.length, 2);
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.files['/index.html'], crypto.createHash('sha1').update(bytes).digest('hex'));
    assert.equal(calls[1].options.method, 'PUT');
    assert.equal(calls[1].options.body.toString(), bytes.toString());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Netlify deployment refuses runs without uploaded site artifacts', async () => {
  await assert.rejects(
    deployNetlifyArtifacts({
      siteId: 'site-123', token: 'n'.repeat(32), branch: 'main', commitSha: 'a'.repeat(40),
      runId: 'run-empty', query: async () => ({ rowCount: 0, rows: [] }),
      supabaseAdmin: {}, bucket: 'kestrel-artifacts',
    }),
    /no uploaded dist\\/ or build\\/ files/
  );
});
