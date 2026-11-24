import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const IMAGE_REF = /^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9._/-]+:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/i;
const COMMIT_SHA = /^[a-f0-9]{40}$/i;

export class OciBuildError extends Error {
  constructor(message, code = 'oci_build_failed', status = 502) {
    super(message);
    this.name = 'OciBuildError';
    this.code = code;
    this.status = status;
  }
}

function registryFor(image) {
  const first = image.split('/')[0];
  return first.includes('.') || first.includes(':') || first === 'localhost' ? first : 'docker.io';
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new OciBuildError('OCI build input is required', 'oci_invalid_input', 400);
  if (typeof input.contextDir !== 'string' || !path.isAbsolute(input.contextDir)) {
    throw new OciBuildError('An absolute build context directory is required', 'oci_invalid_context', 400);
  }
  if (!IMAGE_REF.test(input.image)) throw new OciBuildError('Image must use a registry-qualified name and immutable build tag', 'oci_invalid_image', 400);
  if (!COMMIT_SHA.test(input.commitSha || '')) throw new OciBuildError('A full Git commit SHA is required', 'oci_invalid_commit', 400);
  if (typeof input.registryUsername !== 'string' || !input.registryUsername ||
      typeof input.registryPassword !== 'string' || !input.registryPassword) {
    throw new OciBuildError('Registry username and password are required', 'oci_registry_credentials_missing', 400);
  }
  const registry = registryFor(input.image);
  if (input.registry && input.registry !== registry) {
    throw new OciBuildError('Registry credentials do not match the image registry', 'oci_registry_mismatch', 400);
  }
  const dockerfile = input.dockerfile || 'Dockerfile';
  if (typeof dockerfile !== 'string' || path.isAbsolute(dockerfile) ||
      dockerfile.replace(/\\/g, '/').split('/').some((part) => part === '..' || part === '')) {
    throw new OciBuildError('Dockerfile must be a safe path inside the build context', 'oci_invalid_dockerfile', 400);
  }
  const platforms = input.platforms || ['linux/amd64'];
  if (!Array.isArray(platforms) || !platforms.length || platforms.length > 4 ||
      platforms.some((platform) => !/^linux\/(?:amd64|arm64|arm\/v[6-8])$/.test(platform))) {
    throw new OciBuildError('One or more supported Linux target platforms are required', 'oci_invalid_platform', 400);
  }
  const buildArgs = input.buildArgs || {};
  if (!buildArgs || typeof buildArgs !== 'object' || Array.isArray(buildArgs) ||
      Object.entries(buildArgs).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(key) || typeof value !== 'string' || value.length > 4096)) {
    throw new OciBuildError('Build arguments must be named strings', 'oci_invalid_build_args', 400);
  }
  return { ...input, registry, dockerfile, platforms, buildArgs };
}

function runProcess(command, args, { env, input, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const append = (current, chunk) => (current + chunk.toString()).slice(-128 * 1024);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new OciBuildError(error.message, 'oci_builder_unavailable', 503));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new OciBuildError(`OCI builder command failed (exit ${code}): ${stderr.slice(-4000)}`));
      } else resolve({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Build and push a commit-pinned OCI image from a checked-out source directory.
 * The caller must run this on a managed worker with Docker Buildx and registry
 * network access. Registry credentials are supplied only over stdin to docker login.
 */
export async function buildAndPublishOciImage(rawInput, {
  run = runProcess,
  dockerBin = process.env.KESTREL_DOCKER_BIN || 'docker',
  tempRoot = os.tmpdir(),
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  const input = validateInput(rawInput);
  const context = path.resolve(input.contextDir);
  const contextStat = await stat(context).catch(() => null);
  if (!contextStat?.isDirectory()) throw new OciBuildError('Build context directory does not exist', 'oci_context_missing', 400);
  const dockerfilePath = path.resolve(context, input.dockerfile);
  if (!dockerfilePath.startsWith(context + path.sep)) throw new OciBuildError('Dockerfile escapes the build context', 'oci_invalid_dockerfile', 400);
  const dockerfileStat = await stat(dockerfilePath).catch(() => null);
  if (!dockerfileStat?.isFile()) throw new OciBuildError('Dockerfile was not found in the build context', 'oci_dockerfile_missing', 422);

  const dockerConfig = await mkdtemp(path.join(tempRoot, 'kestrel-oci-'));
  await mkdir(dockerConfig, { recursive: true });
  const metadataPath = path.join(dockerConfig, 'build-metadata.json');
  const env = { ...process.env, DOCKER_CONFIG: dockerConfig };
  const runOptions = { env, timeoutMs };
  try {
    await run(dockerBin, ['login', input.registry, '--username', input.registryUsername, '--password-stdin'], {
      ...runOptions, input: input.registryPassword,
    });
    const args = [
      'buildx', 'build', '--push', '--pull',
      '--file', input.dockerfile,
      '--tag', input.image,
      '--platform', input.platforms.join(','),
      '--label', `org.opencontainers.image.revision=${input.commitSha.toLowerCase()}`,
      '--label', 'org.opencontainers.image.source=https://github.com/',
      '--metadata-file', metadataPath,
    ];
    for (const [key, value] of Object.entries(input.buildArgs)) args.push('--build-arg', `${key}=${value}`);
    args.push(context);
    await run(dockerBin, args, runOptions);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const digest = metadata['containerimage.digest'];
    if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new OciBuildError('Builder did not return a valid pushed image digest', 'oci_digest_missing');
    }
    return {
      image: input.image,
      digest,
      imageDigestRef: `${input.image.split(':').slice(0, -1).join(':')}@${digest}`,
      commitSha: input.commitSha.toLowerCase(),
      platforms: input.platforms,
      pushed: true,
    };
  } catch (error) {
    if (error instanceof OciBuildError) throw error;
    throw new OciBuildError(error.message || 'OCI image build failed');
  } finally {
    await rm(dockerConfig, { recursive: true, force: true });
  }
}
