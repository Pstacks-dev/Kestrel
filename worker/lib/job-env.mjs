import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function createDockerEnvFile(secrets = {}) {
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
    throw new TypeError('Job secrets must be an object.');
  }

  const lines = [];
  for (const [key, rawValue] of Object.entries(secrets)) {
    if (!KEY.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    const value = String(rawValue ?? '');
    if (/[\r\n\0]/.test(value)) {
      throw new Error(`Secret ${key} contains a newline or NUL byte and cannot be passed safely as a Docker env-file value.`);
    }
    lines.push(`${key}=${value}`);
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kestrel-job-env-'));
  const filePath = path.join(directory, 'secrets.env');
  try {
    await fs.writeFile(filePath, lines.join('\n') + (lines.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let cleaned = false;
  return {
    path: filePath,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

export function createLocalJobEnv(baseEnv, secrets = {}) {
  const safe = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT', 'WINDIR']) {
    if (baseEnv[key] !== undefined) safe[key] = baseEnv[key];
  }
  for (const [key, value] of Object.entries(secrets || {})) {
    if (!KEY.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    safe[key] = String(value ?? '');
  }
  safe.CI = 'true';
  safe.KESTREL = 'true';
  return safe;
}
