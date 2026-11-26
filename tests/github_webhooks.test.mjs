import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSupportedGitHubWebhookEvent, shouldQueuePullRequestAction, shouldIgnoreGitHubPush,
  isValidGitHubDeliveryId, isValidGitBranch, isValidGitCommitSha, isValidGitHubInstallationId, claimGitHubProjectWebhookDelivery,
} from '../server/lib/github-webhooks.mjs';

test('accepts only push and pull request webhook event types', () => {
  assert.equal(isSupportedGitHubWebhookEvent('push'), true);
  assert.equal(isSupportedGitHubWebhookEvent('pull_request'), true);
  assert.equal(isSupportedGitHubWebhookEvent('issues'), false);
});

test('queues only pull request actions that can change the tested commit', () => {
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) assert.equal(shouldQueuePullRequestAction(action), true);
  for (const action of ['closed', 'assigned', 'labeled', 'review_requested']) assert.equal(shouldQueuePullRequestAction(action), false);
});

test('ignores branch deletion pushes', () => {
  assert.equal(shouldIgnoreGitHubPush({ deleted: true, after: 'a'.repeat(40) }), true);
  assert.equal(shouldIgnoreGitHubPush({ deleted: false, after: '0'.repeat(40) }), true);
  assert.equal(shouldIgnoreGitHubPush({ deleted: false, after: 'a'.repeat(40) }), false);
});

test('validates GitHub delivery IDs', () => {
  assert.equal(isValidGitHubDeliveryId('e4a3f3c0-7f20-4e3e-b3c9-1c7a0'), true);
  assert.equal(isValidGitHubDeliveryId(''), false);
  assert.equal(isValidGitHubDeliveryId('../bad'), false);
  assert.equal(isValidGitHubDeliveryId('x'.repeat(129)), false);
});

test('validates branch names and full commit SHAs', () => {
  assert.equal(isValidGitBranch('feature/deploy-automation'), true);
  assert.equal(isValidGitBranch('../main'), false);
  assert.equal(isValidGitBranch('main//other'), false);
  assert.equal(isValidGitCommitSha('a'.repeat(40)), true);
  assert.equal(isValidGitCommitSha('not-a-sha'), false);
});

test('validates positive bounded GitHub App installation IDs', () => {
  assert.equal(isValidGitHubInstallationId('123456789'), true);
  assert.equal(isValidGitHubInstallationId('9223372036854775807'), true);
  for (const value of ['', '0', '00', '12x', '-12', '12.4', ' 12', '12 ', '9223372036854775808', null, 12]) {
    assert.equal(isValidGitHubInstallationId(value), false, String(value));
  }
});


test('push delivery retry is rejected by the durable delivery claim before a second pipeline run', async () => {
  let claimed = false;
  const client = {
    calls: 0,
    async query(sql, params) {
      this.calls += 1;
      assert.match(sql, /on conflict \(delivery_id\) do nothing returning id/i);
      assert.deepEqual(params, ['project-1', 'push-delivery-1', 'push', 'main', 'a'.repeat(40)]);
      if (claimed) return { rowCount: 0, rows: [] };
      claimed = true;
      return { rowCount: 1, rows: [{ id: 'delivery-row-1' }] };
    },
  };
  const delivery = { projectId: 'project-1', deliveryId: 'push-delivery-1', eventName: 'push', branch: 'main', commitSha: 'a'.repeat(40) };
  assert.deepEqual(await claimGitHubProjectWebhookDelivery(client, delivery), { id: 'delivery-row-1' });
  assert.equal(await claimGitHubProjectWebhookDelivery(client, delivery), null);
  assert.equal(client.calls, 2);
});

test('project webhook delivery claim rejects malformed data before touching the database', async () => {
  const client = { query: async () => { throw new Error('database should not be called'); } };
  await assert.rejects(() => claimGitHubProjectWebhookDelivery(client, {
    projectId: 'project-1', deliveryId: '../bad', eventName: 'push', branch: 'main', commitSha: 'a'.repeat(40),
  }), /Invalid GitHub project webhook delivery/);
});
