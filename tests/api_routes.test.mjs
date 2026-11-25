import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../server/control-plane.mjs';

test('API Endpoints and Security Middleware', async (t) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
  });

  await t.test('GET /api/health returns health info or handles disconnected db gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.ok(res.status === 200 || res.status === 503);
    const data = await res.json();
    if (res.status === 200) {
      assert.equal(data.service, 'kestrel-control-plane');
      assert.equal(data.version, '1.0.0');
    } else {
      assert.equal(data.database, 'unavailable');
    }
  });

  await t.test('POST /api/workspaces rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp' }),
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.match(data.error, /Authentication required/i);
  });

  await t.test('workspace Rust worker provisioning rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/00000000-0000-0000-0000-000000000000/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Deployment worker', runtime: 'rust' }),
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.match(data.error, /Authentication required/i);
  });

  await t.test('sandbox workspace routes reject unauthenticated requests', async () => {
    const list = await fetch(`${baseUrl}/api/workspaces/00000000-0000-0000-0000-000000000000/sandboxes`);
    assert.equal(list.status, 401);
    const commands = await fetch(`${baseUrl}/api/sandboxes/00000000-0000-0000-0000-000000000000/commands`, { method: 'POST' });
    assert.equal(commands.status, 401);
  });

  await t.test('POST /api/workers/register rejects unauthenticated worker requests', async () => {
    const res = await fetch(`${baseUrl}/api/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: 'wrk_123' }),
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.match(data.error, /Worker credentials required/i);
  });

  await t.test('POST /api/webhooks/github handles ping event without auth requirement', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'ping',
      },
      body: JSON.stringify({ zen: 'Keep it logically awesome.' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.match(data.message, /Pong/i);
  });

  await t.test('POST /api/webhooks/github rejects payload missing repository info', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'push',
      },
      body: JSON.stringify({
        ref: 'refs/heads/main',
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /Missing repository information/i);
  });

  await t.test('GET /api/cron/recovery rejects unauthorized cron requests when CRON_SECRET is set', async () => {
    process.env.CRON_SECRET = 'super-secret-cron-token';
    const res = await fetch(`${baseUrl}/api/cron/recovery`);
    assert.equal(res.status, 401);
    delete process.env.CRON_SECRET;
  });

  await t.test('POST Supabase Cron endpoints accept the method and reject missing credentials', async () => {
    process.env.KESTREL_CRON_SECRET = 'supabase-cron-test-token';
    try {
      for (const path of ['/api/cron/recovery', '/api/cron/managed-deployments']) {
        const res = await fetch(`${baseUrl}${path}`, { method: 'POST' });
        assert.equal(res.status, 401, `${path} should reach cron auth, not return 404`);
      }
    } finally {
      delete process.env.KESTREL_CRON_SECRET;
    }
  });
});
