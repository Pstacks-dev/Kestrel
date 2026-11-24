import crypto from 'node:crypto';

const API = 'https://api.netlify.com/api/v1';

async function request(token, path, { method = 'GET', body, rawBody, contentType, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(rawBody !== undefined ? { 'content-type': contentType || 'application/octet-stream' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(rawBody !== undefined ? { body: rawBody } : {}),
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 204) return {};
  const text = await response.text().catch(() => '');
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { text }; }
  if (!response.ok) {
    const error = new Error(`Netlify API request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function siteName(value) {
  const name = String(value || 'kestrel-site').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  return name.length >= 3 ? name : 'kestrel-site';
}

function normalizeFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 5000) throw new Error('Netlify deploy requires between 1 and 5000 static files');
  let total = 0;
  const normalized = [];
  const seen = new Set();
  for (const file of files) {
    const path = String(file?.path || '');
    if (!path || path.startsWith('/') || path.length > 1024 || path.includes('\\') || path.includes('\0') ||
        path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid static artifact path');
    if (seen.has(path)) throw new Error('Static artifact contains duplicate file paths');
    seen.add(path);
    if (typeof file.content !== 'string' && !Buffer.isBuffer(file.content)) throw new Error('Static artifact file bytes are required');
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'base64');
    total += content.length;
    if (total > 50 * 1024 * 1024) throw new Error('Netlify static artifact exceeds the 50 MiB API upload limit');
    normalized.push({ path, content, sha1: crypto.createHash('sha1').update(content).digest('hex') });
  }
  return normalized;
}

function state(value) {
  if (value === 'ready') return 'live';
  if (value === 'error' || value === 'rejected') return 'failed';
  if (['enqueued', 'building', 'uploading', 'new', 'uploaded', 'prepared', 'processing', 'processed'].includes(value)) return 'deploying';
  return 'queued';
}

async function createSite(token, name, fetchImpl) {
  try {
    return await request(token, '/sites', { method: 'POST', body: { name }, fetchImpl });
  } catch (error) {
    if (error.status !== 422) throw error;
    const existing = await request(token, `/sites?name=${encodeURIComponent(name)}`, { fetchImpl });
    const sites = Array.isArray(existing) ? existing : existing.sites || [];
    const site = sites.find((item) => item.name === name);
    if (!site) throw error;
    return site;
  }
}

async function deployFiles({ token, siteId, files, branch = 'main', commitSha }, { fetchImpl = fetch } = {}) {
  const normalized = normalizeFiles(files);
  const manifest = Object.fromEntries(normalized.map((file) => [file.path, file.sha1]));
  const deploy = await request(token, `/sites/${encodeURIComponent(siteId)}/deploys`, {
    method: 'POST', fetchImpl,
    body: { files: manifest, branch, ...(commitSha ? { commit_sha: commitSha } : {}) },
  });
  if (!deploy.id) throw new Error('Netlify did not return a deployment identifier');
  const byPath = new Map(normalized.map((file) => [file.path, file]));
  for (const requiredPath of deploy.required || []) {
    const file = byPath.get(requiredPath);
    if (!file) throw new Error(`Netlify requested an artifact that Kestrel did not provide: ${requiredPath}`);
    await request(token, `/deploys/${encodeURIComponent(deploy.id)}/files/${requiredPath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT', rawBody: file.content, contentType: 'application/octet-stream', fetchImpl,
    });
  }
  return {
    provider: 'netlify', deploymentId: deploy.id, status: state(deploy.state),
    providerUrl: deploy.ssl_url || deploy.url || null, buildId: deploy.build_id || null,
  };
}

export async function createNetlifyDeployment({ authToken, projectName, files, branch = 'main', commitSha }, { fetchImpl = fetch } = {}) {
  if (!authToken) throw new Error('Netlify access token is required');
  normalizeFiles(files);
  const site = await createSite(authToken, siteName(projectName), fetchImpl);
  if (!site.id) throw new Error('Netlify did not return a site identifier');
  const deploy = await deployFiles({ token: authToken, siteId: site.id, files, branch, commitSha }, { fetchImpl });
  return { ...deploy, projectId: site.id, serviceId: site.name, environmentId: null, providerUrl: deploy.providerUrl || site.ssl_url || site.url || null };
}

export async function deployNetlifySite({ authToken, siteId, files, branch = 'main', commitSha }, { fetchImpl = fetch } = {}) {
  return deployFiles({ token: authToken, siteId, files, branch, commitSha }, { fetchImpl });
}

export async function getNetlifyDeployment({ authToken, deploymentId }, { fetchImpl = fetch } = {}) {
  const deploy = await request(authToken, `/deploys/${encodeURIComponent(deploymentId)}`, { fetchImpl });
  return {
    provider: 'netlify', deploymentId, providerStatus: deploy.state || 'unknown',
    status: state(deploy.state), providerUrl: deploy.ssl_url || deploy.url || null,
    canRollback: deploy.state === 'ready', buildId: deploy.build_id || null,
  };
}

export async function getNetlifyDeploymentLogs({ authToken, deploymentId }, { fetchImpl = fetch } = {}) {
  const deploy = await request(authToken, `/deploys/${encodeURIComponent(deploymentId)}`, { fetchImpl });
  if (!deploy.build_id) return { build: [], runtime: [], unavailable: true, message: 'This Netlify deployment was uploaded as prebuilt static files and has no Netlify build log.' };
  const response = await fetchImpl(`${API}/builds/${encodeURIComponent(deploy.build_id)}/log`, {
    headers: { Authorization: `Bearer ${authToken}`, Accept: 'text/plain' }, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Netlify build log request failed (${response.status})`);
  const content = (await response.text()).slice(-200000);
  return { build: content.split(/\r?\n/).filter(Boolean).map((message) => ({ message })), runtime: [] };
}

export async function rollbackNetlifyDeployment({ authToken, siteId, deploymentId }, { fetchImpl = fetch } = {}) {
  const restored = await request(authToken, `/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deploymentId)}/restore`, {
    method: 'POST', body: {}, fetchImpl,
  });
  if (!restored.id) throw new Error('Netlify did not return a restored deployment identifier');
  return { provider: 'netlify', deploymentId: restored.id, status: state(restored.state), providerUrl: restored.ssl_url || restored.url || null };
}
