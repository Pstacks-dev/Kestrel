import test from 'node:test';
import assert from 'node:assert/strict';
import { processManagedHostingQueue } from '../server/lib/managed-hosting-automation.mjs';

test('managed hosting queue processor exits cleanly when no events are ready', async () => {
  const queries = [];
  const result = await processManagedHostingQueue({
    query: async (sql) => { queries.push(sql); return { rowCount: 0, rows: [] }; },
    transaction: async () => { throw new Error('No transaction should be opened'); },
  });
  assert.deepEqual(result, { processed: 0 });
  assert.match(queries[0], /for update skip locked/i);
});

test('skips an automation event if its pipeline is no longer successful', async () => {
  const queueItem = {
    id: 'queue-1', pipeline_run_id: 'run-1', attempt_count: 1,
    locked_at: '2026-11-26T12:00:00.000Z',
  };
  const updates = [];
  let claim = true;
  const result = await processManagedHostingQueue({
    query: async (sql, params) => {
      if (/with candidate as/i.test(sql)) {
        if (!claim) return { rowCount: 0, rows: [] };
        claim = false;
        return { rowCount: 1, rows: [queueItem] };
      }
      if (/select r.id as run_id/i.test(sql)) return { rowCount: 1, rows: [{ run_id: 'run-1', run_status: 'failed' }] };
      if (/update public.managed_hosting_automation_queue/i.test(sql)) {
        updates.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      throw new Error('Unexpected query in managed deployment queue test');
    },
    transaction: async () => { throw new Error('No transaction should be opened'); },
  });
  assert.deepEqual(result, { processed: 1 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[1], 'skipped');
  assert.match(updates[0].sql, /locked_at = \$6::timestamptz/i);
  assert.equal(updates[0].params[5], queueItem.locked_at);
});

test('bounds each queue batch to at most twenty events', async () => {
  let claims = 0;
  await processManagedHostingQueue({
    query: async (sql) => {
      if (/with candidate as/i.test(sql)) {
        claims += 1;
        return { rowCount: 1, rows: [{ id: `queue-${claims}`, pipeline_run_id: `run-${claims}`, attempt_count: 1 }] };
      }
      if (/select r.id as run_id/i.test(sql)) return { rowCount: 1, rows: [{ run_id: 'run', run_status: 'failed' }] };
      if (/update public.managed_hosting_automation_queue/i.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected query in bounded queue test');
    },
    transaction: async () => {},
  }, 1000);
  assert.equal(claims, 20);
});


test('accepts valid GitHub repository URLs regardless of repository visibility', async () => {
  const { parseGitHubRepository } = await import('../server/lib/managed-hosting-automation.mjs');
  assert.deepEqual(parseGitHubRepository('https://github.com/acme/private-app.git'), {
    owner: 'acme', repo: 'private-app',
  });
  assert.deepEqual(parseGitHubRepository('https://github.com/acme/public-app'), {
    owner: 'acme', repo: 'public-app',
  });
});

test('rejects non-canonical or credential-bearing GitHub repository URLs', async () => {
  const { parseGitHubRepository } = await import('../server/lib/managed-hosting-automation.mjs');
  assert.equal(parseGitHubRepository('http://github.com/acme/app'), null);
  assert.equal(parseGitHubRepository('https://github.com.evil.test/acme/app'), null);
  assert.equal(parseGitHubRepository('https://user:password@github.com/acme/app'), null);
  assert.equal(parseGitHubRepository('https://github.com/acme/app?token=secret'), null);
  assert.equal(parseGitHubRepository('https://github.com/acme/app/tree/main'), null);
});

test('inspects private repository source using the short-lived installation token', async () => {
  const { inspectGitHubSource } = await import('../server/lib/managed-hosting-automation.mjs');
  const token = 'ghs-test-short-lived-token';
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    if (url.includes('/contents/?')) {
      return { ok: true, json: async () => [{ name: 'package.json', type: 'file' }] };
    }
    return {
      ok: true,
      json: async () => ({ content: Buffer.from(JSON.stringify({
        dependencies: { vite: '^6.0.0' },
      })).toString('base64') }),
    };
  };
  const profile = await inspectGitHubSource(
    { owner: 'acme', repo: 'private-app' },
    'a'.repeat(40),
    fetchImpl,
    token,
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.authorization === `Bearer ${token}`));
  assert.equal(profile.isStatic, true);
});

test('does not expose installation tokens in GitHub source inspection errors', async () => {
  const { inspectGitHubSource } = await import('../server/lib/managed-hosting-automation.mjs');
  const token = 'ghs-never-log-this-token';
  const fetchImpl = async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return { ok: false, status: 403 };
  };
  await assert.rejects(
    inspectGitHubSource({ owner: 'acme', repo: 'private-app' }, 'b'.repeat(40), fetchImpl, token),
    (error) => {
      assert.match(error.message, /403/);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    },
  );
});

test('refuses a suspended or cross-workspace installation before requesting a token', async () => {
  const queueItem = { id: 'queue-private', pipeline_run_id: 'run-private', attempt_count: 1 };
  const updates = [];
  let claim = true;
  let tokenRequests = 0;
  const result = await processManagedHostingQueue({
    query: async (sql, params) => {
      if (/with candidate as/i.test(sql)) {
        if (!claim) return { rowCount: 0, rows: [] };
        claim = false;
        return { rowCount: 1, rows: [queueItem] };
      }
      if (/select r.id as run_id/i.test(sql)) return {
        rowCount: 1,
        rows: [{
          run_id: 'run-private', project_id: 'project-1', branch: 'main',
          commit_sha: 'c'.repeat(40), run_status: 'succeeded',
          organization_id: 'org-1', project_name: 'Private app',
          repository_url: 'https://github.com/acme/private-app',
          default_branch: 'main', source_type: 'git', github_installation_id: 12345,
        }],
      };
      if (/from public.github_app_installations/i.test(sql)) {
        assert.deepEqual(params, [12345, 'org-1']);
        return { rowCount: 0, rows: [] };
      }
      if (/update public.managed_hosting_automation_queue/i.test(sql)) {
        updates.push(params);
        return { rowCount: 1, rows: [] };
      }
      throw new Error('Unexpected query in private repository installation test');
    },
    createInstallationToken: async () => { tokenRequests += 1; throw new Error('must not request token'); },
    transaction: async () => { throw new Error('No transaction should be opened'); },
  });
  assert.deepEqual(result, { processed: 1 });
  assert.equal(tokenRequests, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][1], 'queued'); // Retryable installation failures are re-queued.
  assert.match(updates[0][2], /missing, suspended, or not linked/);
});


test('claims image-waiting jobs and reclaims expired running leases safely', async () => {
  let claimSql = '';
  const result = await processManagedHostingQueue({
    query: async (sql) => {
      claimSql = sql;
      return { rowCount: 0, rows: [] };
    },
    transaction: async () => { throw new Error('No transaction should be opened'); },
  });
  assert.deepEqual(result, { processed: 0 });
  assert.match(claimSql, /'queued','failed','waiting_for_image'/i);
  assert.match(claimSql, /q\.status = 'running'.*q\.locked_at is null or q\.locked_at < now\(\) - interval '10 minutes'/is);
  assert.match(claimSql, /running\.id <> q\.id/i);
  assert.match(claimSql, /case when q\.status = 'waiting_for_image' then 0 else 1 end/i);
});

test('uses a claim timestamp as a fencing token for image-wait state transitions', async () => {
  let claimSql = '';
  await processManagedHostingQueue({
    query: async (sql) => {
      claimSql = sql;
      return { rowCount: 0, rows: [] };
    },
    transaction: async () => {},
  });
  assert.match(claimSql, /locked_at = now\(\).*returning q\.\*/is);
});
