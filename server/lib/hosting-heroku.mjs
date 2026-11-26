import { estimateHerokuDynoCost } from './heroku-pricing.mjs';
const API = 'https://api.heroku.com';
const ACCEPT = 'application/vnd.heroku+json; version=3';

async function request(apiKey, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: ACCEPT, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Heroku Platform API request failed (${response.status})`);
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
  return { owner: parts[0], repo: parts[1] };
}

export async function resolveHerokuSourceArchiveUrl({ repositoryUrl, commitSha, installationToken, fetchImpl = fetch }) {
  const repo = repository(repositoryUrl);
  if (!/^[a-fA-F0-9]{7,64}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required');
  if (!installationToken) return `https://github.com/${repo.owner}/${repo.repo}/archive/${commitSha}.tar.gz`;

  const response = await fetchImpl(`https://api.github.com/repos/${repo.owner}/${repo.repo}/tarball/${commitSha}`, {
    headers: {
      authorization: `Bearer ${installationToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    throw new Error('GitHub did not provide a signed source archive URL for the private repository');
  }
  const location = response.headers.get('location');
  if (!location) throw new Error('GitHub source archive response did not include a redirect URL');
  const archive = new URL(location);
  if (archive.protocol !== 'https:' || archive.hostname !== 'codeload.github.com' || !archive.pathname.includes(commitSha)) {
    throw new Error('GitHub returned an invalid signed source archive URL');
  }
  return archive.href;
}

function validateSourceArchiveUrl(repositoryUrl, commitSha, sourceArchiveUrl) {
  if (!sourceArchiveUrl) {
    const repo = repository(repositoryUrl);
    return `https://github.com/${repo.owner}/${repo.repo}/archive/${commitSha}.tar.gz`;
  }
  const archive = new URL(sourceArchiveUrl);
  if (archive.protocol !== 'https:' || !['github.com', 'codeload.github.com'].includes(archive.hostname) || !archive.pathname.includes(commitSha)) {
    throw new Error('Invalid Heroku source archive URL');
  }
  return archive.href;
}

function appName(value) {
  const name = String(value || 'kestrel-app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
  const suffix = name.match(/-[a-f0-9]{8}$/i)?.[0] || '';
  const bounded = suffix ? `${name.slice(0, 28 - suffix.length)}${suffix}` : name.slice(0, 28);
  return bounded.length >= 3 ? bounded : 'kestrel-app';
}

export async function syncHerokuEnvironment({ apiKey, appId, env = {}, managedEnvKeys = [] }, { fetchImpl = fetch } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Invalid Heroku environment variables');
  const updates = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(key) || typeof value !== 'string') {
      throw new Error('Invalid Heroku environment variable');
    }
    updates[key] = value;
  }
  for (const key of new Set(Array.isArray(managedEnvKeys) ? managedEnvKeys : [])) {
    if (typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(key) && !Object.hasOwn(env, key)) {
      updates[key] = null;
    }
  }
  if (!Object.keys(updates).length) return { updated: false, keys: [] };
  await request(apiKey, `/apps/${encodeURIComponent(appId)}/config-vars`, {
    method: 'PATCH', fetchImpl, body: updates,
  });
  return { updated: true, keys: Object.keys(env) };
}

export async function deleteHerokuApp({ apiKey, appId }, { fetchImpl = fetch } = {}) {
  if (!apiKey || !appId) throw new Error('Heroku API key and app ID are required');
  try {
    await request(apiKey, `/apps/${encodeURIComponent(appId)}`, { method: 'DELETE', fetchImpl });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  return { deleted: true, appId };
}

function status(value) {
  if (value === 'succeeded') return 'deploying';
  if (value === 'failed') return 'failed';
  if (value === 'pending') return 'queued';
  return 'unknown';
}

async function createBuild({ apiKey, appId, repositoryUrl, commitSha, sourceArchiveUrl }, { fetchImpl = fetch } = {}) {
  if (!/^[a-fA-F0-9]{7,64}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required');
  const repo = repository(repositoryUrl);
  const sourceUrl = validateSourceArchiveUrl(repositoryUrl, commitSha, sourceArchiveUrl);
  const build = await request(apiKey, `/apps/${encodeURIComponent(appId)}/builds`, {
    method: 'POST', fetchImpl,
    body: { source_blob: { url: sourceUrl, version: commitSha } },
  });
  if (!build.id) throw new Error('Heroku did not return a build identifier');
  return { provider: 'heroku', deploymentId: build.id, status: status(build.status), releaseId: build.release?.id || null };
}

export async function createHerokuDeployment({ apiKey, repositoryUrl, branch = 'main', commitSha, projectName: name, dynoSize = 'basic', dynoQuantity = 1, sourceArchiveUrl, env = {}, managedEnvKeys = [] }, { fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('Heroku API key is required');
  estimateHerokuDynoCost(dynoSize, dynoQuantity);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.includes('//')) throw new Error('Invalid deployment branch');
  const repo = repository(repositoryUrl);
  if (!/^[a-fA-F0-9]{7,64}$/.test(commitSha || '')) throw new Error('A verified Git commit SHA is required');
  const app = await request(apiKey, '/apps', {
    method: 'POST', fetchImpl,
    body: { name: appName(name), region: 'us', stack: 'heroku-24' },
  });
  if (!app.id || !app.name) throw new Error('Heroku did not return an app identifier');
  try {
    await syncHerokuEnvironment({ apiKey, appId: app.id, env, managedEnvKeys }, { fetchImpl });
    const build = await createBuild({ apiKey, appId: app.id, repositoryUrl: `https://github.com/${repo.owner}/${repo.repo}`, commitSha, sourceArchiveUrl }, { fetchImpl });
    return { ...build, projectId: app.id, serviceId: app.name, environmentId: null, providerUrl: app.web_url || null, dynoSize, dynoQuantity };
  } catch (error) {
    try { await deleteHerokuApp({ apiKey, appId: app.id }, { fetchImpl }); } catch {}
    throw error;
  }
}

export async function deployHerokuApp({ apiKey, appId, repositoryUrl, commitSha, dynoSize = 'basic', dynoQuantity = 1, sourceArchiveUrl, env = {}, managedEnvKeys = [] }, { fetchImpl = fetch } = {}) {
  estimateHerokuDynoCost(dynoSize, dynoQuantity);
  await syncHerokuEnvironment({ apiKey, appId, env, managedEnvKeys }, { fetchImpl });
  return createBuild({ apiKey, appId, repositoryUrl, commitSha, sourceArchiveUrl }, { fetchImpl });
}

export async function getHerokuDeployment({ apiKey, appId, deploymentId, dynoSize = 'basic', dynoQuantity = 1 }, { fetchImpl = fetch } = {}) {
  estimateHerokuDynoCost(dynoSize, dynoQuantity);
  let build;
  let release = null;
  try {
    build = await request(apiKey, `/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(deploymentId)}`, { fetchImpl });
  } catch (error) {
    if (error.status !== 404) throw error;
    release = await request(apiKey, `/apps/${encodeURIComponent(appId)}/releases/${encodeURIComponent(deploymentId)}`, { fetchImpl });
    build = { status: 'succeeded', release: { id: release.id } };
  }
  const [app, formation] = await Promise.all([
    request(apiKey, `/apps/${encodeURIComponent(appId)}`, { fetchImpl }),
    request(apiKey, `/apps/${encodeURIComponent(appId)}/formation`, { fetchImpl }),
  ]);
  const web = Array.isArray(formation) ? formation.find((process) => process.type === 'web' || process.process_type === 'web') : null;
  const actualSize = String(web?.dyno_size?.name || web?.size || '').toLowerCase();
  const live = build.status === 'succeeded' && app.status === 'active' &&
    Number(web?.quantity || 0) === Number(dynoQuantity) && actualSize === String(dynoSize).toLowerCase();
  return {
    provider: 'heroku', deploymentId, providerStatus: release ? 'released' : build.status,
    status: live ? 'live' : build.status === 'succeeded' ? 'deploying' : status(build.status),
    providerUrl: app.web_url || null, canRollback: build.status === 'succeeded' && Boolean(build.release?.id),
  };
}

export async function configureHerokuFormation({ apiKey, appId, dynoSize = 'basic', dynoQuantity = 1 }, { fetchImpl = fetch } = {}) {
  estimateHerokuDynoCost(dynoSize, dynoQuantity);
  const current = await request(apiKey, `/apps/${encodeURIComponent(appId)}/formation`, { fetchImpl });
  const web = Array.isArray(current) ? current.find((process) => process.type === 'web' || process.process_type === 'web') : null;
  if (!web) return { configured: false, reason: 'Heroku has not created a web process formation yet' };
  const currentSize = String(web.dyno_size?.name || web.size || '').toLowerCase();
  if (currentSize === String(dynoSize).toLowerCase() && Number(web.quantity) === Number(dynoQuantity)) {
    return { configured: true, changed: false };
  }
  const updated = await request(apiKey, `/apps/${encodeURIComponent(appId)}/formation/web`, {
    method: 'PATCH', fetchImpl,
    body: { dyno_size: { name: dynoSize }, quantity: dynoQuantity },
  });
  return { configured: true, changed: true, formation: updated };
}

export async function getHerokuDeploymentLogs({ apiKey, appId, deploymentId }, { fetchImpl = fetch } = {}) {
  let build;
  try {
    build = await request(apiKey, `/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(deploymentId)}`, { fetchImpl });
  } catch (error) {
    if (error.status !== 404) throw error;
    return { build: [], runtime: [], unavailable: true, message: 'This Heroku release was created by rollback and has no build output stream.' };
  }
  if (!build.output_stream_url) return { build: [], runtime: [], unavailable: true, message: 'Heroku has not supplied a build output stream URL for this build.' };
  const response = await fetchImpl(build.output_stream_url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Heroku build log stream failed (${response.status})`);
  const output = (await response.text()).slice(-200000);
  return { build: output.split(/\r?\n/).filter(Boolean).map((message) => ({ message })), runtime: [] };
}

export async function rollbackHerokuDeployment({ apiKey, appId, deploymentId }, { fetchImpl = fetch } = {}) {
  let releaseId;
  try {
    const build = await request(apiKey, `/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(deploymentId)}`, { fetchImpl });
    releaseId = build.release?.id;
  } catch (error) {
    if (error.status !== 404) throw error;
    const priorRelease = await request(apiKey, `/apps/${encodeURIComponent(appId)}/releases/${encodeURIComponent(deploymentId)}`, { fetchImpl });
    if (priorRelease.eligible_for_rollback === false) throw new Error('The selected Heroku release is not eligible for rollback');
    releaseId = priorRelease.id;
  }
  if (!releaseId) throw new Error('The selected Heroku build has no successful release to roll back to');
  const release = await request(apiKey, `/apps/${encodeURIComponent(appId)}/releases`, {
    method: 'POST', fetchImpl, body: { release: releaseId },
  });
  if (!release.id) throw new Error('Heroku did not return a rollback release identifier');
  return { provider: 'heroku', deploymentId: release.id, status: 'deploying' };
}
