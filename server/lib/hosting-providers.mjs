const PROVIDERS = [
  { id: 'render', name: 'Render', category: 'container-paas', fullStack: true, static: true, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: true, runtimes: ['node','python','go','ruby','php','docker'], env: ['RENDER_API_KEY'], docs: 'https://render.com/docs' },
  { id: 'railway', name: 'Railway', category: 'container-paas', fullStack: true, static: true, containers: true, persistentProcesses: true, backgroundWorkers: true, databases: true, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['RAILWAY_API_TOKEN'], docs: 'https://docs.railway.com' },
  { id: 'flyio', name: 'Fly.io', category: 'container-paas', fullStack: true, static: false, containers: true, requiresContainerImage: true, persistentProcesses: true, backgroundWorkers: true, databases: false, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['FLY_API_TOKEN'], docs: 'https://fly.io/docs' },
  { id: 'google-cloud-run', name: 'Google Cloud Run', category: 'managed-containers', fullStack: true, static: false, containers: true, requiresContainerImage: true, persistentProcesses: true, backgroundWorkers: true, databases: false, runtimes: ['node','python','go','java','ruby','php','dotnet','docker'], env: ['GOOGLE_CLOUD_PROJECT','GOOGLE_APPLICATION_CREDENTIALS'], docs: 'https://cloud.google.com/run/docs' },
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
    const runtime = ['javascript', 'typescript'].includes(profile.runtime) ? 'node' : profile.runtime;
    const supportsRuntime = provider.runtimes.includes(runtime) ||
      (provider.id === 'cloudflare-pages' && profile.isStatic && runtime === 'node');
    if (profile.kind === 'unknown' && !profile.needsContainer) return null;
    // Do not recommend a source-build provider for a language it cannot build.
    // A Dockerfile is an explicit user-supplied runtime contract, so compatible
    // container providers may build languages absent from their native runtimes.
    if (!profile.needsContainer && (runtime === 'unknown' || !supportsRuntime)) return null;
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
  // Keep paths and basenames so nested apps and monorepos are detected.
  const paths = files.map((file) => String(typeof file === 'string' ? file : file.name || file.path || ''))
    .filter(Boolean).map((value) => value.replace(/\\/g, '/').toLowerCase());
  const names = new Set(paths.map((value) => value.split('/').pop()));
  const has = (...values) => values.some((value) => names.has(value.toLowerCase()));
  const hasExtension = (...extensions) => paths.some((path) => extensions.some((extension) => path.endsWith(extension)));
  const pkg = packageJson && typeof packageJson === 'object' ? packageJson : {};
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const hasDependency = (...values) => values.some((value) => dependencies[value]);
  const languages = new Set();
  const detectedFrom = [];
  const add = (language, source) => { languages.add(language); if (source && !detectedFrom.includes(source)) detectedFrom.push(source); };

  if (has('package.json') || Object.keys(dependencies).length || hasExtension('.js', '.jsx', '.mjs', '.cjs')) {
    add('javascript', 'package.json or JavaScript source');
    if (hasExtension('.ts', '.tsx', '.mts', '.cts') || has('tsconfig.json')) add('typescript', 'TypeScript source or tsconfig.json');
  }
  if (has('requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'pipfile', 'poetry.lock', 'pdm.lock') || hasExtension('.py', '.pyi')) add('python', 'Python manifest or source');
  if (has('go.mod', 'go.work') || hasExtension('.go')) add('go', 'Go module or source');
  if (has('cargo.toml', 'rust-toolchain', 'rust-toolchain.toml') || hasExtension('.rs')) add('rust', 'Cargo manifest or Rust source');
  if (has('composer.json', 'artisan') || hasExtension('.php')) add('php', 'Composer manifest or PHP source');
  if (has('gemfile', 'gemfile.lock', 'rakefile') || hasExtension('.rb')) add('ruby', 'Ruby manifest or source');
  if (has('pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew', 'mvnw') || hasExtension('.java')) add('java', 'Java build manifest or source');
  if ([...names].some((name) => name.endsWith('.csproj') || name.endsWith('.sln') || name.endsWith('.fsproj') || name.endsWith('.vbproj')) || has('global.json') || hasExtension('.cs', '.fs', '.vb')) add('dotnet', '.NET project or source');
  if (has('package.swift', 'swift.package') || hasExtension('.swift')) add('swift', 'Swift package or source');
  if (has('pubspec.yaml') || hasExtension('.dart')) add('dart', 'Dart package or source');
  if (has('mix.exs', 'mix.lock') || hasExtension('.ex', '.exs')) add('elixir', 'Elixir Mix project or source');
  if (has('rebar.config', 'rebar.lock') || hasExtension('.erl', '.hrl')) add('erlang', 'Erlang project or source');
  if (has('stack.yaml', 'cabal.project') || hasExtension('.hs', '.lhs')) add('haskell', 'Haskell project or source');
  if (has('dune-project', 'opam') || hasExtension('.ml', '.mli')) add('ocaml', 'OCaml project or source');
  if (has('cpanfile') || hasExtension('.pl', '.pm')) add('perl', 'Perl manifest or source');
  if (has('renv.lock') || hasExtension('.r', '.rmd')) add('r', 'R project or source');
  if (hasExtension('.jl')) add('julia', 'Julia source');
  if (has('rockspec') || hasExtension('.lua')) add('lua', 'Lua source');
  if (has('foundry.toml', 'hardhat.config.js', 'hardhat.config.ts') || hasExtension('.sol')) add('solidity', 'Solidity project or source');
  if (has('cmakelists.txt', 'meson.build') || has('makefile') || hasExtension('.c', '.h')) add('c', 'C build manifest or source');
  if (has('cmakelists.txt', 'meson.build') || hasExtension('.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx')) add('cpp', 'C++ build manifest or source');
  if (has('build.zig', 'zig.mod') || hasExtension('.zig')) add('zig', 'Zig project or source');
  if (hasExtension('.sh', '.bash')) add('shell', 'Shell script');
  if (has('dockerfile', 'containerfile')) add('docker', 'Dockerfile');

  const framework = hasDependency('next') ? 'nextjs'
    : hasDependency('nuxt') ? 'nuxt'
      : hasDependency('@remix-run/react', '@remix-run/node', 'remix') ? 'remix'
        : hasDependency('@sveltejs/kit') ? 'sveltekit'
          : hasDependency('astro') ? 'astro'
            : hasDependency('@angular/core') ? 'angular'
              : hasDependency('gatsby') ? 'gatsby'
                : hasDependency('react-scripts') ? 'create-react-app'
                  : hasDependency('vue') ? 'vue'
                    : hasDependency('svelte') ? 'svelte'
                      : hasDependency('vite') ? 'vite' : null;
  const staticOutputs = { astro: 'dist', angular: 'dist', gatsby: 'public', 'create-react-app': 'build', vue: 'dist', svelte: 'dist', vite: 'dist' };
  const serverFrameworks = new Set(['nextjs', 'nuxt', 'remix', 'sveltekit']);
  const primaryOrder = ['node', 'python', 'go', 'rust', 'php', 'ruby', 'java', 'dotnet', 'swift', 'dart', 'elixir', 'erlang', 'haskell', 'ocaml', 'perl', 'r', 'julia', 'lua', 'solidity', 'cpp', 'c', 'zig'];
  const runtimeFor = (language) => language === 'javascript' || language === 'typescript' ? 'node' : language;
  const detectedRuntimes = [...languages].filter((language) => language !== 'docker' && language !== 'shell').map(runtimeFor);
  const runtime = primaryOrder.find((candidate) => detectedRuntimes.includes(candidate)) || 'unknown';
  const hasDocker = languages.has('docker');
  const isStatic = Boolean(framework && staticOutputs[framework] && !hasDocker);
  const needsBackgroundWorker = Boolean(scripts.worker || scripts['start:worker']);
  // A language manifest or source file alone does not prove that a repository
  // is an HTTP service. Require an entry point, recognized app framework or
  // container contract before marking a project deployable as a web service.
  const hasWebEntryPoint = hasDocker || Boolean(framework) || Boolean(scripts.start) ||
    has('manage.py', 'wsgi.py', 'asgi.py', 'procfile', 'artisan', 'config.ru');
  const kind = isStatic ? 'static' : hasWebEntryPoint ? 'web' : 'unknown';
  const needsPersistentProcess = hasDocker || (!isStatic && hasWebEntryPoint);
  const packageManagerName = String(pkg.packageManager || '').split('@')[0].toLowerCase();
  const packageManager = ['npm', 'pnpm', 'yarn', 'bun'].includes(packageManagerName)
    ? packageManagerName
    : has('pnpm-lock.yaml') ? 'pnpm'
      : has('yarn.lock') ? 'yarn'
        : has('bun.lock', 'bun.lockb') ? 'bun' : has('package-lock.json') ? 'npm' : null;
  const buildSystems = [];
  if (has('package.json')) buildSystems.push('npm-compatible');
  if (has('pyproject.toml', 'setup.py', 'requirements.txt')) buildSystems.push('python');
  if (has('go.mod', 'go.work')) buildSystems.push('go');
  if (has('cargo.toml')) buildSystems.push('cargo');
  if (has('composer.json')) buildSystems.push('composer');
  if (has('gemfile')) buildSystems.push('bundler');
  if (has('pom.xml')) buildSystems.push('maven');
  if (has('build.gradle', 'build.gradle.kts')) buildSystems.push('gradle');
  if (has('cmakelists.txt')) buildSystems.push('cmake');
  if (has('makefile')) buildSystems.push('make');
  if (has('pubspec.yaml')) buildSystems.push('pub');
  if (has('mix.exs')) buildSystems.push('mix');
  if (has('package.swift')) buildSystems.push('swiftpm');
  if (has('foundry.toml')) buildSystems.push('foundry');
  if (has('hardhat.config.js', 'hardhat.config.ts')) buildSystems.push('hardhat');

  const profile = {
    runtime, detectedRuntimes: [...new Set(detectedRuntimes)],
    languages: [...languages].sort(), framework, frameworks: framework ? [framework] : [],
    buildSystems, packageManager, kind, isStatic, needsContainer: hasDocker,
    needsPersistentProcess, needsBackgroundWorker, needsDatabase: false,
    outputDirectory: isStatic ? staticOutputs[framework] : null, detectedFrom,
    unsupportedLanguages: [...languages].filter((language) => !['javascript', 'typescript', 'python', 'go', 'rust', 'php', 'ruby', 'java', 'dotnet', 'docker', 'shell'].includes(language)).sort(),
    detectionStatus: languages.size ? 'detected' : 'unknown',
  };
  if (scripts.build && packageManager) profile.buildCommand = packageManager === 'yarn' ? 'yarn build' : packageManager + ' run build';
  return profile;
}
