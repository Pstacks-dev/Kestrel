import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveJobWorkingDirectory } from '../worker/working-directory.mjs';

test('resolves a nested job directory inside the checked-out repository', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kestrel-job-root-'));
  try {
    await fs.mkdir(path.join(workspace, 'apps', 'web'), { recursive: true });
    assert.equal(await resolveJobWorkingDirectory(workspace, 'apps/web'), path.join(workspace, 'apps', 'web'));
    assert.equal(await resolveJobWorkingDirectory(workspace, '.'), workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('rejects traversal, absolute paths and Windows separators', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kestrel-job-root-'));
  try {
    for (const value of ['../outside', '/etc', 'C:/repo', 'apps\\web', 'apps//web', './apps/web']) {
      await assert.rejects(resolveJobWorkingDirectory(workspace, value), /safe repository-relative path/);
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('rejects symlinked working directories that escape the workspace', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kestrel-job-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kestrel-job-outside-'));
  try {
    await fs.symlink(outside, path.join(workspace, 'escape'), 'dir');
    await assert.rejects(resolveJobWorkingDirectory(workspace, 'escape'), /escapes the repository workspace/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
