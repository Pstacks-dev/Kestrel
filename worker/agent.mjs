import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { redactSecrets } from '../server/lib/security.mjs';
import { getDockerHostWorkspacePath } from './docker-paths.mjs';
import { buildAndPublishOciImage } from '../server/lib/oci-image-builder.mjs';
import { resolveOciBuildContext } from './oci-context.mjs';
import { resolveJobWorkingDirectory } from './working-directory.mjs';
import { resolveWorkerToken, resolveWorkerConnection, resolveWorkerEgress, resolveWorkerExecutor } from './config.mjs';
import { createDrainController } from './drain-controller.mjs';

const { api: API, workerId: WORKER_ID } = resolveWorkerConnection();
const TOKEN = resolveWorkerToken();
resolveWorkerEgress();
const EXECUTOR = resolveWorkerExecutor();
const ROOT = path.resolve(process.env.KESTREL_WORKER_WORKDIR || process.env.KESTREL_WORKDIR || '.kestrel-worker');
// When the agent runs in a Compose container with the host Docker socket mounted,
// the Docker daemon needs the host-side path for bind mounts, not the agent's path.
const HOST_ROOT = path.resolve(process.env.KESTREL_WORKER_HOST_WORKDIR || ROOT);
const REPO_URL = process.env.KESTREL_REPOSITORY_URL;
const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.KESTREL_CONCURRENCY || 1)));
const DOCKER = process.env.KESTREL_DOCKER_BIN || 'docker';
const JOB_IMAGE = process.env.KESTREL_JOB_IMAGE || 'node:22-bookworm-slim';
const JOB_NETWORK = process.env.KESTREL_JOB_NETWORK === 'none' ? 'none' : 'bridge';
// Executor is validated before any worker polling begins.

if (process.env.NODE_ENV === 'production' && !/@sha256:[a-f0-9]{64}$/i.test(JOB_IMAGE) && EXECUTOR === 'docker') {
  throw new Error('Production workers require KESTREL_JOB_IMAGE pinned by immutable sha256 digest');
}

const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${TOKEN}`,
  'x-worker-id': WORKER_ID,
};

let isDraining = false;
let managedImageBuildActive = false;
let managedImageBuildAbortController = null;
const activeJobs = new Map(); // jobId -> { abortController, containerName?, child? }

async function api(endpoint, body) {
  const r = await fetch(`${API}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${endpoint}: ${r.status} ${text}`);
  }
  return r.json();
}

async function apiGet(endpoint, signal) {
  const response = await fetch(`${API}${endpoint}`, {
    method: 'GET',
    headers,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${endpoint}: ${response.status} ${text}`);
  }
  return response.json();
}

async function downloadUploadedSource(job, workspace, abortSignal) {
  if (abortSignal?.aborted) throw new Error('Worker is draining; uploaded-source download was canceled');
  const result = await apiGet(`/api/workers/projects/${encodeURIComponent(job.projectId)}/source-files`, abortSignal);
  const files = Array.isArray(result.files) ? result.files : [];
  let totalBytes = 0;
  for (const file of files) {
    if (abortSignal?.aborted) throw new Error('Worker is draining; uploaded-source download was canceled');
    const relative = String(file.path || '').replace(/\\\\/g, '/');
    const segments = relative.split('/');
    if (!relative || relative.startsWith('/') || segments.some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Server returned an unsafe uploaded-source path');
    }
    const destination = path.resolve(workspace, ...segments);
    if (destination !== workspace && !destination.startsWith(workspace + path.sep)) {
      throw new Error('Uploaded source path escaped the job workspace');
    }
    const response = await fetch(file.url, abortSignal ? { signal: abortSignal } : {});
    if (!response.ok) throw new Error(`Could not download uploaded source file: ${relative}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) throw new Error(`Uploaded source file exceeds 20 MiB: ${relative}`);
    totalBytes += bytes.length;
    if (totalBytes > 250 * 1024 * 1024) throw new Error('Uploaded source exceeds the 250 MiB job limit');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: 'w' });
    console.log(`[source] Downloaded ${relative} (${bytes.length} bytes)`);
  }
  if (!files.length) throw new Error('This uploaded project contains no files');
}

async function runCommand(command, cwd, onLine, job, secretValues, abortController) {
  const abortSignal = abortController?.signal;
  const start = Date.now();
  const timeoutMs = (job.timeoutSeconds || 1800) * 1000;

  // Mock executor for unit testing worker protocol
  if (EXECUTOR === 'mock') {
    onLine('stdout', `[Mock Executor] Executing: ${command}`);
    await new Promise((r) => setTimeout(r, 100));
    return { exitCode: 0, durationMs: Date.now() - start };
  }

  // Local executor (when running in environments without Docker socket)
  if (EXECUTOR === 'local') {
    return new Promise((resolve) => {
      const isWindows = process.platform === 'win32';
      const shellCmd = isWindows ? 'cmd.exe' : '/bin/sh';
      const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];

      const env = {
        ...process.env,
        CI: 'true',
        KESTREL: 'true',
        ...job.secrets,
      };

      const child = spawn(shellCmd, shellArgs, {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      activeJobs.set(job.id, { ...activeJobs.get(job.id), abortController, child });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      const abortHandler = () => {
        child.kill('SIGTERM');
      };
      abortSignal?.addEventListener('abort', abortHandler, { once: true });

      let tail = '';
      for (const [stream, pipe] of [
        ['stdout', child.stdout],
        ['stderr', child.stderr],
      ]) {
        pipe.on('data', (buf) => {
          const raw = tail + buf.toString();
          const lines = raw.split(/\r?\n/);
          tail = lines.pop() || '';
          for (const line of lines) {
            if (line) onLine(stream, redactSecrets(line, secretValues));
          }
        });
        pipe.on('end', () => {
          if (tail) {
            onLine(stream, redactSecrets(tail, secretValues));
            tail = '';
          }
        });
      }

      child.on('close', (code) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', abortHandler);
        activeJobs.set(job.id, { abortController });
        resolve({
          exitCode: timedOut ? 124 : abortSignal?.aborted ? 130 : code ?? 1,
          durationMs: Date.now() - start,
        });
      });

      child.on('error', (e) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', abortHandler);
        activeJobs.set(job.id, { abortController });
        onLine('stderr', redactSecrets(e.message, secretValues));
        resolve({ exitCode: 1, durationMs: Date.now() - start });
      });
    });
  }

  // Default Docker container executor
  return new Promise((resolve) => {
    const containerName = `kestrel-job-${String(job.id).replace(/[^a-zA-Z0-9_.-]/g, '')}`;
    activeJobs.set(job.id, { ...activeJobs.get(job.id), containerName, abortController });

    const args = [
      'run',
      '--rm',
      '--init',
      '--name',
      containerName,
      '--network',
      JOB_NETWORK,
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit',
      String(Number(process.env.KESTREL_JOB_PIDS_LIMIT || 256)),
      '--memory',
      `${Math.min(8192, Math.max(256, Number(job.memoryLimitMb || 2048)))}m`,
      '--memory-swap',
      `${Math.min(8192, Math.max(256, Number(job.memoryLimitMb || 2048)))}m`,
      '--cpus',
      String(Math.min(8, Math.max(0.25, Number(job.cpuMillicores || 2000) / 1000))),
      '--user',
      '1000:1000',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=512m',
      '--mount',
      `type=bind,src=${getDockerHostWorkspacePath(ROOT, HOST_ROOT, cwd)},dst=/workspace`,
      '--workdir',
      '/workspace',
      '--mount',
      `type=volume,src=kestrel-npm-${String(job.projectId || 'shared').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40)},dst=/home/node/.npm`,
      '--env',
      'CI=true',
      '--env',
      'KESTREL=true',
    ];

    // Inject decrypted secrets into container environment safely
    if (job.secrets && typeof job.secrets === 'object') {
      for (const [key, val] of Object.entries(job.secrets)) {
        if (/^[A-Za-z0-9_]+$/.test(key)) {
          args.push('--env', `${key}=${String(val)}`);
        }
      }
    }

    // The official Node image entrypoint expects an executable, not a shell command string.
    // Explicitly invoke a login shell so compound pipeline commands (&&, pipes, env expansion) run correctly.
    args.push(JOB_IMAGE, 'sh', '-lc', command);

    const child = spawn(DOCKER, args, { cwd, shell: false, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      const stop = spawn(DOCKER, ['stop', '--time', '5', containerName], { stdio: 'ignore' });
      stop.on('error', () => {});
    }, timeoutMs);

    const abortHandler = () => {
      const stop = spawn(DOCKER, ['stop', '--time', '2', containerName], { stdio: 'ignore' });
      stop.on('error', () => {});
    };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    let tail = '';
    for (const [stream, pipe] of [
      ['stdout', child.stdout],
      ['stderr', child.stderr],
    ]) {
      pipe.on('data', (buf) => {
        const raw = tail + buf.toString();
        const lines = raw.split(/\r?\n/);
        tail = lines.pop() || '';
        for (const line of lines) {
          if (line) onLine(stream, redactSecrets(line, secretValues));
        }
      });
      pipe.on('end', () => {
        if (tail) {
          onLine(stream, redactSecrets(tail, secretValues));
          tail = '';
        }
      });
    }

    child.on('close', (code) => {
      clearTimeout(timeout);
      abortSignal?.removeEventListener('abort', abortHandler);
      activeJobs.set(job.id, { abortController });
      resolve({
        exitCode: timedOut ? 124 : abortSignal?.aborted ? 130 : code ?? 1,
        durationMs: Date.now() - start,
      });
    });

    child.on('error', (e) => {
      clearTimeout(timeout);
      abortSignal?.removeEventListener('abort', abortHandler);
      activeJobs.set(job.id, { abortController });
      onLine('stderr', redactSecrets(e.message, secretValues));
      resolve({ exitCode: 1, durationMs: Date.now() - start });
    });
  });
}

async function ensureJobImage() {
  if (EXECUTOR !== 'docker') return;
  await new Promise((resolve, reject) => {
    const c = spawn(DOCKER, ['image', 'inspect', JOB_IMAGE], { stdio: 'ignore' });
    c.on('close', (code) => {
      if (code === 0) return resolve();
      const pull = spawn(DOCKER, ['pull', JOB_IMAGE], { stdio: 'inherit' });
      pull.on('close', (n) => (n === 0 ? resolve() : reject(new Error(`Unable to pull job image ${JOB_IMAGE}`))));
      pull.on('error', reject);
    });
    c.on('error', reject);
  });
}

async function runGit(args, cwd, onLine, extraEnv = {}, abortSignal) {
  return new Promise((resolve) => {
    const start = Date.now();
    if (abortSignal?.aborted) {
      resolve({ exitCode: 130, durationMs: Date.now() - start, stdout: '' });
      return;
    }
    const child = spawn('git', args, {
      cwd,
      shell: false,
      env: { ...process.env, ...extraEnv, CI: 'true', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), Number(process.env.KESTREL_GIT_TIMEOUT_MS || 300000));
    const abortHandler = () => child.kill('SIGTERM');
    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', abortHandler);
    };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    for (const [stream, pipe] of [
      ['stdout', child.stdout],
      ['stderr', child.stderr],
    ]) {
      pipe.on('data', (buf) => {
        const chunk = buf.toString();
        if (stream === 'stdout') stdout += chunk;
        for (const line of chunk.split(/\r?\n/)) {
          if (line) onLine(stream, line);
        }
      });
    }

    child.on('close', (code) => {
      cleanup();
      resolve({ exitCode: abortSignal?.aborted ? 130 : code ?? 1, durationMs: Date.now() - start, stdout });
    });
    child.on('error', (e) => {
      cleanup();
      onLine('stderr', e.message);
      resolve({ exitCode: 1, durationMs: Date.now() - start, stdout });
    });
  });
}

// Upload real artifact bytes to private object storage through the authenticated control plane.
async function collectArtifacts(job, workspace, workingDirectory = workspace, abortSignal) {
  const roots = ['dist', 'build', 'artifacts'];
  const maxFiles = 5000;
  const maxTotal = 250 * 1024 * 1024;
  const maxFile = 100 * 1024 * 1024;
  let uploaded = 0;
  let total = 0;

  async function walk(directory, relativeRoot) {
    if (uploaded >= maxFiles || total >= maxTotal) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (abortSignal?.aborted) throw new Error('Worker is draining; artifact collection was canceled');
      if (uploaded >= maxFiles || total >= maxTotal) break;
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeRoot, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(absolute);
      if (!stat.size || stat.size > maxFile || total + stat.size > maxTotal) continue;
      const bytes = await fs.readFile(absolute);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const session = await api(`/api/workers/jobs/${encodeURIComponent(job.id)}/artifacts/upload-url`, {
        leaseToken: job.leaseToken, name: relative, sizeBytes: bytes.length,
        sha256, contentType: 'application/octet-stream',
      });
      const response = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'false' },
        body: bytes,
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      if (!response.ok) throw new Error(`Artifact object upload failed for ${relative}: ${response.status}`);
      await api(`/api/workers/jobs/${encodeURIComponent(job.id)}/artifacts/finalize`, {
        leaseToken: job.leaseToken, sessionId: session.sessionId,
      });
      uploaded += 1;
      total += bytes.length;
      console.log(`[artifact] Uploaded ${relative} (${bytes.length} bytes)`);
    }
  }

  for (const root of roots) {
    const absolute = path.join(workingDirectory, root);
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(absolute, root);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function makeWorkspaceWritable(directory) {
  // The agent runs with Docker-daemon privileges; job containers run as UID 1000.
  // Give that UID ownership of the checked-out workspace before bind-mounting it.
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeWorkspaceWritable(target);
    await fs.lchown(target, 1000, 1000);
  }
  await fs.lchown(directory, 1000, 1000);
}

async function execute(job) {
  const abortController = new AbortController();
  activeJobs.set(job.id, { abortController });
  const workspace = path.join(ROOT, String(job.runId), String(job.id));
  try {
    await fs.mkdir(workspace, { recursive: true });
  } catch (error) {
    activeJobs.delete(job.id);
    throw error;
  }

  const logBuffer = [];
  let logFlushActive = false;
  let logBytes = 0;
  let logTruncated = false;

  const secretValues = Object.values(job.secrets || {}).filter(Boolean);
  if (job.sourceToken) secretValues.push(job.sourceToken);
  const gitAuthEnv = job.sourceToken ? {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + job.sourceToken).toString('base64'),
  } : {};

  const flushLogs = async () => {
    if (logFlushActive || !logBuffer.length) return;
    logFlushActive = true;
    const batch = logBuffer.splice(0, 50);
    try {
      await api(`/api/workers/jobs/${job.id}/logs`, {
        leaseToken: job.leaseToken,
        entries: batch,
      });
    } catch (e) {
      logBuffer.unshift(...batch);
      // If 409 conflict, lease expired or job was canceled
      if (e.message.includes('409') || e.message.includes('expired')) {
        abortController.abort();
      }
    } finally {
      logFlushActive = false;
    }
  };

  const logTimer = setInterval(() => {
    flushLogs().catch(() => {});
  }, 500);

  const leaseHeartbeat = setInterval(async () => {
    try {
      await api(`/api/workers/jobs/${job.id}/lease`, {
        leaseToken: job.leaseToken,
      });
    } catch (e) {
      if (e.message.includes('409') || e.message.includes('expired')) {
        abortController.abort();
      }
    }
  }, 10000);

  try {
    if (job.sourceType === 'upload' && EXECUTOR !== 'mock') {
      await downloadUploadedSource(job, workspace, abortController.signal);
    } else {
      const repository = /^https:\/\//.test(job.repositoryUrl || '') ? job.repositoryUrl : REPO_URL || '';
      if (repository && EXECUTOR !== 'mock') {
      const clone = await runGit(
        ['clone', '--depth', '1', '--branch', String(job.branch || 'main'), '--', repository, '.'],
        workspace,
        (s, m) => console.log(`[clone:${s}] ${redactSecrets(m, secretValues)}`),
        gitAuthEnv,
        abortController.signal
      );
        if (clone.exitCode !== 0) throw new Error('Repository clone failed; check repository URL and accessibility');
      }
    }

    if (job.commitSha && EXECUTOR !== 'mock' && job.sourceType !== 'upload') {
      if (!/^[a-f0-9]{7,64}$/i.test(job.commitSha)) throw new Error('Invalid commit SHA format');
      const checkout = await runGit(['checkout', '--detach', job.commitSha], workspace, (s, m) => console.log(`[checkout:${s}] ${redactSecrets(m, secretValues)}`), gitAuthEnv, abortController.signal);
      if (checkout.exitCode !== 0) throw new Error('Requested commit could not be checked out');
    }

    if (EXECUTOR === 'docker') await makeWorkspaceWritable(workspace);
    const workingDirectory = await resolveJobWorkingDirectory(workspace, job.workingDirectory || '.');

    const result = await runCommand(
      job.command,
      workingDirectory,
      (stream, message) => {
        console.log(`[${job.name}:${stream}] ${message}`);
        if (logBytes < 10 * 1024 * 1024) {
          logBuffer.push({ stream, message });
          logBytes += Buffer.byteLength(message);
        } else if (!logTruncated) {
          logTruncated = true;
          logBuffer.push({ stream: 'stderr', message: '[Kestrel] Log output truncated after 10 MiB limit.' });
        }
        if (logBuffer.length >= 50) flushLogs().catch(() => {});
      },
      job,
      secretValues,
      abortController
    );

    // Collect any generated artifacts
    if (result.exitCode === 0) {
      await collectArtifacts(job, workspace, workingDirectory, abortController.signal);
    }

    while ((logBuffer.length || logFlushActive) && !abortController.signal.aborted) {
      await flushLogs();
      if ((logBuffer.length || logFlushActive) && !abortController.signal.aborted) await new Promise((r) => setTimeout(r, 50));
    }

    if (abortController.signal.aborted) {
      await api(`/api/workers/jobs/${job.id}/release`, { leaseToken: job.leaseToken }).catch(() => {});
      return;
    }
    await api(`/api/workers/jobs/${job.id}/complete`, {
      leaseToken: job.leaseToken,
      ...result,
    });
  } catch (error) {
    if (abortController.signal.aborted) {
      await api(`/api/workers/jobs/${job.id}/release`, { leaseToken: job.leaseToken }).catch(() => {});
      console.log(`[worker] Released job ${job.id} after execution was aborted`);
      return;
    }
    throw error;
  } finally {
    clearInterval(logTimer);
    clearInterval(leaseHeartbeat);
    await fs.rm(workspace, { recursive: true, force: true }).catch((e) => console.error('workspace cleanup:', e.message));
    activeJobs.delete(job.id);
  }
}

async function executeManagedImageBuild(build) {
  managedImageBuildActive = true;
  managedImageBuildAbortController = new AbortController();
  const startedAt = Date.now();
  let workspace;
  try {
    await fs.mkdir(ROOT, { recursive: true });
    workspace = await fs.mkdtemp(path.join(ROOT, 'managed-oci-'));
  } catch (error) {
    managedImageBuildActive = false;
    managedImageBuildAbortController = null;
    throw error;
  }
  const secretValues = [build.registryUsername, build.registryPassword, build.sourceToken].filter(Boolean);
  let leaseLost = false;
  const heartbeat = setInterval(async () => {
    try {
      await api('/api/workers/managed-image-builds/' + encodeURIComponent(build.id) + '/lease', { leaseToken: build.leaseToken });
    } catch (error) {
      if (error.message.includes('409') || error.message.includes('expired')) leaseLost = true;
    }
  }, 10000);
  try {
    const repository = new URL(build.repositoryUrl);
    if (repository.protocol !== 'https:' || repository.hostname !== 'github.com' || repository.username || repository.password) {
      throw new Error('Managed OCI builds require an HTTPS GitHub repository');
    }
    const gitAuthEnv = build.sourceToken ? {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + build.sourceToken).toString('base64'),
    } : {};
    const clone = await runGit(['clone', '--no-checkout', '--filter=blob:none', '--', build.repositoryUrl, workspace], workspace,
      (_stream, message) => console.log('[oci:clone] ' + redactSecrets(message, secretValues)), gitAuthEnv, managedImageBuildAbortController.signal);
    if (clone.exitCode !== 0) throw new Error('Could not clone source repository for OCI build; verify the connected GitHub App has repository access');
    const fetch = await runGit(['fetch', '--depth=1', 'origin', build.commitSha], workspace,
      (_stream, message) => console.log('[oci:fetch] ' + redactSecrets(message, secretValues)), gitAuthEnv, managedImageBuildAbortController.signal);
    if (fetch.exitCode !== 0) throw new Error('Could not fetch the exact pipeline commit for OCI build');
    const checkout = await runGit(['checkout', '--detach', build.commitSha], workspace,
      (_stream, message) => console.log('[oci:checkout] ' + redactSecrets(message, secretValues)), {}, managedImageBuildAbortController.signal);
    if (checkout.exitCode !== 0) throw new Error('Could not check out the exact pipeline commit for OCI build');
    const tree = await runGit(['ls-tree', '-r', '--name-only', build.commitSha], workspace, () => {}, {}, managedImageBuildAbortController.signal);
    if (tree.exitCode !== 0) throw new Error('Could not inspect tracked files at the exact pipeline commit');
    const buildContext = await resolveOciBuildContext(workspace, tree.stdout.split(/\r?\n/).filter(Boolean), build.buildContext);
    console.log('[oci] Using build context ' + buildContext.relativeContext + ' and Dockerfile ' + buildContext.dockerfile);
    if (leaseLost) throw new Error('Managed OCI build lease was lost before the build started');
    const result = await buildAndPublishOciImage({
      contextDir: buildContext.contextDir,
      dockerfile: buildContext.dockerfile,
      image: build.image,
      commitSha: build.commitSha,
      registry: build.registry,
      registryUsername: build.registryUsername,
      registryPassword: build.registryPassword,
    }, { dockerBin: DOCKER, timeoutMs: 30 * 60 * 1000, abortSignal: managedImageBuildAbortController.signal });
    if (leaseLost) throw new Error('Managed OCI build lease was lost before publishing could be confirmed');
    await api('/api/workers/managed-image-builds/' + encodeURIComponent(build.id) + '/complete', {
      leaseToken: build.leaseToken, status: 'succeeded',
      imageDigest: result.digest, imageDigestRef: result.imageDigestRef,
    });
    console.log('[oci] Published ' + result.imageDigestRef + ' for commit ' + build.commitSha);
  } catch (error) {
    if (managedImageBuildAbortController?.signal.aborted) {
      await api('/api/workers/managed-image-builds/' + encodeURIComponent(build.id) + '/release', { leaseToken: build.leaseToken }).catch(() => {});
      console.log('[oci] Released managed image build after worker drain');
    } else {
      const safeError = redactSecrets(String(error?.message || 'OCI image build failed'), secretValues).slice(0, 500);
      console.error('[oci] Managed image build failed:', safeError);
      await api('/api/workers/managed-image-builds/' + encodeURIComponent(build.id) + '/complete', {
        leaseToken: build.leaseToken, status: 'failed', error: safeError,
      }).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
    managedImageBuildActive = false;
    managedImageBuildAbortController = null;
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    console.log('[oci] Worker build duration: ' + (Date.now() - startedAt) + 'ms');
  }
}

async function managedImageBuildLoop() {
  while (!isDraining) {
    try {
      const { build } = await api('/api/workers/managed-image-builds/claim', { workerId: WORKER_ID });
      if (!build) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      if (isDraining) {
        await api('/api/workers/managed-image-builds/' + encodeURIComponent(build.id) + '/release', { leaseToken: build.leaseToken }).catch(() => {});
        break;
      }
      console.log('[oci] Claimed managed image build ' + build.id + ' for ' + build.commitSha);
      await executeManagedImageBuild(build);
    } catch (error) {
      console.error('[oci] Managed image build poll failed:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// Startup verification
if (!TOKEN || TOKEN.length < 32) {
  throw new Error('KESTREL_WORKER_TOKEN must be at least 32 characters');
}

await ensureJobImage();
await api('/api/workers/register', {
  workerId: WORKER_ID,
  hostname: os.hostname(),
  arch: `linux/${os.arch() === 'arm64' ? 'arm64' : 'amd64'}`,
  region: process.env.KESTREL_REGION || 'local',
  maxConcurrency: CONCURRENCY,
});

console.log(`Kestrel worker ${WORKER_ID} connected to control plane: ${API} (${EXECUTOR} executor, concurrency: ${CONCURRENCY})`);

// Heartbeat loop
const heartbeatInterval = setInterval(() => {
  api('/api/workers/heartbeat', {
    workerId: WORKER_ID,
    draining: isDraining,
  }).catch((e) => console.error('heartbeat error:', e.message));
}, 10000);

// Graceful shutdown stops claims, lets current work finish, then uses a bounded
// cancellation window so the control plane can recover leases after a forced exit.
const drainTimeoutMs = Math.max(5000, Math.min(600000, Number(process.env.KESTREL_WORKER_DRAIN_TIMEOUT_MS || 60000)));
const drainController = createDrainController({
  activeJobs,
  isManagedImageBuildActive: () => managedImageBuildActive,
  abortManagedImageBuild: () => managedImageBuildAbortController?.abort(),
  timeoutMs: drainTimeoutMs,
  stopContainer: (name) => spawn(DOCKER, ['stop', '--time', '2', name], { stdio: 'ignore' }),
  killChild: (child) => child.kill('SIGTERM'),
  forceExit: () => process.exit(1),
  logger: console,
});

function handleShutdown(signal) {
  if (isDraining) return;
  console.log(`Received ${signal}, draining worker...`);
  isDraining = true;
  api('/api/workers/heartbeat', { workerId: WORKER_ID, draining: true }).catch(() => {});
  drainController.begin(signal);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Managed OCI builds share the registered worker pool and have a separate durable lease queue.
const managedImageBuildTask = EXECUTOR === 'docker' ? managedImageBuildLoop() : Promise.resolve();
async function pollLoop(slot) {
  while (!isDraining) {
    try {
      const { job } = await api('/api/workers/claim', { workerId: WORKER_ID });
      if (!job) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      if (isDraining) {
        await api(`/api/workers/jobs/${job.id}/release`, { leaseToken: job.leaseToken }).catch(() => {});
        break;
      }

      console.log(`[Slot ${slot}] Claimed job "${job.name}" (${job.id}) for run ${job.runId}`);
      try {
        await execute(job);
      } catch (e) {
        console.error(`[Slot ${slot}] Job execution failed:`, e.message);
        await api(`/api/workers/jobs/${job.id}/complete`, {
          leaseToken: job.leaseToken,
          exitCode: 1,
          durationMs: 0,
        }).catch(() => {});
      }
    } catch (e) {
      console.error(`[Slot ${slot}] Poll loop error:`, e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => pollLoop(i + 1)));
await managedImageBuildTask;
drainController.complete();
clearInterval(heartbeatInterval);
await api('/api/workers/heartbeat', { workerId: WORKER_ID, draining: true }).catch(() => {});
