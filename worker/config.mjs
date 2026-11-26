import { randomUUID } from 'node:crypto';

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

// Development may use a local control plane and an ephemeral identity. Production
// workers must be explicitly bound to the provisioned worker record over HTTPS.
export function resolveWorkerConnection({
  nodeEnv = process.env.NODE_ENV,
  apiUrl = process.env.KESTREL_API_URL,
  workerId = process.env.KESTREL_WORKER_ID,
  hostname = process.env.HOSTNAME || 'worker',
} = {}) {
  const production = nodeEnv === 'production';
  const endpoint = String(apiUrl || (production ? '' : 'http://127.0.0.1:4000')).trim();
  if (!endpoint) throw new Error('KESTREL_API_URL is required for production workers');

  let parsed;
  try { parsed = new URL(endpoint); }
  catch { throw new Error('KESTREL_API_URL must be a valid absolute HTTP(S) URL'); }

  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('KESTREL_API_URL must be a credential-free HTTP(S) URL without query or fragment');
  }
  if (production && parsed.protocol !== 'https:') {
    throw new Error('Production workers require an HTTPS KESTREL_API_URL');
  }

  if (production && !workerId) {
    throw new Error('Production workers require the provisioned KESTREL_WORKER_ID from the admin provisioning flow');
  }
  const resolvedWorkerId = String(workerId || `${hostname}-${randomUUID().slice(0, 5)}`).trim();
  if (!resolvedWorkerId || resolvedWorkerId.length > 120 || /[\s/?#]/.test(resolvedWorkerId)) {
    throw new Error('A valid KESTREL_WORKER_ID is required');
  }
  if (production && !/^wrk_[A-Za-z0-9_-]{8,100}$/.test(resolvedWorkerId)) {
    throw new Error('Production workers require the provisioned KESTREL_WORKER_ID from the admin provisioning flow');
  }

  return { api: parsed.toString().replace(/\/+$/, ''), workerId: resolvedWorkerId };
}
