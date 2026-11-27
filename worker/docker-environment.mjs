/**
 * Build Docker CLI environment arguments without putting secret values in argv.
 * Docker resolves each bare --env KEY from the child process environment.
 */
export function buildDockerEnvironment(secrets = {}, baseEnv = {}) {
  const env = { ...baseEnv };
  const args = [];
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
    return { args, env };
  }
  for (const [key, value] of Object.entries(secrets)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value === undefined || value === null) continue;
    env[key] = String(value);
    args.push('--env', key);
  }
  return { args, env };
}
