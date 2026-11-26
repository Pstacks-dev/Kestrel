import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeManagedHostingHealth } from '../server/lib/operations-health.mjs';

test('summarizes managed deployment queues, provider states and image builds', () => {
  assert.deepEqual(summarizeManagedHostingHealth({
    automationQueueRows: [{ status: 'queued', count: '3' }, { status: 'running', count: 2 }],
    deploymentRows: [
      { provider_id: 'railway', status: 'live', count: '2' },
      { provider_id: 'railway', status: 'failed', count: '1' },
      { provider_id: 'render', status: 'deploying', count: '4' },
    ],
    imageBuildRows: [{ status: 'succeeded', count: '5' }, { status: 'failed', count: '1' }],
  }), {
    automationQueue: { queued: 3, running: 2 },
    deploymentsByProvider: {
      railway: { live: 2, failed: 1 },
      render: { deploying: 4 },
    },
    imageBuilds: { succeeded: 5, failed: 1 },
  });
});

test('returns empty operational counters when no managed hosting work exists', () => {
  assert.deepEqual(summarizeManagedHostingHealth(), {
    automationQueue: {}, deploymentsByProvider: {}, imageBuilds: {},
  });
});

test('ignores malformed provider deployment rows without a provider or status', () => {
  assert.deepEqual(summarizeManagedHostingHealth({
    deploymentRows: [{ provider_id: null, status: 'live', count: '1' }, { provider_id: 'railway', status: '', count: '2' }],
  }).deploymentsByProvider, {});
});
