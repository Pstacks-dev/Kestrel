const API = 'https://api.vercel.com';

async function request(token, path, { method = 'GET', body, teamId, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${API}${path}${teamId ? (path.includes('?') ? '&' : '?') + `teamId=${encodeURIComponent(teamId)}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(`Vercel API request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function repository(repositoryUrl) {
  const url = new URL(repositoryUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) throw new Error('A GitHub repository URL is required');
  const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part))) throw new Error('Invalid GitHub repository URL');
  return { org: parts[0], repo: parts[1] };
}

function validCommit(commitSha) {
  if (!/^[a-fA-F0-9]{7,64}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required');
}

function projectName(value) {
  const name = String(value || 'kestrel-app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 52);
  return name || 'kestrel-app';
}

function framework(profile = {}) {
  const values = { nextjs: 'nextjs', vite: 'vite', 'create-react-app': 'create-react-app', gatsby: 'gatsby', astro: 'astro', angular: 'angular', vue: 'vue', svelte: 'svelte', sveltekit: 'sveltekit', django: 'django', fastapi: 'fastapi', flask: 'flask', express: 'express', nuxt: 'nuxtjs', remix: 'remix' };
  return values[profile.framework] || null;
}

function status(value) {
  if (value === 'READY') return 'live';
  if (['ERROR', 'CANCELED'].includes(value)) return 'failed';
  if (['QUEUED', 'PENDING'].includes(value)) return 'queued';
  if (['INITIALIZING', 'BUILDING', 'DEPLOYING'].includes(value)) return 'deploying';
  return 'unknown';
}

function publicUrl(value) {
  if (!value) return null;
  return String(value).startsWith('http') ? value : `https://${value}`;
}

async function createProject({ token, teamId, name, repositoryUrl, profile }, { fetchImpl = fetch } = {}) {
  const repo = repository(repositoryUrl);
  try {
    const existing = await request(token, `/v9/projects/${encodeURIComponent(name)}`, { teamId, fetchImpl });
    if (existing.id) {
      const linkedRepo = existing.link?.repo || existing.gitRepository?.repo;
      if (linkedRepo && linkedRepo.toLowerCase() !== `${repo.org}/${repo.repo}`.toLowerCase()) {
        throw new Error('A Vercel project with this name is already linked to another repository');
      }
      return { id: existing.id, name: existing.name || name, repo };
    }
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const created = await request(token, '/v11/projects', {
    method: 'POST', teamId, fetchImpl,
    body: { name, gitRepository: { type: 'github', repo: `${repo.org}/${repo.repo}` }, ...(framework(profile) ? { framework: framework(profile) } : {}) },
  });
  if (!created.id) throw new Error('Vercel did not return a project identifier');
  return { id: created.id, name: created.name || name, repo };
}

async function syncVercelEnvironment({ token, teamId, projectId, env = {} }, fetchImpl) {
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(key) || typeof value !== 'string') throw new Error('Invalid Vercel environment variable');
    await request(token, `/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true`, {
      method: 'POST', teamId, fetchImpl,
      body: { key, value, type: 'sensitive', visibility: 'secret', target: ['production', 'preview', 'development'] },
    });
  }
}

async function deploy({ token, teamId, projectId, name, repo, branch, commitSha, profile, env = {} }, { fetchImpl = fetch } = {}) {
  validCommit(commitSha);
  await syncVercelEnvironment({ token, teamId, projectId, env }, fetchImpl);
  const source = repo || repository(profile.repositoryUrl);
  const deployment = await request(token, '/v13/deployments?forceNew=1', {
    method: 'POST', teamId, fetchImpl,
    body: {
      name, project: projectId, target: 'production',
      gitSource: { type: 'github', org: source.org, repo: source.repo, ref: branch, sha: commitSha },
      ...(framework(profile) ? { projectSettings: { framework: framework(profile) } } : {}),
    },
  });
  if (!deployment.id) throw new Error('Vercel did not return a deployment identifier');
  return { provider: 'vercel', deploymentId: deployment.id, status: status(deployment.readyState || deployment.status), providerUrl: publicUrl(deployment.url) };
}

export async function createVercelDeployment({ token, teamId = null, repositoryUrl, branch = 'main', commitSha, projectName: name, profile = {}, env = {} }, options = {}) {
  validCommit(commitSha);
  const repo = repository(repositoryUrl);
  const nameSafe = projectName(name);
  const project = await createProject({ token, teamId, name: nameSafe, repositoryUrl, profile }, options);
  const result = await deploy({ token, teamId, projectId: project.id, name: project.name, repo, branch, commitSha, profile, env }, options);
  return { ...result, projectId: project.id, serviceId: project.name, environmentId: null };
}

export async function deployVercelProject({ token, teamId = null, projectId, projectName: name, repositoryUrl, branch = 'main', commitSha, profile = {}, env = {} }, options = {}) {
  const repo = repository(repositoryUrl);
  const result = await deploy({ token, teamId, projectId, name: projectName(name), repo, branch, commitSha, profile, env }, options);
  return { ...result, projectId, serviceId: projectName(name), environmentId: null };
}

export async function getVercelDeployment({ token, teamId = null, deploymentId }, { fetchImpl = fetch } = {}) {
  const deployment = await request(token, `/v13/deployments/${encodeURIComponent(deploymentId)}?withGitRepoInfo=true`, { teamId, fetchImpl });
  return {
    provider: 'vercel', deploymentId: deployment.id, providerStatus: deployment.readyState || deployment.status,
    status: status(deployment.readyState || deployment.status), providerUrl: publicUrl(deployment.url),
    canRollback: deployment.readyState === 'READY',
  };
}

export async function getVercelDeploymentLogs({ token, teamId = null, deploymentId, limit = 500 }, { fetchImpl = fetch } = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 500, 1000));
  const events = await request(token, `/v3/deployments/${encodeURIComponent(deploymentId)}/events?limit=${bounded}&direction=forward&builds=1`, { teamId, fetchImpl });
  const entries = (Array.isArray(events) ? events : []).map((event) => ({
    timestamp: event.created || event.payload?.date || null,
    message: event.payload?.text || event.payload?.info?.name || event.type || '',
    type: event.type || 'log',
  }));
  return { build: entries, runtime: [] };
}

export async function rollbackVercelDeployment({ token, teamId = null, projectId, projectName: name, deploymentId }, { fetchImpl = fetch } = {}) {
  const result = await request(token, '/v13/deployments?forceNew=1', {
    method: 'POST', teamId, fetchImpl,
    body: { name: projectName(name), project: projectId, target: 'production', deploymentId },
  });
  if (!result.id) throw new Error('Vercel did not return a rollback deployment identifier');
  return { provider: 'vercel', deploymentId: result.id, status: status(result.readyState || result.status) };
}
