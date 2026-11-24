import { createVercelSandboxClient, makeSandboxName } from './vercel-sandbox.mjs';

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

function validateSource(repositoryUrl, commitSha) {
  let url;
  try { url = new URL(repositoryUrl); } catch { throw new Error('A public GitHub repository URL is required for Fly.io source builds'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' ||
      url.username || url.password || url.search || url.hash ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(url.pathname) ||
      !/^[a-f0-9]{40}$/i.test(String(commitSha || ''))) {
    throw new Error('Fly.io source builds require a public GitHub repository and a full 40-character commit SHA');
  }
  return \`https://github.com\${url.pathname.replace(/\.git$/i, '').replace(/\/$/, '')}\`;
}

function flySourceBuildScript() {
  return String.raw\`set -euo pipefail
export PATH="$HOME/.fly/bin:$PATH"
if ! command -v flyctl >/dev/null 2>&1; then
  curl -fsSL https://fly.io/install.sh | sh
fi
export PATH="$HOME/.fly/bin:$PATH"

if [ ! -f fly.toml ]; then
  if [ -f Dockerfile ] || [ -f dockerfile ]; then
    cat > fly.toml <<'FLYTOML'
app = "\${KESTREL_FLY_APP}"
primary_region = "\${KESTREL_FLY_REGION}"
[http_service]
  internal_port = \${KESTREL_FLY_PORT}
  force_https = true
  auto_start_machines = true
  auto_stop_machines = "off"
  min_machines_running = 1
FLYTOML
  else
    cat > fly.toml <<'FLYTOML'
app = "\${KESTREL_FLY_APP}"
primary_region = "\${KESTREL_FLY_REGION}"
[build]
  builder = "paketobuildpacks/builder-jammy-base"
[http_service]
  internal_port = \${KESTREL_FLY_PORT}
  force_https = true
  auto_start_machines = true
  auto_stop_machines = "off"
  min_machines_running = 1
FLYTOML
  fi
fi

node --input-type=module -e '
import fs from "node:fs";
const values = JSON.parse(process.env.KESTREL_ENV_JSON || "{}");
const rows = Object.entries(values).filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string");
fs.writeFileSync(".kestrel-secrets.env", rows.map(([key, value]) => key + "=" + JSON.stringify(value)).join("\\n"), { mode: 0o600 });
'
if [ -s .kestrel-secrets.env ]; then
  flyctl secrets import --app "$KESTREL_FLY_APP" < .kestrel-secrets.env
fi
rm -f .kestrel-secrets.env

flyctl deploy --remote-only --app "$KESTREL_FLY_APP" --region "$KESTREL_FLY_REGION" --yes
flyctl machine list --json --app "$KESTREL_FLY_APP" > .kestrel-machines.json
node --input-type=module -e '
import fs from "node:fs";
const machines = JSON.parse(fs.readFileSync(".kestrel-machines.json", "utf8"));
const active = machines.filter((machine) => machine.state === "started")
  .sort((a, b) => Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0));
if (!active[0]?.id) process.exit(12);
console.log("KESTREL_MACHINE_ID=" + active[0].id);
'
\`;
}

async function deployFlySource({
  token, appName, repositoryUrl, commitSha, env, port, region,
}, {
  sandboxClient = createVercelSandboxClient(), sandboxRegion = process.env.KESTREL_SANDBOX_REGION || 'iad1',
  timeoutMs = 1_800_000,
} = {}) {
  const sourceUrl = validateSource(repositoryUrl, commitSha);
  const sandboxName = makeSandboxName();
  let sessionId;
  try {
    const created = await sandboxClient.create({
      name: sandboxName, vcpus: 2, timeoutMs, region: sandboxRegion,
      tags: { managedBy: 'kestrel', provider: 'flyio' },
      source: { type: 'git', url: sourceUrl, revision: commitSha },
    });
    sessionId = created?.session?.id || created?.sandbox?.currentSessionId;
    if (!sessionId) throw new Error('Kestrel build sandbox did not return a session');
    const result = await sandboxClient.runCommand(sessionId, {
      command: 'bash',
      args: ['-lc', flySourceBuildScript()],
      cwd: '/vercel/sandbox',
      timeoutMs,
      env: {
        FLY_API_TOKEN: token,
        KESTREL_FLY_APP: appName,
        KESTREL_FLY_REGION: region || 'iad',
        KESTREL_FLY_PORT: String(port || 8080),
        KESTREL_ENV_JSON: JSON.stringify(env || {}),
      },
    });
    if (result.exitCode !== 0) throw new Error('Fly.io remote source build or deployment failed');
    const machineId = String(result.stdout || '').match(/^KESTREL_MACHINE_ID=([a-z0-9]+)$/m)?.[1];
    if (!machineId) throw new Error('Fly.io deployment completed without returning a running Machine identifier');
    return machineId;
  } finally {
    try { await sandboxClient.delete(sandboxName); } catch {}
  }
}

export async function createFlyDeployment({
  token, orgSlug, projectName, repositoryUrl, commitSha, port, env, region,
}, {
  fetchImpl = fetch, sandboxClient = createVercelSandboxClient(), sandboxRegion,
} = {}) {
  if (!token || !orgSlug) throw new Error('Fly.io token and organization slug are required');
  validateSource(repositoryUrl, commitSha);
  const appName = safeAppName(projectName);
  await ensureFlyApp({ token, appName, orgSlug }, fetchImpl);
  await allocatePublicAddresses(token, appName, fetchImpl);
  const machineId = await deployFlySource({
    token, appName, repositoryUrl, commitSha, port, env, region,
  }, { sandboxClient, sandboxRegion });
  return {
    provider: 'flyio', projectId: appName, serviceId: appName, environmentId: region || 'iad',
    deploymentId: machineId, status: 'deploying', providerUrl: \`https://\${appName}.fly.dev\`,
  };
}

export async function deployFlyApp({
  token, appName, repositoryUrl, commitSha, port, env, region,
}, { sandboxClient = createVercelSandboxClient(), sandboxRegion } = {}) {
  if (!token || !appName) throw new Error('Fly.io token and app name are required');
  const machineId = await deployFlySource({
    token, appName, repositoryUrl, commitSha, port, env, region,
  }, { sandboxClient, sandboxRegion });
  return {
    provider: 'flyio', deploymentId: machineId, status: 'deploying',
    providerUrl: \`https://\${appName}.fly.dev\`,
  };
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
