// Resolve the per-worker credential supplied once by the Kestrel admin provisioning flow.
export function resolveWorkerToken({
  nodeEnv = process.env.NODE_ENV,
  token = process.env.KESTREL_WORKER_TOKEN,
} = {}) {
  const allowDevelopmentFallback = nodeEnv === 'development' || nodeEnv === 'test';
  const resolved = token || (allowDevelopmentFallback ? 'kestrel-development-only-worker-token-unsafe' : '');
  if (typeof resolved !== 'string' || resolved.trim().length < 32) {
    throw new Error('A provisioned KESTREL_WORKER_TOKEN of at least 32 characters is required');
  }
  return resolved.trim();
}
