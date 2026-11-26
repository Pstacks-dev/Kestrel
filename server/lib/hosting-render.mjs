const API = 'https://api.render.com/v1';

async function request(token, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Render API request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function repoPath(repositoryUrl) {
  const url = new URL(repositoryUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('A public GitHub repository URL is required');
  }
  const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part))) throw new Error('Invalid GitHub repository URL');
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

function validate({ branch, commitSha }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch || 'main') || branch.includes('..') || branch.endsWith('/') || branch.includes('//')) throw new Error('Invalid deployment branch');
  if (!/^[a-fA-F0-9]{7,64}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required');
}

function status(value) {
  if (value === 'live') return 'live';
  if (['build_failed', 'update_failed', 'canceled', 'pre_deploy_failed', 'deactivated'].includes(value)) return 'failed';
  if (['created', 'queued'].includes(value)) return 'queued';
  if (['build_in_progress', 'update_in_progress', 'pre_deploy_in_progress'].includes(value)) return 'deploying';
  return 'unknown';
}

async function syncRenderEnvironment(apiKey, serviceId, env = {}, fetchImpl = fetch) {
  // Render's collection PUT replaces the complete environment-variable set.
  // Always send the current Kestrel set, including [], so deleted secrets are removed.
  const variables = Object.entries(env || {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(key) || typeof value !== 'string') throw new Error('Invalid Render environment variable');
    return { key, value };
  });
  await request(apiKey, `/services/${encodeURIComponent(serviceId)}/env-vars`, {
    method: 'PUT', fetchImpl, body: variables,
  });
}

export async function createRenderDeployment({ apiKey, ownerId, repositoryUrl, branch = 'main', commitSha, projectName, profile = {}, env = {}, buildCommand, destinationDir }, { fetchImpl = fetch } = {}) {
  if (!apiKey || !ownerId) throw new Error('Render API key and workspace owner ID are required');
  validate({ branch, commitSha });
  const repo = repoPath(repositoryUrl);
  const isStatic = profile.isStatic === true;
  const serviceType = isStatic ? 'static_site' : 'web_service';
  const renderBuildCommand = String(buildCommand || profile.buildCommand || 'npm install && npm run build').trim();
  if (!renderBuildCommand || renderBuildCommand.length > 2000) throw new Error('Invalid Render build command');
  const publishPath = String(destinationDir || profile.outputDirectory || 'dist');
  if (!publishPath || publishPath.length > 500 || publishPath.startsWith('/') || publishPath.includes('\\') || publishPath.includes('\0') || publishPath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid Render static publish directory');
  }
  const details = isStatic
    ? { buildCommand: renderBuildCommand, publishPath }
    : profile.needsContainer
      ? {
          runtime: 'docker',
          envSpecificDetails: {
            dockerfilePath: profile.dockerfilePath || './Dockerfile',
            dockerContext: profile.dockerContext || '.',
          },
          plan: 'starter',
          region: 'oregon',
        }
      : {
          runtime: profile.runtime || 'node',
          envSpecificDetails: {
            buildCommand: renderBuildCommand,
            startCommand: profile.startCommand || 'npm start',
          },
          plan: 'starter',
          region: 'oregon',
        };
  const created = await request(apiKey, '/services', {
    method: 'POST', fetchImpl,
    body: {
      type: serviceType,
      name: String(projectName || 'kestrel-app').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60),
      ownerId, repo, branch, autoDeployTrigger: 'off',
      ...(profile.rootDir && profile.rootDir !== '.' ? { rootDir: profile.rootDir } : {}),
      serviceDetails: details,
    },
  });
  const service = created.service || created;
  if (!service.id) throw new Error('Render did not return a service identifier');
  await syncRenderEnvironment(apiKey, service.id, env, fetchImpl);
  const deploy = await request(apiKey, `/services/${encodeURIComponent(service.id)}/deploys`, {
    method: 'POST', fetchImpl, body: { commitId: commitSha, clearCache: 'do_not_clear' },
  });
  if (!deploy.id) throw new Error('Render did not return a deployment identifier');
  return { provider: 'render', projectId: ownerId, serviceId: service.id, environmentId: null, deploymentId: deploy.id, status: status(deploy.status || 'created'), providerUrl: service.serviceDetails?.url || service.url || null };
}

export async function deployRenderService({ apiKey, serviceId, commitSha, env = {} }, { fetchImpl = fetch } = {}) {
  if (!serviceId) throw new Error('Render service identifier is required');
  if (!/^[a-fA-F0-9]{7,64}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required');
  await syncRenderEnvironment(apiKey, serviceId, env, fetchImpl);
  const deploy = await request(apiKey, `/services/${encodeURIComponent(serviceId)}/deploys`, { method: 'POST', fetchImpl, body: { commitId: commitSha, clearCache: 'do_not_clear' } });
  if (!deploy.id) throw new Error('Render did not return a deployment identifier');
  return { provider: 'render', serviceId, deploymentId: deploy.id, status: status(deploy.status || 'created') };
}

export async function getRenderDeployment({ apiKey, serviceId, deploymentId }, { fetchImpl = fetch } = {}) {
  const [deploy, service] = await Promise.all([
    request(apiKey, `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deploymentId)}`, { fetchImpl }),
    request(apiKey, `/services/${encodeURIComponent(serviceId)}`, { fetchImpl }),
  ]);
  return { provider: 'render', deploymentId: deploy.id, providerStatus: deploy.status, status: status(deploy.status), providerUrl: service.service?.serviceDetails?.url || service.serviceDetails?.url || service.url || null, canRollback: ['live', 'build_failed', 'update_failed'].includes(deploy.status) };
}

export async function getRenderDeploymentLogs({ apiKey, serviceId, deploymentId }, { fetchImpl = fetch } = {}) {
  // Render's log search API requires a bounded time window and query syntax; deployment-specific logs are not exposed by this endpoint.
  return { build: [], runtime: [], unavailable: true, message: 'Deployment-scoped log retrieval is not available through the current Render API adapter.' };
}

export async function rollbackRenderDeployment({ apiKey, serviceId, deploymentId }, { fetchImpl = fetch } = {}) {
  const result = await request(apiKey, `/services/${encodeURIComponent(serviceId)}/rollback`, { method: 'POST', fetchImpl, body: { deployId: deploymentId } });
  if (!result.id) throw new Error('Render did not return a rollback deployment identifier');
  return { provider: 'render', deploymentId: result.id, status: status(result.status || 'created') };
}
