const API = 'https://api.machines.dev/v1';

async function request(token, path, { method = 'GET', body, fetchImpl = fetch, allowNotFound = false } = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (allowNotFound && response.status === 404) return null;
  if (response.status === 204) return {};
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Fly.io Machines API request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function safeAppName(value) {
  const name = String(value || 'kestrel-app').toLowerCase()
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return name.length >= 3 ? name : 'kestrel-app';
}

function validateImage(image) {
  if (typeof image !== 'string' || image.length > 512 ||
      !/^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9._/-]+(?::[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})$/i.test(image)) {
    throw new Error('A valid published OCI image reference is required for Fly.io deployment');
  }
  return image;
}

function machineConfig({ image, port, env, cpuKind, cpus, memoryMb }) {
  const internalPort = Number(port || 3000);
  if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535) throw new Error('Application port must be between 1 and 65535');
  return {
    image,
    env: env && typeof env === 'object' ? env : {},
    guest: { cpu_kind: cpuKind || 'shared', cpus: Number(cpus || 1), memory_mb: Number(memoryMb || 512) },
    services: [{
      protocol: 'tcp',
      internal_port: internalPort,
      ports: [{ port: 80, handlers: ['http'] }, { port: 443, handlers: ['tls', 'http'] }],
      force_instance_key: null,
    }],
    restart: { policy: 'always' },
    auto_destroy: false,
  };
}

async function allocatePublicAddresses(token, appName, fetchImpl) {
  const response = await fetchImpl('https://api.fly.io/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { app { sharedIpAddress } } }',
      variables: { input: { appId: appName, type: 'shared_v4', region: 'global' } },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.[0]?.message || `Fly.io IP allocation failed (${response.status})`;
    if (!/already|exists|allocated/i.test(message)) throw new Error(message);
  }
}

export async function ensureFlyApp({ token, appName, orgSlug }, fetchImpl) {
  const existing = await request(token, `/apps/${encodeURIComponent(appName)}`, { fetchImpl, allowNotFound: true });
  if (existing) {
    if (existing.organization?.slug && existing.organization.slug !== orgSlug) throw new Error('Fly.io app name is already owned by another organization');
    return existing;
  }
  return request(token, '/apps', {
    method: 'POST', fetchImpl,
    body: { app_name: appName, org_slug: orgSlug },
  });
}

async function createMachine({ token, appName, image, port, env, region, cpuKind, cpus, memoryMb }, { fetchImpl = fetch } = {}) {
  const machine = await request(token, `/apps/${encodeURIComponent(appName)}/machines`, {
    method: 'POST', fetchImpl,
    body: { name: `kestrel-${Date.now().toString(36)}`, region: region || 'iad', config: machineConfig({ image, port, env, cpuKind, cpus, memoryMb }), skip_service_checks: false },
  });
  if (!machine.id) throw new Error('Fly.io did not return a Machine identifier');
  return machine;
}

export async function createFlyDeployment({ token, orgSlug, projectName, containerImage, port, env, region, cpuKind, cpus, memoryMb }, { fetchImpl = fetch } = {}) {
  if (!token || !orgSlug) throw new Error('Fly.io token and organization slug are required');
  const image = validateImage(containerImage);
  const appName = safeAppName(projectName);
  await ensureFlyApp({ token, appName, orgSlug }, fetchImpl);
  await allocatePublicAddresses(token, appName, fetchImpl);
  const machine = await createMachine({ token, appName, image, port, env, region, cpuKind, cpus, memoryMb }, { fetchImpl });
  return {
    provider: 'flyio', projectId: appName, serviceId: appName, environmentId: region || 'iad',
    deploymentId: machine.id, status: machine.state === 'started' ? 'deploying' : 'queued',
    providerUrl: `https://${appName}.fly.dev`,
  };
}

export async function deployFlyApp({ token, appName, containerImage, port, env, region, cpuKind, cpus, memoryMb }, { fetchImpl = fetch } = {}) {
  const image = validateImage(containerImage);
  const machine = await createMachine({ token, appName, image, port, env, region, cpuKind, cpus, memoryMb }, { fetchImpl });
  return { provider: 'flyio', deploymentId: machine.id, status: machine.state === 'started' ? 'deploying' : 'queued', providerUrl: `https://${appName}.fly.dev` };
}

export async function getFlyDeployment({ token, appName, deploymentId }, { fetchImpl = fetch } = {}) {
  const machine = await request(token, `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(deploymentId)}`, { fetchImpl });
  const state = machine.state || 'unknown';
  if (state === 'started') {
    const machines = await request(token, `/apps/${encodeURIComponent(appName)}/machines`, { fetchImpl });
    for (const old of machines.filter((item) => item.id !== deploymentId && item.state === 'started')) {
      await request(token, `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(old.id)}/stop`, { method: 'POST', fetchImpl });
    }
  }
  return {
    provider: 'flyio', deploymentId, providerStatus: state,
    status: state === 'started' ? 'live' : ['stopped', 'destroyed'].includes(state) ? 'failed' : 'deploying',
    providerUrl: `https://${appName}.fly.dev`, canRollback: state === 'started' || state === 'stopped',
    machineState: state,
  };
}

export async function getFlyDeploymentLogs({ token, appName, deploymentId }, { fetchImpl = fetch } = {}) {
  const machine = await request(token, `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(deploymentId)}`, { fetchImpl });
  const events = Array.isArray(machine.events) ? machine.events.slice(-100) : [];
  return {
    build: [],
    runtime: events.map((event) => ({ timestamp: event.timestamp || null, message: [event.type, event.status, event.source].filter(Boolean).join(' ') || 'Fly Machine event' })),
    unavailable: true,
    message: 'Fly Machines API exposes lifecycle events here, not application stdout/stderr. Runtime logs require a configured Fly log drain.',
  };
}

export async function rollbackFlyDeployment({ token, appName, deploymentId }, { fetchImpl = fetch } = {}) {
  const target = await request(token, `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(deploymentId)}`, { fetchImpl });
  if (target.state !== 'started') {
    await request(token, `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(deploymentId)}/start`, { method: 'POST', fetchImpl });
  }
  const machines = await request(token, `/apps/${encodeURIComponent(appName)}/machines`, { fetchImpl });
  for (const machine of machines.filter((item) => item.id !== deploymentId && item.state === 'started')) {
    await request(token, `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machine.id)}/stop`, { method: 'POST', fetchImpl });
  }
  return { provider: 'flyio', deploymentId, status: 'deploying' };
}
