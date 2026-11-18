import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getDockerHostWorkspacePath } from '../worker/docker-paths.mjs';

test('maps an agent workspace path to the host bind-mount path', () => {
  const actual = getDockerHostWorkspacePath(
    '/var/lib/kestrel/work',
    '/srv/kestrel-worker/work',
    '/var/lib/kestrel/work/run-1/job-1'
  );
  assert.equal(actual, path.join('/srv/kestrel-worker/work', 'run-1', 'job-1'));
});

test('uses the worker root when the agent runs directly on the Docker host', () => {
  const actual = getDockerHostWorkspacePath(
    '/srv/kestrel-worker/work',
    undefined,
    '/srv/kestrel-worker/work/run-1/job-1'
  );
  assert.equal(actual, path.join('/srv/kestrel-worker/work', 'run-1', 'job-1'));
});

test('rejects paths outside the worker workspace root', () => {
  assert.throws(
    () => getDockerHostWorkspacePath('/var/lib/kestrel/work', '/srv/kestrel-worker/work', '/tmp/unrelated'),
    /must be inside KESTREL_WORKER_WORKDIR/
  );
});
