import test from 'node:test';
import assert from 'node:assert/strict';
import { processGitHubInstallationDelivery } from '../server/lib/github-installation-webhooks.mjs';

function createClient({ duplicate = false, linked = true, failAudit = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('github_app_webhook_deliveries')) return { rowCount: duplicate ? 0 : 1, rows: duplicate ? [] : [{ delivery_id: params[0] }] };
      if (sql.startsWith('update public.github_app_installations')) return { rowCount: linked ? 1 : 0, rows: linked ? [{ organization_id: 'org-1' }] : [] };
      if (sql.includes('public.audit_events')) {
        if (failAudit) throw new Error('simulated transaction failure');
        return { rowCount: 1, rows: [] };
      }
      throw new Error('Unexpected query: ' + sql);
    },
  };
}

test('installation delivery updates state and writes one audit event', async () => {
  const client = createClient();
  const result = await processGitHubInstallationDelivery(client, {
    deliveryId: 'delivery-created-1', action: 'created', installationId: '12345',
  });
  assert.deepEqual(result, { duplicate: false, linked: true });
  assert.equal(client.calls.length, 3);
  assert.match(client.calls[0].sql, /on conflict \(delivery_id\) do nothing/i);
  assert.equal(client.calls[2].params[1], 'github_app.installation_created');
});

test('duplicate installation delivery has no repeated state change or audit event', async () => {
  const client = createClient({ duplicate: true });
  const result = await processGitHubInstallationDelivery(client, {
    deliveryId: 'delivery-suspend-1', action: 'suspend', installationId: '12345',
  });
  assert.deepEqual(result, { duplicate: true, linked: false });
  assert.equal(client.calls.length, 1);
});

test('installation deletion and suspension set suspended_at; restoration actions clear it', async () => {
  for (const action of ['deleted', 'suspend']) {
    const client = createClient();
    await processGitHubInstallationDelivery(client, { deliveryId: `delivery-${action.replaceAll('_', '-')}`, action, installationId: '12345' });
    assert.ok(client.calls[1].params[1]);
  }
  for (const action of ['created', 'unsuspend', 'new_permissions_accepted']) {
    const client = createClient();
    await processGitHubInstallationDelivery(client, { deliveryId: `delivery-${action}`, action, installationId: '12345' });
    assert.equal(client.calls[1].params[1], null);
  }
});

test('unlinked installation delivery is recorded without an audit event', async () => {
  const client = createClient({ linked: false });
  const result = await processGitHubInstallationDelivery(client, {
    deliveryId: 'delivery-unlinked', action: 'created', installationId: '12345',
  });
  assert.deepEqual(result, { duplicate: false, linked: false });
  assert.equal(client.calls.length, 2);
});

test('failed transactional side effect propagates so delivery can be retried', async () => {
  const client = createClient({ failAudit: true });
  await assert.rejects(() => processGitHubInstallationDelivery(client, {
    deliveryId: 'delivery-retry', action: 'suspend', installationId: '12345',
  }), /simulated transaction failure/);
});

test('rejects malformed installation delivery identifiers and unsupported actions', async () => {
  const client = createClient();
  await assert.rejects(() => processGitHubInstallationDelivery(client, {
    deliveryId: '../bad', action: 'created', installationId: '12345',
  }), /delivery ID/);
  await assert.rejects(() => processGitHubInstallationDelivery(client, {
    deliveryId: 'delivery-bad-id', action: 'created', installationId: '9223372036854775808',
  }), /installation ID/);
  await assert.rejects(() => processGitHubInstallationDelivery(client, {
    deliveryId: 'delivery-bad-action', action: 'deleted_by_admin', installationId: '12345',
  }), /Unsupported/);
  assert.equal(client.calls.length, 0);
});
