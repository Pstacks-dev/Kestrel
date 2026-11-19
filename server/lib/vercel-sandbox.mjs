import { randomUUID } from 'node:crypto';

const API_BASE = (process.env.KESTREL_SANDBOX_API_URL || 'https://api.vercel.com').replace(/\/$/, '');
const SANDBOX_IMAGE = process.env.KESTREL_SANDBOX_IMAGE || 'vercel/sandbox/universal';
const DEFAULT_REGION = process.env.KESTREL_SANDBOX_REGION || 'iad1';

export class SandboxProviderError extends Error {
  constructor(message, status = 502, code = 'sandbox_provider_error') {
    super(message);
    this.name = 'SandboxProviderError';
    this.status = status;
    this.code = code;
  }
}

export function sandboxCredentials(env = process.env) {
  const token = env.VERCEL_TOKEN || env.VERCEL_OIDC_TOKEN;
  const projectId = env.VERCEL_PROJECT_ID;
  const teamId = env.VERCEL_TEAM_ID || env.VERCEL_ORG_ID;
  if (!token || !projectId || !teamId) {
    throw new SandboxProviderError(
      'Sandbox provider is not configured. Set VERCEL_TOKEN, VERCEL_PROJECT_ID and VERCEL_TEAM_ID (or VERCEL_ORG_ID).',
      503,
      'sandbox_not_configured'
    );
  }
  return { token, projectId, teamId };
}

export function createVercelSandboxClient({ env = process.env, fetchImpl = fetch } = {}) {
  const credentials = () => sandboxCredentials(env);
  async function request(path, { method = 'GET', body, signal } = {}) {
    const c = credentials();
    const url = new URL(path, API_BASE);
    url.searchParams.set('teamId', c.teamId);
    if (path.includes('/sandboxes/') && !url.searchParams.has('projectId')) {
      url.searchParams.set('projectId', c.projectId);
    }
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${c.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      let detail = '';
      try {
        const data = await response.json();
        detail = data?.error?.message || data?.message || data?.error || '';
      } catch {}
      const message = typeof detail === 'string' ? detail : '';
      throw new SandboxProviderError(message || `Sandbox provider returned HTTP ${response.status}`, response.status >= 500 ? 502 : response.status, 'sandbox_api_error');
    }
    return response;
  }

  return {
    async create({ name, vcpus, timeoutMs, region, tags }) {
      const c = credentials();
      const response = await request('/v3/sandboxes', {
        method: 'POST',
        body: {
          projectId: c.projectId,
          name,
          image: SANDBOX_IMAGE,
          resources: { vcpus },
          timeout: timeoutMs,
          persistent: true,
          region: region || DEFAULT_REGION,
          tags,
          ports: [],
        },
      });
      return response.json();
    },
    async get(name, resume = false) {
      const c = credentials();
      const response = await request(`/v2/sandboxes/${encodeURIComponent(name)}?projectId=${encodeURIComponent(c.projectId)}&resume=${resume ? 'true' : 'false'}`);
      return response.json();
    },
    async stop(sessionId) {
      const response = await request(`/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
      return response.json();
    },
    async delete(name) {
      const c = credentials();
      const response = await request(`/v2/sandboxes/${encodeURIComponent(name)}?projectId=${encodeURIComponent(c.projectId)}&deleteOrphanSnapshots=true`, { method: 'DELETE' });
      return response.json();
    },
    async runCommand(sessionId, { command, args, cwd, timeoutMs }) {
      const response = await request(`/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd`, {
        method: 'POST',
        body: { command, args, cwd, env: {}, sudo: false, wait: true, timeout: timeoutMs },
      });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/x-ndjson') || !response.body) {
        throw new SandboxProviderError('Sandbox command API returned an unexpected response format', 502, 'sandbox_bad_command_response');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let stdout = '';
      let stderr = '';
      let commandResult = null;
      const maxOutputBytes = 64 * 1024;
      const append = (target, value) => {
        if (target.length >= maxOutputBytes) return target;
        return target + value.slice(0, maxOutputBytes - target.length);
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          pending += decoder.decode(value || new Uint8Array(), { stream: !done });
          let newline;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            if (!line) continue;
            const item = JSON.parse(line);
            if (item.stream === 'stdout') stdout = append(stdout, item.data || '');
            else if (item.stream === 'stderr') stderr = append(stderr, item.data || '');
            else if (item.stream === 'error') throw new SandboxProviderError(item.data?.message || 'Command stream failed', 502, item.data?.code || 'sandbox_command_error');
            else if (item.command) commandResult = item.command;
          }
          if (done) break;
        }
        if (pending.trim()) {
          const item = JSON.parse(pending.trim());
          if (item.stream === 'stdout') stdout = append(stdout, item.data || '');
          else if (item.stream === 'stderr') stderr = append(stderr, item.data || '');
          else if (item.command) commandResult = item.command;
        }
      } finally {
        reader.releaseLock();
      }
      if (!commandResult || !Number.isInteger(commandResult.exitCode)) {
        throw new SandboxProviderError('Command stream ended without a completion record', 502, 'sandbox_command_incomplete');
      }
      return { exitCode: commandResult.exitCode, stdout, stderr, durationMs: commandResult.durationMs || null, commandId: commandResult.id };
    },
  };
}

export function makeSandboxName(id = randomUUID()) {
  return `kestrel-${id.replace(/-/g, '')}`;
}
