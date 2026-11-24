import path from 'node:path';
import { stat } from 'node:fs/promises';

/**
 * Select a deterministic Docker build context from files tracked at the pinned
 * commit. Prefer a root Dockerfile; otherwise accept exactly one nested
 * Dockerfile. Multiple nested Dockerfiles require an explicit project setting.
 */
export async function resolveOciBuildContext(workspace, trackedPaths) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || !Array.isArray(trackedPaths)) {
    throw new Error('A workspace and tracked Git paths are required');
  }
  const dockerfiles = [...new Set(trackedPaths.filter((entry) => {
    if (typeof entry !== 'string' || !entry || entry.includes('\\')) return false;
    const parts = entry.split('/');
    return !entry.startsWith('/') && !parts.some((part) => !part || part === '.' || part === '..') &&
      parts.at(-1).toLowerCase() === 'dockerfile';
  }))].sort();
  if (!dockerfiles.length) throw new Error('No tracked Dockerfile was found at the pipeline commit');
  const selected = dockerfiles.includes('Dockerfile')
    ? 'Dockerfile'
    : dockerfiles.length === 1 ? dockerfiles[0] : null;
  if (!selected) {
    throw new Error('Multiple nested Dockerfiles were found; configure an explicit build context before deploying this monorepo');
  }
  const relativeContext = path.posix.dirname(selected) === '.' ? '.' : path.posix.dirname(selected);
  const contextDir = path.resolve(workspace, ...relativeContext.split('/').filter((part) => part !== '.'));
  if (contextDir !== path.resolve(workspace) && !contextDir.startsWith(path.resolve(workspace) + path.sep)) {
    throw new Error('Detected Docker build context escapes the checked-out repository');
  }
  const info = await stat(contextDir).catch(() => null);
  if (!info?.isDirectory()) throw new Error('Detected Docker build context does not exist in the checked-out repository');
  return {
    contextDir,
    relativeContext,
    dockerfile: path.posix.basename(selected),
  };
}
