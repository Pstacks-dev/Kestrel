const API = 'https://api.cloudflare.com/client/v4';

async function request(apiToken, path, { method = 'GET', body, formData, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(formData ? { body: formData } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.errors?.[0]?.message || `Cloudflare Pages API request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload.result;
}

function projectName(value) {
  const name = String(value || 'kestrel-site').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 58);
  return name.length >= 2 ? name : 'kestrel-site';
}

function parseRepository(repositoryUrl) {
  const url = new URL(repositoryUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('Cloudflare Pages Git integration requires a public GitHub repository URL');
  }
  const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2) throw new Error('Invalid GitHub repository URL');
  return { owner: parts[0], repo: parts[1] };
}

function envVars(env = {}) {
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name) || typeof value !== 'string' || value.length > 30000) {
      throw new Error('Invalid Cloudflare Pages environment variable');
    }
    result[name] = { type: 'secret_text', value };
  }
  if (Object.keys(result).length > 100) throw new Error('Cloudflare Pages supports at most 100 environment variables per deployment environment');
  return result;
}

function projectPath(accountId, name) {
  return `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(name)}`;
}

function buildConfig({ buildCommand, destinationDir, rootDir }) {
  const command = String(buildCommand || 'npm run build');
  const destination = String(destinationDir || 'dist');
  const root = String(rootDir || '/');
  if (!command || command.length > 500 || /[\r\n\0]/.test(command)) throw new Error('Invalid Cloudflare Pages build command');
  if (!destination || destination.length > 200 || destination.startsWith('/') || /^[A-Za-z]:/.test(destination) ||
      destination.includes('\\') || destination.includes('\0') ||
      destination.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid Cloudflare Pages build directory');
  }
  if (!root || root.length > 200 || root.includes('\\') || root.includes('\0') ||
      root.split('/').some((part) => part === '..')) {
    throw new Error('Invalid Cloudflare Pages build directory');
  }
  return { build_command: command, destination_dir: destination, root_dir: root, build_caching: true };
}

async function ensureProject({ apiToken, accountId, projectName: name, repositoryUrl, branch, buildCommand, destinationDir, rootDir, env }, fetchImpl) {
  const path = projectPath(accountId, name);
  try {
    const existing = await request(apiToken, path, { fetchImpl });
    const source = existing.source?.config;
    if (existing.source?.type !== 'github' || !source) throw new Error('Existing Cloudflare Pages project is not connected to GitHub');
    if (source.owner?.toLowerCase() !== parseRepository(repositoryUrl).owner.toLowerCase() ||
        source.repo_name?.toLowerCase() !== parseRepository(repositoryUrl).repo.toLowerCase()) {
      throw new Error('Cloudflare Pages project name is already linked to another repository');
    }
    const vars = envVars(env);
    const currentConfigs = existing.deployment_configs || {};
    const update = {
      build_config: buildConfig({ buildCommand, destinationDir, rootDir }),
      ...(Object.keys(vars).length ? {
        deployment_configs: {
          production: { env_vars: { ...(currentConfigs.production?.env_vars || {}), ...vars } },
          preview: { env_vars: { ...(currentConfigs.preview?.env_vars || {}), ...vars } },
        },
      } : {}),
    };
    return request(apiToken, path, { method: 'PATCH', fetchImpl, body: update });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const repo = parseRepository(repositoryUrl);
  const vars = envVars(env);
  return request(apiToken, `/accounts/${encodeURIComponent(accountId)}/pages/projects`, {
    method: 'POST', fetchImpl,
    body: {
      name,
      production_branch: branch,
      source: {
        type: 'github',
        config: {
          owner: repo.owner, repo_name: repo.repo, production_branch: branch,
          deployments_enabled: false, production_deployments_enabled: false,
          preview_deployment_setting: 'none', pr_comments_enabled: false,
        },
      },
      build_config: buildConfig({ buildCommand, destinationDir, rootDir }),
      deployment_configs: {
        production: { env_vars: vars },
        preview: { env_vars: vars },
      },
    },
  });
}

function stageStatus(deployment) {
  const stage = deployment.latest_stage?.status;
  if (stage === 'success' && deployment.latest_stage?.name === 'deploy') return 'live';
  if (stage === 'failure' || stage === 'canceled') return 'failed';
  if (stage === 'active' || ['queued', 'initialize', 'clone_repo', 'build', 'deploy'].includes(deployment.latest_stage?.name)) return 'deploying';
  return 'queued';
}

async function createDeployment({ apiToken, accountId, projectName: name, branch, commitSha, commitMessage }, fetchImpl) {
  if (!/^[a-fA-F0-9]{40}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required for Cloudflare Pages deployment');
  const form = new FormData();
  form.set('branch', branch);
  form.set('commit_hash', commitSha);
  form.set('commit_message', String(commitMessage || `Kestrel deployment ${commitSha.slice(0, 8)}`).slice(0, 500));
  form.set('commit_dirty', 'false');
  const deployment = await request(apiToken, `${projectPath(accountId, name)}/deployments`, {
    method: 'POST', formData: form, fetchImpl,
  });
  if (!deployment.id) throw new Error('Cloudflare Pages did not return a deployment identifier');
  return {
    provider: 'cloudflare-pages', deploymentId: deployment.id,
    status: stageStatus(deployment), providerUrl: deployment.url || null,
  };
}

export async function createCloudflarePagesDeployment({ apiToken, accountId, projectName: rawName, repositoryUrl, branch = 'main', commitSha, commitMessage, buildCommand, destinationDir, rootDir, env }, { fetchImpl = fetch } = {}) {
  if (!apiToken || !accountId) throw new Error('Cloudflare API token and account ID are required');
  parseRepository(repositoryUrl);
  // Validate all build settings before any provider API request, including when the project already exists.
  buildConfig({ buildCommand, destinationDir, rootDir });
  const name = projectName(rawName);
  buildConfig({ buildCommand, destinationDir, rootDir });
  envVars(env);
  const project = await ensureProject({ apiToken, accountId, projectName: name, repositoryUrl, branch, buildCommand, destinationDir, rootDir, env }, fetchImpl);
  const deployment = await createDeployment({ apiToken, accountId, projectName: name, branch, commitSha, commitMessage }, fetchImpl);
  return {
    ...deployment, projectId: accountId, serviceId: project.name || name,
    environmentId: 'production', providerUrl: deployment.providerUrl || project.subdomain && `https://${project.subdomain}.pages.dev` || null,
  };
}

export async function deployCloudflarePagesProject({ apiToken, accountId, projectName: name, branch = 'main', commitSha, commitMessage, env, buildCommand, destinationDir, rootDir }, { fetchImpl = fetch } = {}) {
  if (!/^[a-fA-F0-9]{40}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required for Cloudflare Pages deployment');
  const update = {};
  if (buildCommand || destinationDir || rootDir) {
    update.build_config = buildConfig({ buildCommand, destinationDir, rootDir });
  }
  if (env && Object.keys(env).length) {
    const variables = envVars(env);
    update.deployment_configs = {
      production: { env_vars: variables },
      preview: { env_vars: variables },
    };
  }
  if (Object.keys(update).length) {
    await request(apiToken, projectPath(accountId, name), {
      method: 'PATCH', fetchImpl, body: update,
    });
  }
  return createDeployment({ apiToken, accountId, projectName: name, branch, commitSha, commitMessage }, fetchImpl);
}

export async function getCloudflarePagesDeployment({ apiToken, accountId, projectName: name, deploymentId }, { fetchImpl = fetch } = {}) {
  const deployment = await request(apiToken, `${projectPath(accountId, name)}/deployments/${encodeURIComponent(deploymentId)}`, { fetchImpl });
  return {
    provider: 'cloudflare-pages', deploymentId,
    providerStatus: deployment.latest_stage?.status || 'unknown',
    status: stageStatus(deployment),
    providerUrl: deployment.url || deployment.aliases?.[0] || null,
    canRollback: deployment.environment === 'production' && stageStatus(deployment) === 'live',
  };
}

export async function getCloudflarePagesDeploymentLogs({ apiToken, accountId, projectName: name, deploymentId }, { fetchImpl = fetch } = {}) {
  const result = await request(apiToken, `${projectPath(accountId, name)}/deployments/${encodeURIComponent(deploymentId)}/history/logs`, { fetchImpl });
  return {
    build: (result.data || []).map((entry) => ({ timestamp: entry.ts || null, message: entry.line || '' })),
    runtime: [],
    unavailable: !(result.data || []).length,
    ...(result.includes_container_logs ? {} : { message: 'Cloudflare Pages deployment logs include build output; runtime container logs are not part of this Pages log endpoint.' }),
  };
}

export async function rollbackCloudflarePagesDeployment({ apiToken, accountId, projectName: name, deploymentId }, { fetchImpl = fetch } = {}) {
  const deployment = await request(apiToken, `${projectPath(accountId, name)}/deployments/${encodeURIComponent(deploymentId)}/rollback`, {
    method: 'POST', body: {}, fetchImpl,
  });
  if (!deployment.id) throw new Error('Cloudflare Pages did not return a rollback deployment identifier');
  return {
    provider: 'cloudflare-pages', deploymentId: deployment.id,
    status: stageStatus(deployment), providerUrl: deployment.url || null,
  };
}
