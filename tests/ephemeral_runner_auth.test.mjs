import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isEphemeralRunnerAuthorized, registerEphemeralRunnerRoutes } from '../server/routes/ephemeral-runners.mjs';

function createApp() {
  const handlers = new Map();
  return { handlers, post(path, handler) { handlers.set(path, handler); } };
}
function response() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

test('accepts only an exact configured runner secret', () => {
  const secret = 'a'.repeat(48);
  assert.equal(isEphemeralRunnerAuthorized(secret, secret), true);
  assert.equal(isEphemeralRunnerAuthorized(secret + 'x', secret), false);
});
test('rejects missing, short, or malformed runner secrets', () => {
  assert.equal(isEphemeralRunnerAuthorized('', 'a'.repeat(48)), false);
  assert.equal(isEphemeralRunnerAuthorized('a'.repeat(48), ''), false);
  assert.equal(isEphemeralRunnerAuthorized('a'.repeat(48), 'short'), false);
  assert.equal(isEphemeralRunnerAuthorized(null, 'a'.repeat(48)), false);
});
test('provision endpoint rejects unauthenticated callers before database access', async () => {
  const app = createApp();
  let transactions = 0;
  registerEphemeralRunnerRoutes(app, {
    query: async () => { throw new Error('query should not run'); },
    transaction: async () => { transactions += 1; throw new Error('transaction should not run'); },
  });
  const res = response();
  const previous = process.env.KESTREL_EPHEMERAL_RUNNER_SECRET;
  process.env.KESTREL_EPHEMERAL_RUNNER_SECRET = 'b'.repeat(48);
  try {
    await app.handlers.get('/api/runners/provision')({ headers: { authorization: 'Bearer wrong' }, body: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(transactions, 0);
  } finally {
    if (previous === undefined) delete process.env.KESTREL_EPHEMERAL_RUNNER_SECRET;
    else process.env.KESTREL_EPHEMERAL_RUNNER_SECRET = previous;
  }
});
test('provision endpoint returns no work and creates no worker when queue is empty', async () => {
  const app = createApp();
  let inserts = 0;
  registerEphemeralRunnerRoutes(app, {
    query: async () => ({ rowCount: 0, rows: [] }),
    transaction: async (fn) => fn({
      async query(sql) {
        if (sql.includes('insert into public.workers') || sql.includes('insert into public.worker_credentials')) inserts += 1;
        if (sql.includes('select p.organization_id')) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      },
    }),
  });
  const res = response();
  const previous = process.env.KESTREL_EPHEMERAL_RUNNER_SECRET;
  process.env.KESTREL_EPHEMERAL_RUNNER_SECRET = 'c'.repeat(48);
  try {
    await app.handlers.get('/api/runners/provision')({ headers: { authorization: 'Bearer ' + 'c'.repeat(48) }, body: {} }, res);
    assert.equal(res.statusCode, 204);
    assert.equal(inserts, 0);
  } finally {
    if (previous === undefined) delete process.env.KESTREL_EPHEMERAL_RUNNER_SECRET;
    else process.env.KESTREL_EPHEMERAL_RUNNER_SECRET = previous;
  }
});

test('provisions a single-use worker only for a queued organization', async () => {
  const app = createApp();
  const inserts = [];
  registerEphemeralRunnerRoutes(app, {
    query: async () => ({ rowCount: 0, rows: [] }),
    transaction: async (fn) => fn({
      async query(sql, params = []) {
        if (sql.includes('select p.organization_id')) return { rowCount: 1, rows: [{ organization_id: 'org-test' }] };
        if (sql.includes('insert into public.workers') || sql.includes('insert into public.worker_credentials')) inserts.push({ sql, params });
        return { rowCount: 1, rows: [] };
      },
    }),
  });
  const res = response();
  const previous = process.env.KESTREL_EPHEMERAL_RUNNER_SECRET;
  process.env.KESTREL_EPHEMERAL_RUNNER_SECRET = 'd'.repeat(48);
  try {
    await app.handlers.get('/api/runners/provision')({ headers: { authorization: 'Bearer ' + 'd'.repeat(48) }, body: { hostname: 'runner-1' } }, res);
    assert.equal(res.statusCode, 201);
    assert.match(res.body.workerId, /^wrk_[A-Za-z0-9_-]{20,40}$/);
    assert.equal(res.body.token.length, 43);
    assert.match(res.body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(res.body.maxJobs, 1);
    assert.equal(inserts.length, 2);
    assert.equal(inserts[0].params[1], 'org-test');
    assert.equal(inserts[1].params[0], res.body.workerId);
    assert.notEqual(inserts[1].params[1], res.body.token);
  } finally {
    if (previous === undefined) delete process.env.KESTREL_EPHEMERAL_RUNNER_SECRET;
    else process.env.KESTREL_EPHEMERAL_RUNNER_SECRET = previous;
  }
});

test('retirement disables an ephemeral worker and revokes its credential', async () => {
  const app = createApp();
  const statements = [];
  registerEphemeralRunnerRoutes(app, {
    query: async () => ({ rowCount: 0, rows: [] }),
    transaction: async (fn) => fn({
      async query(sql, params = []) {
        statements.push({ sql, params });
        return { rowCount: 1, rows: [{ id: params[0] }] };
      },
    }),
  });
  const res = response();
  const workerId = 'wrk_' + 'e'.repeat(24);
  const previous = process.env.KESTREL_EPHEMERAL_RUNNER_SECRET;
  process.env.KESTREL_EPHEMERAL_RUNNER_SECRET = 'e'.repeat(48);
  try {
    await app.handlers.get('/api/runners/retire')({ headers: { authorization: 'Bearer ' + 'e'.repeat(48) }, body: { workerId } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.retired, true);
    assert.equal(statements.length, 2);
    assert.ok(statements[0].sql.includes("desired_state = 'offline'"));
    assert.ok(statements[1].sql.includes('worker_credentials'));
  } finally {
    if (previous === undefined) delete process.env.KESTREL_EPHEMERAL_RUNNER_SECRET;
    else process.env.KESTREL_EPHEMERAL_RUNNER_SECRET = previous;
  }
});

test('workflow keeps one-time worker tokens out of global GitHub Actions environment', async () => {
  const provision = await readFile(new URL('../scripts/provision-ephemeral-runner.mjs', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/ephemeral-runners.yml', import.meta.url), 'utf8');
  assert.match(provision, /mode: 0o600/);
  assert.ok(provision.includes('kestrel-worker.env'));
  assert.doesNotMatch(provision, /GITHUB_ENV/);
  assert.match(provision, /\^\[A-Za-z0-9_-\]\{43\}\$/);
  assert.ok(workflow.includes('source "$RUNNER_TEMP/kestrel-worker.env"'));
  assert.ok(workflow.includes('rm -f "$RUNNER_TEMP/kestrel-worker.env"'));
});

test('ephemeral runner entrypoints and control-plane modules pass Node syntax checks', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const file of [
    'scripts/provision-ephemeral-runner.mjs',
    'scripts/retire-ephemeral-runner.mjs',
    'server/routes/ephemeral-runners.mjs',
    'server/control-plane.mjs',
    'worker/agent.mjs',
  ]) {
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || file + ' syntax check failed');
  }
});

test('ephemeral workflow pins third-party actions to verified immutable commits', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ephemeral-runners.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683'));
  assert.ok(workflow.includes('uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'));
  assert.doesNotMatch(workflow, /uses: actions\/(?:checkout|setup-node)@v[0-9]/);
});
