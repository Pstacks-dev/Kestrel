import path from 'node:path';
import fs from 'node:fs/promises';

export async function resolveJobWorkingDirectory(workspace, relativeDirectory = '.') {
  const root = await fs.realpath(workspace);
  const value = relativeDirectory === undefined || relativeDirectory === null || relativeDirectory === '' ? '.' : relativeDirectory;
  if (value === '.') return root;
  if (typeof value !== 'string' || value.length > 512 || value.startsWith('/') ||
      value.includes('\\\\') || value.includes('\\0') || /^[A-Za-z]:/.test(value)) {
    throw new Error('Job working directory must be a safe repository-relative path');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\u0000-\\u001f]/.test(part))) {
    throw new Error('Job working directory must be a safe repository-relative path');
  }
  const candidate = path.resolve(root, ...parts);
  const resolved = await fs.realpath(candidate);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Job working directory escapes the repository workspace');
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error('Job working directory is not a directory');
  return resolved;
}
