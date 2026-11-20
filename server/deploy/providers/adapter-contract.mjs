import { getHostingProvider, normalizeSubdomain } from './catalog.mjs';

export const DEPLOYMENT_STATUSES = Object.freeze(['queued', 'provisioning', 'building', 'deploying', 'live', 'failed', 'cancelled', 'unknown']);

export class ProviderAdapterError extends Error {
  constructor(message, { providerId, code = 'PROVIDER_ERROR', retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'ProviderAdapterError';
    this.providerId = providerId ?? null;
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

export function validateProviderDeployRequest(providerId, request) {
  const provider = getHostingProvider(providerId);
  if (!provider) return { ok: false, error: 'Unknown hosting provider' };
  if (!request || typeof request !== 'object') return { ok: false, error: 'Deployment request is required' };
  const slug = normalizeSubdomain(request.projectSlug);
  if (!slug) return { ok: false, error: 'Project subdomain must be 2-63 characters using letters, numbers or hyphens' };
  if (!provider.appTypes.includes(request.appType)) {
    return { ok: false, error: `${provider.name} catalog does not list app type "${request.appType}" as supported` };
  }
  if (!request.artifact && !request.image) return { ok: false, error: 'A validated build artifact or immutable container image is required' };
  if (request.image && !/@sha256:[a-fA-F0-9]{64}$/.test(request.image)) {
    return { ok: false, error: 'Container deployments must use an immutable SHA-256 image digest' };
  }
  return { ok: true, provider, projectSlug: slug };
}

export function normalizeProviderStatus(value) {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (DEPLOYMENT_STATUSES.includes(status)) return status;
  const aliases = {
    ready: 'live', succeeded: 'live', success: 'live', active: 'live',
    pending: 'queued', created: 'provisioning', running: 'deploying',
    error: 'failed', failure: 'failed', stopped: 'cancelled',
  };
  return aliases[status] ?? 'unknown';
}

export function assertProviderAdapter(adapter, providerId) {
  const requiredMethods = ['validate', 'provision', 'getStatus', 'getLogs', 'cancel', 'delete'];
  const missing = requiredMethods.filter((method) => typeof adapter?.[method] !== 'function');
  if (missing.length) {
    throw new ProviderAdapterError(`Adapter is missing required methods: ${missing.join(', ')}`, {
      providerId, code: 'ADAPTER_CONTRACT_INVALID',
    });
  }
  return adapter;
}
