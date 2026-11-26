import crypto from 'node:crypto';

const API = 'https://run.googleapis.com/v2';
const LOGGING_API = 'https://logging.googleapis.com/v2';

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

async function accessToken(serviceAccountJson, fetchImpl = fetch, now = Date.now()) {
  const account = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  if (account.type !== 'service_account' || !account.client_email || !account.private_key) throw new Error('A valid Google service account is required');
  const issuedAt = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: issuedAt, exp: issuedAt + 3600,
  })}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(account.private_key, 'base64url')}`;
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error('Google OAuth token exchange failed');
  return payload.access_token;
}

async function request(token, path, { method = 'GET', body, fetchImpl = fetch, base = API } = {}) {
  const response = await fetchImpl(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Google Cloud API request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function validateImage(image) {
  if (typeof image !== 'string' || image.length > 512 ||
      !/^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9._/-]+(?::[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})$/i.test(image)) {
    throw new Error('A valid published OCI image reference is required for Cloud Run');
  }
  return image;
}

function serviceName(value) {
  const result = String(value || 'kestrel-app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 49);
  return result.length >= 2 ? result : 'kestrel-app';
}

function serviceTemplate({ image, port, env, maxInstances, cpu, memory }) {
  const containerPort = Number(port || 8080);
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) throw new Error('Application port must be between 1 and 65535');
  const envEntries = Object.entries(env || {}).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name) || typeof value !== 'string' || value.length > 32000) throw new Error('Invalid Cloud Run environment variable');
    return { name, value };
  });
  if (envEntries.length > 100) throw new Error('Cloud Run supports at most 100 environment variables per container');
  const max = Number(maxInstances || 5);
  if (!Number.isInteger(max) || max < 1 || max > 1000) throw new Error('Cloud Run max instances must be between 1 and 1000');
  return {
    containers: [{
      image, ports: [{ containerPort }],
      env: envEntries,
      resources: { limits: { cpu: String(cpu || '1'), memory: memory || '512Mi' } },
    }],
    scaling: { maxInstanceCount: max },
  };
}

function servicePath(projectId, region, name) {
  return `/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/services/${encodeURIComponent(name)}`;
}

async function startOperation(token, operation, fetchImpl) {
  if (!operation?.name) throw new Error('Cloud Run did not return an operation name');
  return { provider: 'google-cloud-run', deploymentId: operation.name, status: 'deploying' };
}

export async function createCloudRunDeployment({ serviceAccountJson, projectId, region = 'us-central1', projectName, containerImage, port, env, maxInstances, cpu, memory }, { fetchImpl = fetch } = {}) {
  if (!projectId) throw new Error('Google Cloud project ID is required');
  const image = validateImage(containerImage);
  const token = await accessToken(serviceAccountJson, fetchImpl);
  const name = serviceName(projectName);
  const operation = await request(token, `/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/services?serviceId=${encodeURIComponent(name)}`, {
    method: 'POST', fetchImpl,
    body: { ingress: 'INGRESS_TRAFFIC_ALL', template: serviceTemplate({ image, port, env, maxInstances, cpu, memory }) },
  });
  return { ...(await startOperation(token, operation, fetchImpl)), projectId, serviceId: name, environmentId: region, providerUrl: null };
}

export async function deployCloudRunService({ serviceAccountJson, projectId, region = 'us-central1', serviceName: name, containerImage, port, env, maxInstances, cpu, memory }, { fetchImpl = fetch } = {}) {
  const image = validateImage(containerImage);
  const token = await accessToken(serviceAccountJson, fetchImpl);
  const operation = await request(token, `${servicePath(projectId, region, name)}?updateMask=template.containers,template.scaling`, {
    method: 'PATCH', fetchImpl,
    body: { template: serviceTemplate({ image, port, env, maxInstances, cpu, memory }) },
  });
  return startOperation(token, operation, fetchImpl);
}

export async function getCloudRunDeployment({ serviceAccountJson, projectId, region = 'us-central1', serviceName: name, deploymentId }, { fetchImpl = fetch } = {}) {
  const token = await accessToken(serviceAccountJson, fetchImpl);
  let operation = null;
  if (deploymentId.includes('/operations/')) {
    operation = await request(token, `/${deploymentId.replace(/^\/+/, '')}`, { fetchImpl });
    if (!operation.done) return { provider: 'google-cloud-run', deploymentId, providerStatus: 'operation-pending', status: 'deploying', providerUrl: null, canRollback: false };
    if (operation.error) return { provider: 'google-cloud-run', deploymentId, providerStatus: 'operation-failed', status: 'failed', providerUrl: null, canRollback: false };
  }
  const service = await request(token, servicePath(projectId, region, name), { fetchImpl });
  const ready = service.latestReadyRevision || service.latestReadyRevisionName || null;
  const created = service.latestCreatedRevision || service.latestCreatedRevisionName || null;
  const revision = ready || created;
  const readyCondition = (service.conditions || []).find((condition) => condition.type === 'Ready');
  const live = Boolean(ready && (!created || ready === created) && readyCondition?.state !== 'CONDITION_FAILED');
  return {
    provider: 'google-cloud-run', deploymentId: revision || deploymentId,
    providerDeploymentId: revision || deploymentId, providerStatus: readyCondition?.state || (live ? 'CONDITION_SUCCEEDED' : 'CONDITION_PENDING'),
    status: live ? 'live' : readyCondition?.state === 'CONDITION_FAILED' ? 'failed' : 'deploying',
    providerUrl: service.uri || null, canRollback: Boolean(revision),
  };
}

export async function getCloudRunDeploymentLogs({ serviceAccountJson, projectId, region = 'us-central1', serviceName: name, deploymentId }, { fetchImpl = fetch } = {}) {
  const token = await accessToken(serviceAccountJson, fetchImpl);
  const filter = [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${name}"`,
    `resource.labels.location="${region}"`,
    deploymentId.includes('/revisions/') ? `resource.labels.revision_name="${deploymentId.split('/').pop()}"` : null,
  ].filter(Boolean).join(' AND ');
  const result = await request(token, '/entries:list', {
    method: 'POST', fetchImpl, base: LOGGING_API,
    body: { resourceNames: [`projects/${projectId}`], filter, orderBy: 'timestamp desc', pageSize: 100 },
  });
  const runtime = (result.entries || []).reverse().map((entry) => ({
    timestamp: entry.timestamp || null,
    message: typeof entry.textPayload === 'string' ? entry.textPayload : JSON.stringify(entry.jsonPayload || entry.protoPayload || {}),
  }));
  return { build: [], runtime, unavailable: false };
}

export async function rollbackCloudRunDeployment({ serviceAccountJson, projectId, region = 'us-central1', serviceName: name, deploymentId }, { fetchImpl = fetch } = {}) {
  const revision = deploymentId.split('/').pop();
  if (!/^[-a-z0-9]{1,63}-[a-f0-9]{8,10}$/.test(revision)) throw new Error('A Cloud Run revision identifier is required for rollback');
  const token = await accessToken(serviceAccountJson, fetchImpl);
  const operation = await request(token, `${servicePath(projectId, region, name)}?updateMask=traffic`, {
    method: 'PATCH', fetchImpl,
    body: { traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision, percent: 100 }] },
  });
  return { provider: 'google-cloud-run', deploymentId: operation.name, status: 'deploying' };
}
