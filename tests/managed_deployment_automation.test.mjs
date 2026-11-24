import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutomaticallyDeployRun } from '../server/lib/managed-deployment-automation.mjs';

test('automatically deploys only successful pushes to the configured default branch', () => {
  assert.equal(shouldAutomaticallyDeployRun({
    status: 'succeeded', eventName: 'push', branch: 'main', defaultBranch: 'main',
  }), true);
  assert.equal(shouldAutomaticallyDeployRun({
    status: 'succeeded', eventName: 'push', branch: 'trunk', defaultBranch: 'trunk',
  }), true);
  assert.equal(shouldAutomaticallyDeployRun({
    status: 'succeeded', eventName: 'push', branch: 'feature/login', defaultBranch: 'main',
  }), false);
  assert.equal(shouldAutomaticallyDeployRun({
    status: 'failed', eventName: 'push', branch: 'main', defaultBranch: 'main',
  }), false);
  assert.equal(shouldAutomaticallyDeployRun({
    status: 'succeeded', eventName: 'pull_request', branch: 'main', defaultBranch: 'main',
  }), false);
});

test('uses main only when a project has no configured default branch', () => {
  assert.equal(shouldAutomaticallyDeployRun({
    status: 'succeeded', eventName: 'push', branch: 'main', defaultBranch: null,
  }), true);
  assert.equal(shouldAutomaticallyDeployRun({
    status: 'succeeded', eventName: 'push', branch: 'master', defaultBranch: null,
  }), false);
});
