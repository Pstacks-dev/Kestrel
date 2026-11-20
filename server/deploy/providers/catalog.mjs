export const HOSTING_PROVIDERS = Object.freeze([
  { id: 'render', name: 'Render', domains: ['onrender.com'], appTypes: ['docker'], supportsContainers: true, supportsPersistentServices: true, adapterStatus: 'api-integration' },
  { id: 'railway', name: 'Railway', domains: ['up.railway.app'], appTypes: ['static','node','python','docker'], supportsContainers: true, supportsPersistentServices: true, adapterStatus: 'api-integration' },
  { id: 'flyio', name: 'Fly.io', domains: ['fly.dev'], appTypes: ['docker'], supportsContainers: true, supportsPersistentServices: true, adapterStatus: 'api-integration' },
  { id: 'cloud-run', name: 'Google Cloud Run', domains: ['run.app'], appTypes: ['docker'], supportsContainers: true, supportsPersistentServices: true, adapterStatus: 'api-integration' },
  { id: 'aws-apprunner', name: 'AWS App Runner', domains: ['awsapprunner.com'], appTypes: ['docker'], supportsContainers: true, supportsPersistentServices: true, adapterStatus: 'api-integration' },
  { id: 'azure-container-apps', name: 'Azure Container Apps', domains: ['azurecontainerapps.io'], appTypes: ['docker'], supportsContainers: true, supportsPersistentServices: true, adapterStatus: 'api-integration' },
  { id: 'digitalocean', name: 'DigitalOcean App Platform', domains: ['ondigitalocean.app'], appTypes: ['docker'], supportsContainers: true, supportsPersistentServices: true, adapterStatus: 'api-integration' },
  { id: 'heroku', name: 'Heroku', domains: ['herokuapp.com'], appTypes: ['node','python'], supportsContainers: false, supportsPersistentServices: true, adapterStatus: 'api-integration' },
  { id: 'vercel', name: 'Vercel', domains: ['vercel.app'], appTypes: ['static','node'], supportsContainers: false, supportsPersistentServices: false, adapterStatus: 'api-integration' },
  { id: 'netlify', name: 'Netlify', domains: ['netlify.app'], appTypes: ['static'], supportsContainers: false, supportsPersistentServices: false, adapterStatus: 'api-integration' },
]);

export const HOSTING_PROVIDER_BY_ID = new Map(HOSTING_PROVIDERS.map((provider) => [provider.id, provider]));

export function getHostingProvider(providerId) {
  return HOSTING_PROVIDER_BY_ID.get(providerId) ?? null;
}

export function normalizeSubdomain(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9 -]+$/.test(trimmed)) return null;
  const normalized = trimmed.toLowerCase().replace(/ +/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (normalized.length < 2 || normalized.length > 63 || normalized.startsWith('-') || normalized.endsWith('-')) return null;
  return normalized;
}

export function providerDomainCandidates(providerId, subdomain) {
  const provider = getHostingProvider(providerId);
  const slug = normalizeSubdomain(subdomain);
  if (!provider || !slug) return [];
  return provider.domains.map((domain) => ({ domain, hostname: `${slug}.${domain}` }));
}
