const API = 'https://api.digitalocean.com/v2';

async function request(token, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`DigitalOcean App Platform API request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function repositoryPath(repositoryUrl) {
  const url = new URL(repositoryUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) throw new Error('A public GitHub repository URL is required');
  const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part))) throw new Error('Invalid GitHub repository URL');
  return `${parts[0]}/${parts[1]}`;
}

function status(value) {
  if (['ACTIVE', 'SUPERSEDED'].includes(value)) return value === 'ACTIVE' ? 'live' : 'unknown';
  if (['ERROR', 'CANCELED', 'FAILED'].includes(value)) return 'failed';
  if (['PENDING', 'QUEUED'].includes(value)) return 'queued';
  if (['BUILDING', 'DEPLOYING', 'PENDING_BUILD', 'PENDING_DEPLOY'].includes(value)) return 'deploying';
  return 'unknown';
}

function assertResolvedCommit(deployment, expectedSha) {
  const actual = deployment?.services?.map((service) => service.source_commit_hash).filter(Boolean) || [];
  if (actual.length && actual.some((sha) => sha.toLowerCase() !== expectedSha.toLowerCase())) {
    throw new Error('DigitalOcean deployed a different Git commit than the verified Kestrel commit');
  }
}

function safeName(value) {
  const result = String(value || 'kestrel-app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  return result || 'kestrel-app';
}

export async function createDigitalOceanDeployment({ accessToken, region = 'nyc', repositoryUrl, branch = 'main', commitSha, projectName, profile = {} }, { fetchImpl = fetch } = {}) {
  if (!accessToken) throw new Error('DigitalOcean access token is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.includes('//')) throw new Error('Invalid deployment branch');
  if (!/^[a-fA-F0-9]{7,64}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required');
  const repo = repositoryPath(repositoryUrl);
  const isStatic = profile.isStatic === true;
  const component = {
    name: safeName(projectName),
    github: { repo, branch, deploy_on_push: false },
    source_dir: '/',
  };
  if (isStatic) {
    component.build_command = 'npm install && npm run build';
    component.output_dir = profile.framework === 'create-react-app' ? 'build' : 'dist';
  } else {
    component.build_command = 'npm install && npm run build';
    component.run_command = 'npm start';
    component.environment_slug = ({ node: 'node-js', python: 'python', ruby: 'ruby', go: 'go' })[profile.runtime] || 'node-js';
    component.routes = [{ path: '/' }];
    component.instance_size_slug = 'apps-s-1vcpu-0.5gb';
    component.instance_count = 1;
    component.http_port = 8080;
  }
  const spec = { name: safeName(projectName), region, ...(isStatic ? { static_sites: [component] } : { services: [component] }) };
  const created = await request(accessToken, '/apps', { method: 'POST', fetchImpl, body: { spec } });
  const app = created.app;
  if (!app?.id) throw new Error('DigitalOcean did not return an app identifier');
  const initialDeployment = app.in_progress_deployment || app.pending_deployment || app.active_deployment || null;
  const deploymentResult = initialDeployment ? null : await request(accessToken, `/apps/${encodeURIComponent(app.id)}/deployments`, { method: 'POST', fetchImpl, body: { force_build: true } });
  const deployment = initialDeployment || deploymentResult?.deployment || deploymentResult;
  assertResolvedCommit(deployment, commitSha);
  const deploymentId = deployment.id;
  if (!deploymentId) throw new Error('DigitalOcean did not return a deployment identifier');
  return { provider: 'digitalocean-app-platform', projectId: app.id, serviceId: component.name, environmentId: null, deploymentId, status: status(deployment.phase || deployment.status), providerUrl: app.live_url || null };
}

export async function deployDigitalOceanApp({ accessToken, appId, commitSha }, { fetchImpl = fetch } = {}) {
  if (!appId) throw new Error('DigitalOcean app identifier is required');
  if (!/^[a-fA-F0-9]{7,64}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required');
  const deploymentResult = await request(accessToken, `/apps/${encodeURIComponent(appId)}/deployments`, { method: 'POST', fetchImpl, body: { force_build: true } });
  const deployment = deploymentResult.deployment || deploymentResult;
  assertResolvedCommit(deployment, commitSha);
  const deploymentId = deployment.id;
  if (!deploymentId) throw new Error('DigitalOcean did not return a deployment identifier');
  return { provider: 'digitalocean-app-platform', projectId: appId, deploymentId, status: status(deployment.phase || deployment.status) };
}

export async function getDigitalOceanDeployment({ accessToken, appId, deploymentId }, { fetchImpl = fetch } = {}) {
  const [result, appResult] = await Promise.all([
    request(accessToken, `/apps/${encodeURIComponent(appId)}/deployments/${encodeURIComponent(deploymentId)}`, { fetchImpl }),
    request(accessToken, `/apps/${encodeURIComponent(appId)}`, { fetchImpl }),
  ]);
  const deployment = result.deployment || result;
  const app = appResult.app || appResult;
  const phase = deployment.phase || deployment.status;
  return { provider: 'digitalocean-app-platform', deploymentId, providerStatus: phase, status: status(phase), providerUrl: app.live_url || app.default_ingress || null, canRollback: ['ACTIVE', 'SUPERSEDED'].includes(phase) };
}

export async function getDigitalOceanDeploymentLogs({ accessToken, appId, deploymentId }, { fetchImpl = fetch } = {}) {
  const result = await request(accessToken, `/apps/${encodeURIComponent(appId)}/deployments/${encodeURIComponent(deploymentId)}/logs`, { fetchImpl });
  const logs = result.historic_urls || result.live_url ? [{ message: 'DigitalOcean returned log stream URLs; fetch them through the authenticated log proxy.' }] : [];
  return { build: logs, runtime: [], logUrls: { historic: result.historic_urls || null, live: result.live_url || null } };
}

export async function rollbackDigitalOceanDeployment({ accessToken, appId, deploymentId }, { fetchImpl = fetch } = {}) {
  const result = await request(accessToken, `/apps/${encodeURIComponent(appId)}/rollback`, { method: 'POST', fetchImpl, body: { deployment_id: deploymentId, skip_pin: false } });
  const rollback = result.deployment || result;
  if (!rollback.id) throw new Error('DigitalOcean did not return a rollback deployment identifier');
  return { provider: 'digitalocean-app-platform', deploymentId: rollback.id, status: status(rollback.phase || rollback.status) };
}
