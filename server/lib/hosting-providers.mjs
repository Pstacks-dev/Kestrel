const PROVIDERS = [
  { id: 'render', name: 'Render', category: 'container-paas', fullStack: true, static: true, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: true, runtimes: ['node','python','go','ruby','php','docker'], env: ['RENDER_API_KEY'], docs: 'https://render.com/docs' },
  { id: 'railway', name: 'Railway', category: 'container-paas', fullStack: true, static: true, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: true, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['RAILWAY_API_TOKEN'], docs: 'https://docs.railway.com' },
  { id: 'flyio', name: 'Fly.io', category: 'container-paas', fullStack: true, static: true, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: false, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['FLY_API_TOKEN'], docs: 'https://fly.io/docs' },
  { id: 'google-cloud-run', name: 'Google Cloud Run', category: 'managed-containers', fullStack: true, static: false, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: false, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['GOOGLE_CLOUD_PROJECT','GOOGLE_APPLICATION_CREDENTIALS'], docs: 'https://cloud.google.com/run/docs' },
  { id: 'aws-app-runner', name: 'AWS App Runner', category: 'managed-containers', fullStack: true, static: true, containers: true, persistentProcesses: true, backgroundWorkers: false, databases: false, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_REGION'], docs: 'https://docs.aws.amazon.com/apprunner' },
  { id: 'digitalocean-app-platform', name: 'DigitalOcean App Platform', category: 'container-paas', fullStack: true, static: true, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: true, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['DIGITALOCEAN_ACCESS_TOKEN'], docs: 'https://docs.digitalocean.com/products/app-platform' },
  { id: 'heroku', name: 'Heroku', category: 'container-paas', fullStack: true, static: true, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: true, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['HEROKU_API_KEY'], docs: 'https://devcenter.heroku.com' },
  { id: 'vercel', name: 'Vercel', category: 'frontend-serverless', fullStack: true, static: true, containers: true, persistentProcesses: false, backgroundWorkers: false, databases: false, runtimes: ['node','python','go','ruby','rust','docker'], env: ['VERCEL_TOKEN'], docs: 'https://vercel.com/docs', caveat: 'Container runtime is currently documented as beta; use framework-native functions for supported workloads.' },
  { id: 'netlify', name: 'Netlify', category: 'frontend-serverless', fullStack: true, static: true, containers: false, persistentProcesses: true, backgroundWorkers: false, databases: false, runtimes: ['node','python','go'], env: ['NETLIFY_AUTH_TOKEN'], docs: 'https://docs.netlify.com', caveat: 'Use Netlify Functions or Netlify Server; not a general-purpose arbitrary Docker host.' },
  { id: 'cloudflare-pages', name: 'Cloudflare Pages', category: 'edge-serverless', fullStack: true, static: true, containers: false, persistentProcesses: false, backgroundWorkers: false, databases: false, runtimes: ['javascript','typescript','rust-wasm'], env: ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID'], docs: 'https://developers.cloudflare.com/pages', caveat: 'Backend support is through Workers/Pages Functions, not conventional long-running servers or arbitrary containers.' },
];

export function listHostingProviders(env = process.env) {
  return PROVIDERS.map(({ env: requiredEnv, ...provider }) => ({
    ...provider,
    configured: requiredEnv.every((key) => Boolean(env[key])),
    missingCredentials: requiredEnv.filter((key) => !env[key]),
  }));
}

export function normalizeAppProfile(input = {}) {
  const runtime = String(input.runtime || 'unknown').toLowerCase();
  const kind = String(input.kind || 'web').toLowerCase();
  return {
    runtime,
    kind,
    isStatic: input.isStatic === true || kind === 'static',
    needsContainer: input.needsContainer === true || input.dockerfile === true,
    needsPersistentProcess: input.needsPersistentProcess === true,
    needsBackgroundWorker: input.needsBackgroundWorker === true,
    needsDatabase: input.needsDatabase === true,
  };
}

export function rankHostingProviders(profileInput, env = process.env) {
  const profile = normalizeAppProfile(profileInput);
  const catalog = listHostingProviders(env);
  const compatible = catalog.map((provider) => {
    const reasons = [];
    let score = 0;
    if (profile.isStatic && provider.static) { score += 30; reasons.push('Supports static site hosting'); }
    if (!profile.isStatic && provider.fullStack) { score += 20; reasons.push('Supports application backends'); }
    if (profile.runtime !== 'unknown' && provider.runtimes.includes(profile.runtime)) { score += 20; reasons.push('Supports the detected runtime'); }
    if (profile.needsContainer && provider.containers) { score += 25; reasons.push('Supports container deployment'); }
    if (profile.needsContainer && !provider.containers) return null;
    if (profile.needsPersistentProcess && provider.persistentProcesses) { score += 25; reasons.push('Supports persistent application processes'); }
    if (profile.needsPersistentProcess && !provider.persistentProcesses) return null;
    if (profile.needsBackgroundWorker && provider.backgroundWorkers) { score += 15; reasons.push('Supports background workers'); }
    if (profile.needsBackgroundWorker && !provider.backgroundWorkers) return null;
    if (profile.needsDatabase && provider.databases) { score += 10; reasons.push('Offers managed database options'); }
    if (profile.needsDatabase && !provider.databases) return null;
    if (provider.configured) { score += 8; reasons.push('Provider credentials are configured'); }
    else reasons.push('Provider credentials are not configured yet');
    if (provider.caveat) reasons.push(provider.caveat);
    return { ...provider, score, reasons };
  }).filter(Boolean);
  return compatible.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
