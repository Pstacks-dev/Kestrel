import { createVercelSandboxClient } from './vercel-sandbox.mjs';
import { ensureFlyApp } from './hosting-flyio.mjs';
import { getGoogleAccessToken } from './hosting-cloud-run.mjs';
import { prepareEcsImageRegistry } from './hosting-aws-ecs-express.mjs';

const BUILD_TIMEOUT_MS = 45 * 60 * 1000;

function safeName(value, max = 58) {
  const name = String(value || 'kestrel-app').toLowerCase()
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max);
  return name.length >= 2 ? name : 'kestrel-app';
}

async function googleRegistry({ serviceAccountJson, projectId, region }, projectName, commitSha, fetchImpl) {
  const access = await getGoogleAccessToken(serviceAccountJson, fetchImpl);
  const host = `${region}-docker.pkg.dev`;
  const repositoryId = 'kestrel';
  const base = `https://artifactregistry.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/repositories`;
  const headers = { Authorization: `Bearer ${access}`, Accept: 'application/json', 'content-type': 'application/json' };
  const existing = await fetchImpl(`${base}/${repositoryId}`, { headers, signal: AbortSignal.timeout(20000) });
  if (existing.status === 404) {
    const created = await fetchImpl(`${base}?repositoryId=${repositoryId}`, {
      method: 'POST', headers,
      body: JSON.stringify({ format: 'DOCKER', description: 'Kestrel managed OCI image repository' }),
      signal: AbortSignal.timeout(30000),
    });
    if (!created.ok && created.status !== 409) throw new Error(`Google Artifact Registry repository creation failed (${created.status})`);
  } else if (!existing.ok) {
    throw new Error(`Google Artifact Registry access failed (${existing.status})`);
  }
  const name = safeName(projectName, 100);
  return {
    registryHost: host,
    registryUser: 'oauth2accesstoken',
    registryPassword: access,
    imageRef: `${host}/${projectId}/${repositoryId}/${name}:${commitSha.toLowerCase()}`,
    region,
  };
}

async function flyRegistry(credentials, projectName, commitSha, fetchImpl) {
  const appName = safeName(projectName, 60);
  await ensureFlyApp({ token: credentials.token, appName, orgSlug: credentials.orgSlug }, fetchImpl);
  return {
    registryHost: 'registry.fly.io',
    registryUser: 'x',
    registryPassword: credentials.token,
    imageRef: `registry.fly.io/${appName}:${commitSha.toLowerCase()}`,
    appName,
  };
}

async function awsRegistry(credentials, projectName, commitSha, fetchImpl) {
  return prepareEcsImageRegistry({ ...credentials, projectName, commitSha }, { fetchImpl });
}

export function createManagedOciBuildScript() {
  return String.raw`#!/usr/bin/env bash
set -euo pipefail

install_docker() {
  if command -v apt-get >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then sudo -n apt-get update -qq && sudo -n apt-get install -y docker.io git curl ca-certificates
    else apt-get update -qq && apt-get install -y docker.io git curl ca-certificates; fi
  elif command -v dnf >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then sudo -n dnf install -y docker git curl ca-certificates
    else dnf install -y docker git curl ca-certificates; fi
  elif command -v yum >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then sudo -n yum install -y docker git curl ca-certificates
    else yum install -y docker git curl ca-certificates; fi
  else
    echo "No supported package manager is available to install Docker" >&2
    return 1
  fi
}

if ! command -v docker >/dev/null 2>&1 || ! command -v dockerd >/dev/null 2>&1; then install_docker; fi

DOCKER="docker"
if command -v sudo >/dev/null 2>&1; then
  DOCKER="sudo -n docker"
  if ! sudo -n docker info >/dev/null 2>&1; then
    sudo -n dockerd --host=unix:///var/run/docker.sock >/tmp/kestrel-dockerd.log 2>&1 &
  fi
else
  if ! docker info >/dev/null 2>&1; then
    dockerd --host=unix:///var/run/docker.sock >/tmp/kestrel-dockerd.log 2>&1 &
  fi
fi

ready=0
for attempt in $(seq 1 45); do
  if $DOCKER info >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "Docker daemon did not become ready inside the isolated build sandbox" >&2
  tail -n 80 /tmp/kestrel-dockerd.log 2>/dev/null || true
  exit 1
fi

WORKSPACE=/vercel/sandbox/source
rm -rf "$WORKSPACE"
git clone --filter=blob:none --no-checkout "$REPOSITORY_URL" "$WORKSPACE"
git -C "$WORKSPACE" fetch --depth=1 origin "$COMMIT_SHA"
git -C "$WORKSPACE" checkout --detach "$COMMIT_SHA"
git -C "$WORKSPACE" submodule update --init --recursive || true

printf '%s' "$REGISTRY_PASSWORD" | $DOCKER login "$REGISTRY_HOST" --username "$REGISTRY_USER" --password-stdin

if [ -f "$WORKSPACE/Dockerfile" ] || [ -f "$WORKSPACE/dockerfile" ]; then
  cd "$WORKSPACE"
  DOCKER_BUILDKIT=1 $DOCKER build --pull --platform linux/amd64 \
    --build-arg HTTP_PROXY="${HTTP_PROXY:-}" \
    --build-arg HTTPS_PROXY="${HTTPS_PROXY:-}" \
    --build-arg NO_PROXY="${NO_PROXY:-}" \
    --tag "$IMAGE_REF" .
else
  PACK_VERSION=0.37.0
  curl -fsSL "https://github.com/buildpacks/pack/releases/download/v${PACK_VERSION}/pack-v${PACK_VERSION}-linux.tgz" -o /tmp/pack.tgz
  mkdir -p /tmp/pack && tar -xzf /tmp/pack.tgz -C /tmp/pack
  PACK_BIN=$(find /tmp/pack -type f -name pack -perm -u+x | head -n 1)
  if [ -z "$PACK_BIN" ]; then echo "Cloud Native Buildpacks CLI was not installed" >&2; exit 1; fi
  "$PACK_BIN" build "$IMAGE_REF" --builder paketobuildpacks/builder-jammy-base:latest --path "$WORKSPACE" \
    --env "HTTP_PROXY=${HTTP_PROXY:-}" --env "HTTPS_PROXY=${HTTPS_PROXY:-}" --env "NO_PROXY=${NO_PROXY:-}"
fi

$DOCKER push "$IMAGE_REF"
echo "KESTREL_IMAGE_REF=$IMAGE_REF"
`;
}

export async function startManagedOciBuild({
  providerId, credentials, projectName, repositoryUrl, commitSha, runId,
  fetchImpl = fetch, sandboxClient = createVercelSandboxClient(),
}) {
  if (!/^[a-fA-F0-9]{40}$/.test(commitSha || '')) throw new Error('A full Git commit SHA is required for an OCI build');
  const projectSlug = safeName(projectName, 100);
  let registry;
  if (providerId === 'flyio') registry = await flyRegistry(credentials, projectSlug, commitSha, fetchImpl);
  else if (providerId === 'google-cloud-run') {
    registry = await googleRegistry({ ...credentials, region: credentials.region || 'us-central1' }, projectSlug, commitSha, fetchImpl);
  } else if (providerId === 'aws-ecs-express') registry = await awsRegistry(credentials, projectSlug, commitSha, fetchImpl);
  else throw new Error('This hosting provider does not require an OCI image build');

  const sandboxName = `kestrel-build-${String(runId).replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}`;
  const created = await sandboxClient.create({
    name: sandboxName,
    vcpus: 4,
    timeoutMs: BUILD_TIMEOUT_MS,
    region: process.env.KESTREL_SANDBOX_REGION,
    tags: { managedBy: 'kestrel', purpose: 'managed-oci-build', runId: String(runId).slice(0, 36) },
  });
  const sandbox = created?.sandbox;
  const session = created?.session;
  if (!sandbox?.name || !session?.id) throw new Error('Managed build sandbox did not return a running session');

  const command = await sandboxClient.startCommand(session.id, {
    command: 'bash',
    args: ['-lc', createManagedOciBuildScript()],
    cwd: '/vercel/sandbox',
    timeoutMs: BUILD_TIMEOUT_MS,
    env: {
      REPOSITORY_URL: repositoryUrl,
      COMMIT_SHA: commitSha,
      REGISTRY_HOST: registry.registryHost,
      REGISTRY_USER: registry.registryUser,
      REGISTRY_PASSWORD: registry.registryPassword,
      IMAGE_REF: registry.imageRef,
    },
  });
  return {
    sandboxName: sandbox.name,
    sessionId: session.id,
    commandId: command.id,
    imageRef: registry.imageRef,
    providerMetadata: { appName: registry.appName || null, region: registry.region || credentials.region || null },
  };
}

export async function pollManagedOciBuild({ sandboxName, sessionId, commandId }, { sandboxClient = createVercelSandboxClient() } = {}) {
  const command = await sandboxClient.getCommand(sessionId, commandId);
  if (command.exitCode === null || command.exitCode === undefined) return { state: 'building' };
  const logs = await sandboxClient.getCommandLogs(sessionId, commandId, { maxWaitMs: 1000, maxBytes: 64 * 1024 });
  if (Number(command.exitCode) !== 0) {
    const detail = String(logs.stderr || logs.stdout || 'OCI image build failed').slice(-3000);
    throw new Error(detail);
  }
  const imageRef = String(logs.stdout || '').match(/^KESTREL_IMAGE_REF=(.+)$/m)?.[1]?.trim();
  if (!imageRef) throw new Error('OCI build completed without returning the pushed image reference');
  await cleanupManagedOciBuild({ sandboxName, sessionId, sandboxClient });
  return { state: 'succeeded', imageRef };
}

export async function cleanupManagedOciBuild({ sandboxName, sessionId, sandboxClient = createVercelSandboxClient() }) {
  try { if (sessionId) await sandboxClient.stop(sessionId); } catch {}
  try { if (sandboxName) await sandboxClient.delete(sandboxName); } catch {}
}
