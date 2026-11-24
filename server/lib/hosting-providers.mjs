const PROVIDERS = [
  { id: 'render', name: 'Render', category: 'container-paas', fullStack: true, static: true, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: true, runtimes: ['node','python','go','ruby','php','docker'], env: ['RENDER_API_KEY'], docs: 'https://render.com/docs' },
  { id: 'railway', name: 'Railway', category: 'container-paas', fullStack: true, static: true, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: true, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['RAILWAY_API_TOKEN'], docs: 'https://docs.railway.com' },
  { id: 'flyio', name: 'Fly.io', category: 'container-paas', fullStack: true, static: true, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: false, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['FLY_API_TOKEN'], docs: 'https://fly.io/docs' },
  { id: 'google-cloud-run', name: 'Google Cloud Run', category: 'managed-containers', fullStack: true, static: false, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: false, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['GOOGLE_CLOUD_PROJECT','GOOGLE_APPLICATION_CREDENTIALS'], docs: 'https://cloud.google.com/run/docs' },
  { id: 'aws-ecs-express', name: 'AWS ECS Express Mode', category: 'managed-containers', fullStack: true, static: false, containers: true, requiresContainerImage: true, persistentProcesses: true, backgroundWorkers: false, databases: false, runtimes: ['docker'], env: ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_REGION','AWS_ECS_EXECUTION_ROLE_ARN','AWS_ECS_INFRASTRUCTURE_ROLE_ARN'], docs: 'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html', caveat: 'Requires an OCI image in a registry and two IAM roles; designed for stateless HTTP applications and APIs.' },
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
    framework: String(input.framework || '').toLowerCase() || null,
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
    if (profile.isStatic && !provider.static) return null;
    if (profile.isStatic && provider.static) { score += 30; reasons.push('Supports static site hosting'); }
    if (!profile.isStatic && provider.fullStack) { score += 20; reasons.push('Supports application backends'); }
    if (profile.runtime !== 'unknown' && provider.runtimes.includes(profile.runtime)) { score += 20; reasons.push('Supports the detected runtime'); }
    if (profile.needsContainer && provider.containers) { score += 25; reasons.push('Supports container deployment'); }
    if (profile.needsContainer && !provider.containers) return null;
    if (provider.requiresContainerImage && !profile.needsContainer) return null;
    if (profile.needsPersistentProcess && provider.persistentProcesses) { score += 25; reasons.push('Supports persistent application processes'); }
    const frameworkManagedServerless = provider.id === 'vercel' && profile.framework === 'nextjs';
    if (profile.needsPersistentProcess && !provider.persistentProcesses && !frameworkManagedServerless) return null;
    if (frameworkManagedServerless && profile.needsPersistentProcess) reasons.push('Runs Next.js server features through Vercel-managed functions');
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

export function detectProjectProfile({ files = [], packageJson = null } = {}) {
  const names = new Set(files.map((file) => String(typeof file === 'string' ? file : file.name || '').toLowerCase()));
  const pkg = packageJson && typeof packageJson === 'object' ? packageJson : {};
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const has = (...values) => values.some((value) => names.has(value));
  const profile = {
    runtime: 'unknown', kind: 'web', isStatic: false, needsContainer: false,
    needsPersistentProcess: false, needsBackgroundWorker: false, needsDatabase: false,
    framework: null, detectedFrom: [],
  };
  if (has('dockerfile', 'containerfile')) {
    profile.needsContainer = true;
    profile.needsPersistentProcess = true;
    profile.detectedFrom.push('Dockerfile');
  }
  if (Object.keys(dependencies).length || has('package.json')) {
    profile.runtime = 'node';
    profile.detectedFrom.push('package.json');
    if (dependencies.next || dependencies.nuxt || dependencies['@sveltejs/kit'] || dependencies.remix) {
      profile.framework = dependencies.next ? 'nextjs' : dependencies.nuxt ? 'nuxt' : dependencies.remix ? 'remix' : 'sveltekit';
      profile.needsPersistentProcess = profile.needsPersistentProcess || Boolean(scripts.start);
    } else if (dependencies.vite || dependencies['react-scripts'] || dependencies.gatsby) {
      profile.framework = dependencies.vite ? 'vite' : dependencies.gatsby ? 'gatsby' : 'create-react-app';
      profile.isStatic = !profile.needsContainer;
      profile.kind = profile.isStatic ? 'static' : 'web';
    }
    if (scripts.worker || scripts['start:worker']) profile.needsBackgroundWorker = true;
    if (scripts.start && !profile.isStatic) profile.needsPersistentProcess = true;
  } else if (has('requirements.txt', 'pyproject.toml', 'manage.py')) {
    profile.runtime = 'python';
    profile.needsPersistentProcess = true;
    profile.framework = has('manage.py') ? 'django' : has('requirements.txt') ? 'python-web' : 'python';
    profile.detectedFrom.push('Python project manifest');
  } else if (has('go.mod')) {
    profile.runtime = 'go'; profile.needsPersistentProcess = true; profile.detectedFrom.push('go.mod');
  } else if (has('cargo.toml')) {
    profile.runtime = 'rust'; profile.needsPersistentProcess = true; profile.detectedFrom.push('Cargo.toml');
  } else if (has('composer.json')) {
    profile.runtime = 'php'; profile.needsPersistentProcess = true; profile.detectedFrom.push('composer.json');
  } else if (has('gemfile')) {
    profile.runtime = 'ruby'; profile.needsPersistentProcess = true; profile.detectedFrom.push('Gemfile');
  } else if ([...names].some((name) => name.endsWith('.csproj') || name.endsWith('.sln'))) {
    profile.runtime = 'dotnet'; profile.needsPersistentProcess = true; profile.detectedFrom.push('.NET project file');
  }
  return profile;
}
