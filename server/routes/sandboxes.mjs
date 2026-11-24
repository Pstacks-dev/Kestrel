import crypto from 'node:crypto';
import { createVercelSandboxClient, SandboxProviderError, makeSandboxName } from '../lib/vercel-sandbox.mjs';

const MEMBER_ROLES = ['owner', 'admin', 'developer'];
const READ_ROLES = ['owner', 'admin', 'developer', 'viewer'];
const DEFAULT_QUOTA = { maxSandboxes: 2, maxVcpu: 4, maxRuntimeSeconds: 2700 };
const REGIONS = new Set(['iad1','sfo1','cle1','cdg1','fra1','arn1','sin1','pdx1','lhr1','icn1','bom1','cpt1','dub1','gru1','hkg1','syd1','yul1','hnd1','kix1']);
const fail = (res, status, error) => res.status(status).json({ error });
const cleanName = (name) => typeof name === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
const sandboxId = (value) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(value));

async function membership(query, organizationId, userId) {
  const result = await query(
    'select role from public.organization_members where organization_id = $1 and user_id = $2',
    [organizationId, userId],
  );
  return result.rowCount ? result.rows[0].role : null;
}

function providerClientFactory() {
  return createVercelSandboxClient();
}

export function registerSandboxRoutes(app, { userAuth, platformAdmin, query, transaction, provider = providerClientFactory() }) {
  app.get('/api/workspaces/:organizationId/sandboxes', userAuth, async (req, res) => {
    const role = await membership(query, req.params.organizationId, req.user.id);
    if (!READ_ROLES.includes(role)) return fail(res, 403, 'Workspace access denied');
    try {
      const [instances, quotas] = await Promise.all([
        query(
          `select id, name, provider, region, vcpus, memory_mib as "memoryMiB",
                  timeout_seconds as "timeoutSeconds", persistent, status,
                  error_message as "errorMessage", last_activity_at as "lastActivityAt",
                  created_at as "createdAt", updated_at as "updatedAt"
           from public.sandbox_instances
           where organization_id = $1 and deleted_at is null
           order by created_at desc`,
          [req.params.organizationId],
        ),
        query(
          `select coalesce(q.max_sandboxes,2) as "maxSandboxes",
                  coalesce(q.max_vcpu,4) as "maxVcpu",
                  coalesce(q.max_runtime_seconds,2700) as "maxRuntimeSeconds",
                  count(s.id) filter (where s.status not in ('deleted','failed'))::int as "usedSandboxes",
                  coalesce(sum(s.vcpus) filter (where s.status not in ('deleted','failed')),0)::int as "usedVcpu"
           from public.organizations o
           left join public.sandbox_quotas q on q.organization_id = o.id
           left join public.sandbox_instances s on s.organization_id = o.id and s.deleted_at is null
           where o.id = $1
           group by o.id,q.organization_id,q.max_sandboxes,q.max_vcpu,q.max_runtime_seconds`,
          [req.params.organizationId],
        ),
      ]);
      res.json({ sandboxes: instances.rows, quota: quotas.rows[0] || { ...DEFAULT_QUOTA, usedSandboxes: 0, usedVcpu: 0 } });
    } catch (error) {
      fail(res, 500, 'Could not load sandbox workspaces');
    }
  });

  app.post('/api/workspaces/:organizationId/sandboxes', userAuth, async (req, res) => {
    const organizationId = req.params.organizationId;
    const role = await membership(query, organizationId, req.user.id);
    if (!MEMBER_ROLES.includes(role)) return fail(res, 403, 'Developer access required');
    const name = String(req.body?.name || '').trim().toLowerCase();
    const vcpus = Number(req.body?.vcpus || 1);
    const timeoutSeconds = Number(req.body?.timeoutSeconds || 900);
    const region = String(req.body?.region || process.env.KESTREL_SANDBOX_REGION || 'iad1');
    if (!cleanName(name) || !Number.isInteger(vcpus) || vcpus < 1 || vcpus > 4 ||
        !Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 2700 || !REGIONS.has(region)) {
      return fail(res, 400, 'Invalid sandbox name, resource size, runtime limit, or region');
    }
    let reservation;
    try {
      reservation = await transaction(async (c) => {
        await c.query('select id from public.organizations where id = $1 for update', [organizationId]);
        const quotaResult = await c.query(
          'select max_sandboxes, max_vcpu, max_runtime_seconds from public.sandbox_quotas where organization_id = $1',
          [organizationId],
        );
        const quota = quotaResult.rowCount ? quotaResult.rows[0] : DEFAULT_QUOTA;
        await c.query('select pg_advisory_xact_lock(71420931)');
        const globalLimit = Math.max(1, Math.min(10000, Number(process.env.KESTREL_SANDBOX_GLOBAL_MAX || 10)));
        const globalUsed = await c.query(
          `select count(*)::int as active from public.sandbox_instances
           where deleted_at is null and status in ('provisioning','running','unknown')`,
        );
        if (globalUsed.rows[0].active >= globalLimit) {
          return { error: 'The platform sandbox pool is currently at capacity. Try again later.', status: 429 };
        }
        const used = await c.query(
          `select count(*)::int as instances, coalesce(sum(vcpus),0)::int as vcpu
           from public.sandbox_instances where organization_id = $1 and deleted_at is null and status not in ('deleted','failed')`,
          [organizationId],
        );
        if (used.rows[0].instances >= quota.max_sandboxes || used.rows[0].vcpu + vcpus > quota.max_vcpu) {
          return { error: 'Sandbox workspace quota exceeded', status: 403 };
        }
        if (timeoutSeconds > quota.max_runtime_seconds) {
          return { error: `Maximum sandbox session duration is ${quota.max_runtime_seconds} seconds for this workspace`, status: 403 };
        }
        const id = crypto.randomUUID();
        const providerName = makeSandboxName(id);
        const inserted = await c.query(
          `insert into public.sandbox_instances
           (id, organization_id, created_by, provider_name, name, region, vcpus, memory_mib, timeout_seconds, status)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,'provisioning')
           returning id, name, provider_name, region, vcpus, memory_mib, timeout_seconds`,
          [id, organizationId, req.user.id, providerName, name, region, vcpus, vcpus * 2048, timeoutSeconds],
        );
        return inserted.rows[0];
      });
      if (reservation.error) return fail(res, reservation.status, reservation.error);
    } catch (error) {
      return fail(res, error.code === '23505' ? 409 : 500, error.code === '23505' ? 'Sandbox name already exists in this workspace' : 'Could not reserve sandbox quota');
    }

    try {
      const created = await provider.create({
        name: reservation.provider_name,
        vcpus,
        timeoutMs: timeoutSeconds * 1000,
        region,
        tags: { managedBy: 'kestrel', workspace: organizationId.slice(0, 32) },
      });
      const sandbox = created?.sandbox;
      const session = created?.session;
      if (!sandbox?.name || !sandbox?.currentSessionId || !session?.id) {
        throw new SandboxProviderError('Provider did not return a valid sandbox session');
      }
      const updated = await query(
        `update public.sandbox_instances set provider_name = $2, provider_session_id = $3,
           status = $4, error_message = null, last_activity_at = now(), updated_at = now()
         where id = $1 returning id, name, provider, region, vcpus, memory_mib as "memoryMiB",
           timeout_seconds as "timeoutSeconds", persistent, status, created_at as "createdAt"`,
        [reservation.id, sandbox.name, session.id, sandbox.status === 'running' ? 'running' : 'unknown'],
      );
      await query(
        `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
         values($1,$2,'sandbox.created','sandbox',$3,$4)`,
        [organizationId, req.user.id, reservation.id, JSON.stringify({ provider: 'vercel', region, vcpus })],
      );
      res.status(201).json({ sandbox: updated.rows[0] });
    } catch (error) {
      await query(
        "update public.sandbox_instances set status = 'failed', error_message = $2, updated_at = now() where id = $1",
        [reservation.id, String(error.message || 'Provider provisioning failed').slice(0, 500)],
      ).catch(() => {});
      const status = error instanceof SandboxProviderError ? error.status : 502;
      fail(res, status, error.message || 'Sandbox provisioning failed');
    }
  });

  // Cloud builds run inside Vercel-managed microVMs; no customer or Kestrel-owned worker is required.
  app.post('/api/sandboxes/:sandboxId/builds', userAuth, async (req, res) => {
    const result = await query(
      `select s.* from public.sandbox_instances s
       join public.organization_members m on m.organization_id = s.organization_id
       where s.id = $1 and m.user_id = $2 and m.role = any($3) and s.deleted_at is null`,
      [req.params.sandboxId, req.user.id, MEMBER_ROLES],
    );
    if (!result.rowCount) return fail(res, 404, 'Sandbox not found or access denied');
    const record = result.rows[0];
    if (record.status !== 'running' && record.status !== 'unknown') return fail(res, 409, 'Sandbox must be running before starting a cloud build');

    const repositoryUrl = String(req.body?.repositoryUrl || '').trim();
    const branch = String(req.body?.branch || 'main').trim();
    let parsedUrl;
    try { parsedUrl = new URL(repositoryUrl); } catch { return fail(res, 400, 'A valid public Git repository URL is required'); }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password ||
        !['github.com', 'gitlab.com', 'bitbucket.org'].includes(parsedUrl.hostname.toLowerCase()) ||
        parsedUrl.search || parsedUrl.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(parsedUrl.pathname)) {
      return fail(res, 400, 'Repository must be a public GitHub, GitLab, or Bitbucket HTTPS URL');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.includes('//')) {
      return fail(res, 400, 'Invalid Git branch name');
    }

    const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
    const projectDirectory = '/vercel/sandbox/kestrel-project';
    const script = [
      'set -eu',
      'rm -rf ' + quote(projectDirectory),
      'git clone --depth 1 --single-branch --branch ' + quote(branch) + ' -- ' + quote(repositoryUrl) + ' ' + quote(projectDirectory),
      'cd ' + quote(projectDirectory),
      'if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile; else npm install --no-audit --no-fund; fi',
      'npm run build',
    ].join(' && ');

    try {
      const current = await provider.get(record.provider_name, true);
      const sessionId = current?.session?.id || current?.sandbox?.currentSessionId || record.provider_session_id;
      if (!sessionId) return fail(res, 409, 'Sandbox session is unavailable; restart the sandbox and try again');
      const command = await provider.startCommand(sessionId, {
        command: 'bash',
        args: ['-lc', script],
        cwd: '/vercel/sandbox',
        timeoutMs: Math.min(Number(record.timeout_seconds || 2700), 2700) * 1000,
      });
      await query(
        'update public.sandbox_instances set provider_session_id=$2,last_activity_at=now(),updated_at=now() where id=$1',
        [record.id, sessionId],
      );
      await query(
        `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
         values($1,$2,'sandbox.build.started','sandbox',$3,$4)`,
        [record.organization_id, req.user.id, record.id, JSON.stringify({ repositoryHost: parsedUrl.hostname, branch, commandId: command.id })],
      );
      res.status(202).json({
        build: {
          sandboxId: record.id,
          sessionId,
          commandId: command.id,
          status: 'running',
          repositoryUrl,
          branch,
          startedAt: command.startedAt || null,
        },
      });
    } catch (error) {
      fail(res, error instanceof SandboxProviderError ? error.status : 502, error.message || 'Could not start cloud build');
    }
  });

  app.get('/api/sandboxes/:sandboxId/builds/:commandId', userAuth, async (req, res) => {
    const result = await query(
      `select s.* from public.sandbox_instances s
       join public.organization_members m on m.organization_id = s.organization_id
       where s.id = $1 and m.user_id = $2 and m.role = any($3) and s.deleted_at is null`,
      [req.params.sandboxId, req.user.id, MEMBER_ROLES],
    );
    if (!result.rowCount) return fail(res, 404, 'Sandbox not found or access denied');
    const record = result.rows[0];
    try {
      const sessionId = record.provider_session_id;
      if (!sessionId) return fail(res, 409, 'The original build session is no longer available');
      const command = await provider.getCommand(sessionId, req.params.commandId);
      const exitCode = command.exitCode === null || command.exitCode === undefined ? null : Number(command.exitCode);
      res.json({
        build: {
          sandboxId: record.id,
          commandId: command.id,
          status: exitCode === null ? 'running' : exitCode === 0 ? 'succeeded' : 'failed',
          exitCode,
          durationMs: command.durationMs ? Number(command.durationMs) : null,
          startedAt: command.startedAt || null,
          command: command.name,
        },
      });
    } catch (error) {
      fail(res, error instanceof SandboxProviderError ? error.status : 502, error.message || 'Could not retrieve cloud build status');
    }
  });

  app.get('/api/sandboxes/:sandboxId/builds/:commandId/logs', userAuth, async (req, res) => {
    const result = await query(
      `select s.* from public.sandbox_instances s
       join public.organization_members m on m.organization_id = s.organization_id
       where s.id = $1 and m.user_id = $2 and m.role = any($3) and s.deleted_at is null`,
      [req.params.sandboxId, req.user.id, MEMBER_ROLES],
    );
    if (!result.rowCount) return fail(res, 404, 'Sandbox not found or access denied');
    const sessionId = result.rows[0].provider_session_id;
    if (!sessionId) return fail(res, 409, 'The original build session is no longer available');
    try {
      const logs = await provider.getCommandLogs(sessionId, req.params.commandId);
      res.json({ logs });
    } catch (error) {
      fail(res, error instanceof SandboxProviderError ? error.status : 502, error.message || 'Could not retrieve cloud build logs');
    }
  });

  app.post('/api/sandboxes/:sandboxId/actions', userAuth, async (req, res) => {
    const action = String(req.body?.action || '');
    if (!['start', 'stop'].includes(action)) return fail(res, 400, 'Supported actions are start and stop');
    const result = await query(
      `select s.* from public.sandbox_instances s
       join public.organization_members m on m.organization_id = s.organization_id
       where s.id = $1 and m.user_id = $2 and m.role = any($3) and s.deleted_at is null`,
      [req.params.sandboxId, req.user.id, MEMBER_ROLES],
    );
    if (!result.rowCount) return fail(res, 404, 'Sandbox not found or access denied');
    const record = result.rows[0];
    try {
      if (action === 'stop') {
        if (record.status !== 'running' && record.status !== 'unknown') return fail(res, 409, 'Only a running sandbox can be stopped');
        await provider.stop(record.provider_session_id);
        await query("update public.sandbox_instances set status='stopped', updated_at=now(), last_activity_at=now() where id=$1", [record.id]);
      } else {
        if (record.status !== 'stopped') return fail(res, 409, 'Only stopped sandboxes can be started');
        const resumed = await provider.get(record.provider_name, true);
        const sessionId = resumed?.session?.id || resumed?.sandbox?.currentSessionId;
        await query("update public.sandbox_instances set status='running', provider_session_id=$2, updated_at=now(), last_activity_at=now() where id=$1", [record.id, sessionId]);
      }
      await query(
        `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id)
         values($1,$2,$3,'sandbox',$4)`,
        [record.organization_id, req.user.id, `sandbox.${action}`, record.id],
      );
      res.json({ ok: true, sandboxId: record.id, action, status: action === 'start' ? 'running' : 'stopped' });
    } catch (error) {
      fail(res, error instanceof SandboxProviderError ? error.status : 502, error.message || `Could not ${action} sandbox`);
    }
  });

  app.post('/api/sandboxes/:sandboxId/commands', userAuth, async (req, res) => {
    const result = await query(
      `select s.* from public.sandbox_instances s
       join public.organization_members m on m.organization_id = s.organization_id
       where s.id = $1 and m.user_id = $2 and m.role = any($3) and s.deleted_at is null`,
      [req.params.sandboxId, req.user.id, MEMBER_ROLES],
    );
    if (!result.rowCount) return fail(res, 404, 'Sandbox not found or access denied');
    const record = result.rows[0];
    const command = String(req.body?.command || '');
    const args = req.body?.args;
    const cwd = req.body?.cwd;
    const timeoutSeconds = Number(req.body?.timeoutSeconds || 30);
    if (!/^[a-zA-Z0-9_./-]{1,128}$/.test(command) || !Array.isArray(args) || args.length > 32 ||
        args.some((arg) => typeof arg !== 'string' || arg.length > 2048) ||
        (cwd !== undefined && (typeof cwd !== 'string' || cwd.length > 512 || !cwd.startsWith('/'))) ||
        !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) {
      return fail(res, 400, 'Invalid command, arguments, working directory, or timeout');
    }
    if (record.status !== 'running') return fail(res, 409, 'Sandbox must be running to execute commands');
    try {
      const current = await provider.get(record.provider_name, true);
      const sessionId = current?.session?.id || current?.sandbox?.currentSessionId || record.provider_session_id;
      const providerTimeoutSeconds = process.env.VERCEL ? Math.min(timeoutSeconds, 8) : timeoutSeconds;
      const execution = await provider.runCommand(sessionId, { command, args, cwd, timeoutMs: providerTimeoutSeconds * 1000 });
      await query("update public.sandbox_instances set provider_session_id=$2, last_activity_at=now(), updated_at=now() where id=$1", [record.id, sessionId]);
      await query(
        `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
         values($1,$2,'sandbox.command','sandbox',$3,$4)`,
        [record.organization_id, req.user.id, record.id, JSON.stringify({ command, exitCode: execution.exitCode, durationMs: execution.durationMs })],
      );
      res.json({ command, args, ...execution });
    } catch (error) {
      fail(res, error instanceof SandboxProviderError ? error.status : 502, error.message || 'Sandbox command failed');
    }
  });

  app.delete('/api/sandboxes/:sandboxId', userAuth, async (req, res) => {
    const result = await query(
      `select s.* from public.sandbox_instances s
       join public.organization_members m on m.organization_id = s.organization_id
       where s.id = $1 and m.user_id = $2 and m.role = any($3) and s.deleted_at is null`,
      [req.params.sandboxId, req.user.id, MEMBER_ROLES],
    );
    if (!result.rowCount) return fail(res, 404, 'Sandbox not found or access denied');
    const record = result.rows[0];
    try {
      await provider.delete(record.provider_name);
      await query("update public.sandbox_instances set status='deleted', deleted_at=now(), updated_at=now() where id=$1", [record.id]);
      await query(
        `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id)
         values($1,$2,'sandbox.deleted','sandbox',$3)`,
        [record.organization_id, req.user.id, record.id],
      );
      res.json({ ok: true, sandboxId: record.id, deleted: true });
    } catch (error) {
      fail(res, error instanceof SandboxProviderError ? error.status : 502, error.message || 'Could not delete sandbox');
    }
  });

  app.get('/api/admin/sandboxes/quotas/:organizationId', userAuth, platformAdmin, async (req, res) => {
    const result = await query(
      'select organization_id as "organizationId", max_sandboxes as "maxSandboxes", max_vcpu as "maxVcpu", max_runtime_seconds as "maxRuntimeSeconds" from public.sandbox_quotas where organization_id=$1',
      [req.params.organizationId],
    );
    res.json({ quota: result.rows[0] || { organizationId: req.params.organizationId, ...DEFAULT_QUOTA } });
  });

  app.put('/api/admin/sandboxes/quotas/:organizationId', userAuth, platformAdmin, async (req, res) => {
    const quota = {
      maxSandboxes: Number(req.body?.maxSandboxes),
      maxVcpu: Number(req.body?.maxVcpu),
      maxRuntimeSeconds: Number(req.body?.maxRuntimeSeconds),
    };
    if (!Number.isInteger(quota.maxSandboxes) || quota.maxSandboxes < 0 || quota.maxSandboxes > 100 ||
        !Number.isInteger(quota.maxVcpu) || quota.maxVcpu < 0 || quota.maxVcpu > 128 ||
        !Number.isInteger(quota.maxRuntimeSeconds) || quota.maxRuntimeSeconds < 60 || quota.maxRuntimeSeconds > 2700) {
      return fail(res, 400, 'Invalid sandbox quota values');
    }
    const result = await query(
      `insert into public.sandbox_quotas(organization_id,max_sandboxes,max_vcpu,max_runtime_seconds,updated_at)
       values($1,$2,$3,$4,now()) on conflict(organization_id) do update set
       max_sandboxes=excluded.max_sandboxes,max_vcpu=excluded.max_vcpu,
       max_runtime_seconds=excluded.max_runtime_seconds,updated_at=now()
       returning organization_id as "organizationId",max_sandboxes as "maxSandboxes",
       max_vcpu as "maxVcpu",max_runtime_seconds as "maxRuntimeSeconds"`,
      [req.params.organizationId, quota.maxSandboxes, quota.maxVcpu, quota.maxRuntimeSeconds],
    );
    res.json({ quota: result.rows[0] });
  });
}
