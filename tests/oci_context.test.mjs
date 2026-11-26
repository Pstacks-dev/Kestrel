import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveOciBuildContext } from '../worker/oci-context.mjs';

test('prefers a root Dockerfile when a repository also contains nested Dockerfiles', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'kestrel-oci-context-'));
  try {
    await mkdir(path.join(workspace, 'apps', 'web'), { recursive: true });
    await writeFile(path.join(workspace, 'Dockerfile'), 'FROM node:22-alpine\n');
    const result = await resolveOciBuildContext(workspace, ['Dockerfile', 'apps/web/Dockerfile']);
    assert.equal(result.contextDir, workspace);
    assert.equal(result.relativeContext, '.');
    assert.equal(result.dockerfile, 'Dockerfile');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('uses the sole nested Dockerfile directory as the monorepo build context', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'kestrel-oci-context-'));
  try {
    await mkdir(path.join(workspace, 'apps', 'web'), { recursive: true });
    const result = await resolveOciBuildContext(workspace, ['README.md', 'apps/web/Dockerfile']);
    assert.equal(result.contextDir, path.join(workspace, 'apps', 'web'));
    assert.equal(result.relativeContext, 'apps/web');
    assert.equal(result.dockerfile, 'Dockerfile');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('rejects ambiguous nested Dockerfiles and repositories without a Dockerfile', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'kestrel-oci-context-'));
  try {
    await assert.rejects(resolveOciBuildContext(workspace, ['apps/a/Dockerfile', 'apps/b/Dockerfile']), /Multiple nested Dockerfiles/);
    await assert.rejects(resolveOciBuildContext(workspace, ['README.md', 'package.json']), /No tracked Dockerfile/);
    await assert.rejects(resolveOciBuildContext(workspace, ['../Dockerfile']), /No tracked Dockerfile/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});


test('uses an explicit repository-relative context to select one service in a multi-service monorepo', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'kestrel-oci-context-'));
  try {
    await mkdir(path.join(workspace, 'apps', 'web'), { recursive: true });
    await mkdir(path.join(workspace, 'services', 'api'), { recursive: true });
    const result = await resolveOciBuildContext(
      workspace,
      ['apps/web/Dockerfile', 'services/api/Dockerfile'],
      'services/api',
    );
    assert.equal(result.contextDir, path.join(workspace, 'services', 'api'));
    assert.equal(result.relativeContext, 'services/api');
    assert.equal(result.dockerfile, 'Dockerfile');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('rejects unsafe or non-existent explicit monorepo build contexts', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'kestrel-oci-context-'));
  try {
    await mkdir(path.join(workspace, 'apps', 'web'), { recursive: true });
    await writeFile(path.join(workspace, 'apps', 'web', 'Dockerfile'), 'FROM node:22-alpine\\n');
    for (const context of ['../outside', '/tmp/outside', 'apps\\\\web', 'apps//web', 'apps/./web']) {
      await assert.rejects(
        resolveOciBuildContext(workspace, ['apps/web/Dockerfile'], context),
        /safe repository-relative|empty or traversal/,
        context,
      );
    }
    await assert.rejects(
      resolveOciBuildContext(workspace, ['apps/web/Dockerfile'], 'services/api'),
      /does not contain a tracked Dockerfile/,
    );
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
