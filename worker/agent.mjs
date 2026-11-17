import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { redactSecrets } from '../server/lib/security.mjs';

const API = process.env.KESTREL_API_URL || '';
const TOKEN = process.env.KESTREL_WORKER_TOKEN || '';
const WORKER_ID = process.env.KESTREL_WORKER_ID || '';
const ROOT = path.resolve(process.env.KESTREL_WORKER_WORKDIR || process.env.KESTREL_WORKDIR || '.kestrel-worker');
const REPO_URL = process.env.KESTREL_REPOSITORY_URL;
const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.KESTREL_CONCURRENCY || 1)));
const DOCKER = process.env.KESTREL_DOCKER_BIN || 'docker';
const JOB_IMAGE = process.env.KESTREL_JOB_IMAGE || 'node:22-bookworm-slim';
const JOB_NETWORK = process.env.KESTREL_JOB_NETWORK || 'none';
const EXECUTOR = process.env.KESTREL_WORKER_EXECUTOR || 'docker'; // 'docker' | 'local' | 'mock'

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (!API) throw new Error('KESTREL_API_URL is required; refusing to default to localhost');
if (!TOKEN || TOKEN.length < 32) throw new Error('A provisioned KESTREL_WORKER_TOKEN of at least 32 characters is required');
if (!WORKER_ID || !/^[A-Za-z0-9_-]{3,128}$/.test(WORKER_ID)) throw new Error('A provisioned KESTREL_WORKER_ID is required');
if (IS_PRODUCTION && new URL(API).protocol !== 'https:') throw new Error('Production workers require an HTTPS KESTREL_API_URL');
if (IS_PRODUCTION && EXECUTOR !== 'docker') throw new Error('Production workers must use the isolated Docker executor');
if (IS_PRODUCTION && !/@sha256:[a-f0-9]{64}$/i.test(JOB_IMAGE) && EXECUTOR === 'docker') {
  throw new Error('Production workers require KESTREL_JOB_IMAGE pinned by immutable sha256 digest');
}

const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${TOKEN}`,
  'x-worker-id': WORKER_ID,
};

let isDraining = false;
const activeJobs = new Map(); // jobId -> { abortController, containerName }

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

async function runCommand(command, cwd, onLine, job, secretValues, abortSignal) {
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
        resolve({
          exitCode: timedOut ? 124 : abortSignal?.aborted ? 130 : code ?? 1,
          durationMs: Date.now() - start,
        });
      });

      child.on('error', (e) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', abortHandler);
        onLine('stderr', redactSecrets(e.message, secretValues));
        resolve({ exitCode: 1, durationMs: Date.now() - start });
      });
    });
  }

  // Default Docker container executor
  return new Promise((resolve) => {
    const containerName = `kestrel-job-${String(job.id).replace(/[^a-zA-Z0-9_.-]/g, '')}`;
    activeJobs.set(job.id, { containerName, abortSignal });

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
      `type=bind,src=${cwd},dst=/workspace`,
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

    args.push(JOB_IMAGE, command);

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
      activeJobs.delete(job.id);
      resolve({
        exitCode: timedOut ? 124 : abortSignal?.aborted ? 130 : code ?? 1,
        durationMs: Date.now() - start,
      });
    });

    child.on('error', (e) => {
      clearTimeout(timeout);
      abortSignal?.removeEventListener('abort', abortHandler);
      activeJobs.delete(job.id);
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

async function runGit(args, cwd, onLine) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('git', args, {
      cwd,
      shell: false,
      env: { ...process.env, CI: 'true', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => child.kill('SIGKILL'), Number(process.env.KESTREL_GIT_TIMEOUT_MS || 300000));

    for (const [stream, pipe] of [
      ['stdout', child.stdout],
      ['stderr', child.stderr],
    ]) {
      pipe.on('data', (buf) => {
        for (const line of buf.toString().split(/\r?\n/)) {
          if (line) onLine(stream, line);
        }
      });
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, durationMs: Date.now() - start });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      onLine('stderr', e.message);
      resolve({ exitCode: 1, durationMs: Date.now() - start });
    });
  });
}

// Check for build artifacts produced in workspace and upload metadata
async function collectArtifacts(job, workspace) {
  const candidateDirs = ['dist', 'build', 'artifacts'];
  const maxFiles = 50;
  const maxTotalBytes = 300 * 1024 * 1024;
  let uploadedFiles = 0;
  let totalBytes = 0;

  const contentTypeFor = (file) => {
    const ext = path.extname(file).toLowerCase();
    return ({
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.json': 'application/json',
      '.map': 'application/json',
      '.txt': 'text/plain',
      '.zip': 'application/zip',
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.wasm': 'application/wasm',
    })[ext] || 'application/octet-stream';
  };

  async function walk(directory, relative, depth = 0) {
    if (depth > 5 || uploadedFiles >= maxFiles || totalBytes >= maxTotalBytes) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (uploadedFiles >= maxFiles || totalBytes >= maxTotalBytes) break;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, name, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(absolute);
      if (stat.size <= 0 || stat.size > 100 * 1024 * 1024 || totalBytes + stat.size > maxTotalBytes) continue;

      const bytes = await fs.readFile(absolute);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      const registered = await api('/api/workers/jobs/' + job.id + '/artifacts', {
        leaseToken: job.leaseToken,
        name,
        sizeBytes: bytes.length,
        sha256: digest,
        contentType: contentTypeFor(entry.name),
      });
      if (!registered?.id) throw new Error('Artifact registration did not return an artifact ID for ' + name);

      const uploaded = await fetch(API + '/api/workers/jobs/' + job.id + '/artifacts/' + registered.id + '/content', {
        method: 'PUT',
        headers: {
          ...headers,
          'content-type': 'application/octet-stream',
          'x-lease-token': job.leaseToken,
          'x-artifact-sha256': digest,
        },
        body: bytes,
      });
      if (!uploaded.ok) {
        const message = await uploaded.text();
        throw new Error('Artifact upload failed for ' + name + ': ' + uploaded.status + ' ' + message);
      }
      uploadedFiles += 1;
      totalBytes += bytes.length;
    }
  }

  for (const dir of candidateDirs) {
    await walk(path.join(workspace, dir), dir);
    if (uploadedFiles >= maxFiles || totalBytes >= maxTotalBytes) break;
  }
}
async function execute(job) {
  const workspace = path.join(ROOT, String(job.runId), String(job.id));
  await fs.mkdir(workspace, { recursive: true });

  const logBuffer = [];
  let logFlushActive = false;
  let logBytes = 0;
  let logTruncated = false;
  const abortController = new AbortController();

  const secretValues = Object.values(job.secrets || {}).filter(Boolean);

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
      await api(`/api/workers/jobs/${job.id}/logs`, {
        leaseToken: job.leaseToken,
        entries: [],
      });
    } catch (e) {
      if (e.message.includes('409') || e.message.includes('expired')) {
        abortController.abort();
      }
    }
  }, 10000);

  try {
    const repository = /^https:\/\//.test(job.repositoryUrl || '') ? job.repositoryUrl : REPO_URL || '';
    if (repository && EXECUTOR !== 'mock') {
      const clone = await runGit(
        ['clone', '--depth', '1', '--branch', String(job.branch || 'main'), '--', repository, '.'],
        workspace,
        (s, m) => console.log(`[clone:${s}] ${m}`)
      );
      if (clone.exitCode !== 0) throw new Error('Repository clone failed; check repository URL and accessibility');
    }

    if (job.commitSha && EXECUTOR !== 'mock') {
      if (!/^[a-f0-9]{7,64}$/i.test(job.commitSha)) throw new Error('Invalid commit SHA format');
      const checkout = await runGit(['checkout', '--detach', job.commitSha], workspace, (s, m) => console.log(`[checkout:${s}] ${m}`));
      if (checkout.exitCode !== 0) throw new Error('Requested commit could not be checked out');
    }

    const result = await runCommand(
      job.command,
      workspace,
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
      abortController.signal
    );

    // Collect any generated artifacts
    if (result.exitCode === 0) {
      await collectArtifacts(job, workspace);
    }

    while (logBuffer.length || logFlushActive) {
      await flushLogs();
      if (logBuffer.length || logFlushActive) await new Promise((r) => setTimeout(r, 50));
    }

    await api(`/api/workers/jobs/${job.id}/complete`, {
      leaseToken: job.leaseToken,
      status: abortController.signal.aborted ? 'canceled' : undefined,
      ...result,
    });
  } finally {
    clearInterval(logTimer);
    clearInterval(leaseHeartbeat);
    await fs.rm(workspace, { recursive: true, force: true }).catch((e) => console.error('workspace cleanup:', e.message));
  }
}

// Startup verification
if (!TOKEN || TOKEN.length < 16) {
  throw new Error('Valid KESTREL_WORKER_TOKEN is required');
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

// Graceful shutdown handling
function handleShutdown(signal) {
  console.log(`Received ${signal}, draining worker...`);
  isDraining = true;
  api('/api/workers/heartbeat', { workerId: WORKER_ID, draining: true }).catch(() => {});

  if (activeJobs.size === 0) {
    clearInterval(heartbeatInterval);
    process.exit(0);
  }

  const drainTimer = setTimeout(() => {
    console.log('Drain timeout exceeded; aborting remaining containers.');
    for (const [jobId, { abortSignal, containerName }] of activeJobs.entries()) {
      abortSignal?.abort();
      if (EXECUTOR === 'docker') {
        spawn(DOCKER, ['stop', '--time', '2', containerName], { stdio: 'ignore' });
      }
    }
    process.exit(0);
  }, 15000);
  drainTimer.unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Polling loop for job claims
async function pollLoop(slot) {
  while (!isDraining) {
    try {
      const { job } = await api('/api/workers/claim', { workerId: WORKER_ID });
      if (!job) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
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
