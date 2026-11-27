import test from 'node:test';
import assert from 'node:assert/strict';
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
