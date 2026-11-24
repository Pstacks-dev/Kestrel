const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

async function railwayGraphQL(token, query, variables = {}, fetchImpl = fetch) {
  const response = await fetchImpl(RAILWAY_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors?.length) {
    throw new Error('Railway API request failed');
  }
  return payload.data;
}

function parseRepository(repositoryUrl) {
  try {
    const url = new URL(repositoryUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part))) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch { return null; }
}

function normalizeRailwayStatus(status) {
  if (status === 'SUCCESS' || status === 'SLEEPING') return 'live';
  if (status === 'FAILED' || status === 'CRASHED' || status === 'REMOVED') return 'failed';
  if (status === 'BUILDING' || status === 'DEPLOYING') return 'deploying';
  if (status === 'QUEUED' || status === 'WAITING' || status === 'SKIPPED') return 'queued';
  return 'unknown';
}

async function syncRailwayVariables(token, projectId, environmentId, serviceId, variables, fetchImpl) {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error('Railway environment variables must be an object');
  for (const [key, value] of Object.entries(variables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(key) || typeof value !== 'string') throw new Error('Invalid Railway environment variable');
  }
  await railwayGraphQL(token,
    'mutation UpsertVariables($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }',
    { input: { projectId, environmentId, serviceId, variables, skipDeploys: true } },
    fetchImpl);
}

export async function createRailwayDeployment({
  token, repositoryUrl, branch = 'main', commitSha, projectName, serviceName,
  workspaceId = null, env = {},
}, { fetchImpl = fetch } = {}) {
  const repository = parseRepository(repositoryUrl);
  if (!repository) throw new Error('A public GitHub repository URL is required for Railway deployment');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.includes('//')) {
    throw new Error('Invalid deployment branch');
  }
  if (!/^[a-fA-F0-9]{7,64}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required');
  const safeProjectName = String(projectName || 'Kestrel project').trim().slice(0, 100);
  const safeServiceName = String(serviceName || safeProjectName).trim().slice(0, 100);
  if (!safeProjectName || !safeServiceName) throw new Error('Project and service names are required');

  const projectInput = { name: safeProjectName, defaultEnvironmentName: 'production', ...(workspaceId ? { workspaceId } : {}) };
  const createdProject = await railwayGraphQL(token,
    'mutation CreateProject($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }',
    { input: projectInput }, fetchImpl);
  const projectId = createdProject.projectCreate?.id;
  if (!projectId) throw new Error('Railway did not return a project identifier');

  const projectData = await railwayGraphQL(token,
    'query GetProject($id: String!) { project(id: $id) { id environments { edges { node { id name } } } } }',
    { id: projectId }, fetchImpl);
  const environments = projectData.project?.environments?.edges?.map((edge) => edge.node) || [];
  const environment = environments.find((item) => item.name?.toLowerCase() === 'production') || environments[0];
  if (!environment?.id) throw new Error('Railway project has no deployable environment');

  const createdService = await railwayGraphQL(token,
    'mutation CreateService($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }',
    { input: { projectId, name: safeServiceName, source: { repo: `${repository.owner}/${repository.repo}` }, branch } },
    fetchImpl);
  const serviceId = createdService.serviceCreate?.id;
  if (!serviceId) throw new Error('Railway did not return a service identifier');

  await syncRailwayVariables(token, projectId, environment.id, serviceId, env, fetchImpl);

  const deploymentData = await railwayGraphQL(token,
    'mutation DeployCommit($serviceId: String!, $environmentId: String!, $commitSha: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }',
    { serviceId, environmentId: environment.id, commitSha }, fetchImpl);
  const deploymentId = deploymentData.serviceInstanceDeployV2;
  if (!deploymentId || typeof deploymentId !== 'string') throw new Error('Railway did not return a deployment identifier');

  return {
    provider: 'railway', projectId, serviceId, environmentId: environment.id,
    deploymentId, status: 'queued', repository: `${repository.owner}/${repository.repo}`,
    branch, commitSha, providerUrl: null,
  };
}

export async function getRailwayDeployment({ token, deploymentId }, { fetchImpl = fetch } = {}) {
  const data = await railwayGraphQL(token,
    'query GetDeployment($id: String!) { deployment(id: $id) { id status createdAt url staticUrl canRollback canRedeploy } }',
    { id: deploymentId }, fetchImpl);
  const deployment = data.deployment;
  if (!deployment?.id) throw new Error('Railway deployment was not found');
  return {
    provider: 'railway', deploymentId: deployment.id,
    providerStatus: deployment.status, status: normalizeRailwayStatus(deployment.status),
    providerUrl: deployment.url || deployment.staticUrl || null,
    canRollback: Boolean(deployment.canRollback), canRedeploy: Boolean(deployment.canRedeploy),
    createdAt: deployment.createdAt || null,
  };
}

export async function getRailwayDeploymentLogs({ token, deploymentId, limit = 500 }, { fetchImpl = fetch } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 500, 1000));
  const [build, runtime] = await Promise.all([
    railwayGraphQL(token,
      'query BuildLogs($deploymentId: String!, $limit: Int) { buildLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity } }',
      { deploymentId, limit: boundedLimit }, fetchImpl),
    railwayGraphQL(token,
      'query RuntimeLogs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity } }',
      { deploymentId, limit: boundedLimit }, fetchImpl),
  ]);
  return {
    build: build.buildLogs || [],
    runtime: runtime.deploymentLogs || [],
  };
}

export async function rollbackRailwayDeployment({ token, deploymentId }, { fetchImpl = fetch } = {}) {
  const current = await getRailwayDeployment({ token, deploymentId }, { fetchImpl });
  if (!current.canRollback) throw new Error('Railway does not allow rollback to this deployment');
  const data = await railwayGraphQL(token,
    'mutation RollbackDeployment($id: String!) { deploymentRollback(id: $id) { id status } }',
    { id: deploymentId }, fetchImpl);
  const rollback = data.deploymentRollback;
  if (!rollback?.id) throw new Error('Railway did not create a rollback deployment');
  return { provider: 'railway', deploymentId: rollback.id, status: normalizeRailwayStatus(rollback.status) };
}

export async function deployRailwayService({ token, projectId, serviceId, environmentId, commitSha, env = {} }, { fetchImpl = fetch } = {}) {
  if (!serviceId || !environmentId) throw new Error('Railway service and environment identifiers are required');
  if (!/^[a-fA-F0-9]{7,64}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required');
  await syncRailwayVariables(token, projectId, environmentId, serviceId, env, fetchImpl);
  const data = await railwayGraphQL(token,
    'mutation DeployCommit($serviceId: String!, $environmentId: String!, $commitSha: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }',
    { serviceId, environmentId, commitSha }, fetchImpl);
  const deploymentId = data.serviceInstanceDeployV2;
  if (!deploymentId || typeof deploymentId !== 'string') throw new Error('Railway did not return a deployment identifier');
  return { provider: 'railway', serviceId, environmentId, deploymentId, commitSha, status: 'queued' };
}
