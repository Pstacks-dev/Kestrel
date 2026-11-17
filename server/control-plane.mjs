import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { pool, query, transaction } from './lib/db.mjs';
import { validatePipelineJobs } from './lib/pipeline.mjs';
import {
  encryptSecret,
  decryptSecret,
  verifyGitHubSignature,
  redactSecrets,
} from './lib/security.mjs';
import {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
} from './lib/auth.mjs';

const app = express();
const port = Number(process.env.PORT || 4000);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabaseAdmin = null;
if (supabaseUrl && supabaseServiceRoleKey) {
  supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

app.disable('x-powered-by');
// Vercel terminates TLS at its edge and forwards the client address. Trust exactly
// the platform proxy in serverless deployments; standalone hosts opt in explicitly.
app.set('trust proxy', process.env.VERCEL ? 1 : process.env.TRUST_PROXY === 'true' ? 1 : false);

// Use Express's resolved client IP; ipKeyGenerator preserves IPv6 subnet handling.
const rateLimitKey = (req) => ipKeyGenerator(req.ip || req.socket.remoteAddress || '127.0.0.1');

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", supabaseUrl].filter(Boolean),
      },
    },
  })
);

// Capture raw body for webhook HMAC signature verification
app.use(
  express.json({
    limit: '512kb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// General rate limiter
const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
});
app.use(generalLimiter);

// Stricter limiter for sensitive auth and admin actions
const sensitiveLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
});

// Password and account-creation endpoints need a much tighter per-IP ceiling.
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
});

const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// User Authentication Middleware (supports built-in JWT and Supabase Auth)
async function userAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.slice(7);

    // 1. Check built-in signed JWT first
    const builtInPayload = verifyJwt(token);
    if (builtInPayload) {
      req.user = {
        id: builtInPayload.sub,
        email: builtInPayload.email,
        app_metadata: builtInPayload.app_metadata || {},
        user_metadata: builtInPayload.user_metadata || {},
      };
      return next();
    }

    // 2. Check Supabase Auth if configured
    if (supabase) {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) {
        req.user = data.user;
        return next();
      }
    }

    return res.status(401).json({ error: 'Session expired or invalid' });
  } catch (e) {
    next(e);
  }
}

// Platform Administrator Authorization Middleware
function platformAdmin(req, res, next) {
  if (req.user?.app_metadata?.platform_role !== 'platform_admin') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

// Worker Authentication Middleware
async function workerAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const workerId = String(req.headers['x-worker-id'] || '');
    if (!token || !workerId) {
      return res.status(401).json({ error: 'Worker credentials required' });
    }
    const r = await query(
      `select wc.worker_id, w.organization_id, w.state
       from public.worker_credentials wc
       join public.workers w on w.id = wc.worker_id
       where wc.worker_id = $1 and wc.token_hash = $2 and wc.revoked_at is null`,
      [workerId, sha(token)]
    );
    if (!r.rowCount) {
      return res.status(401).json({ error: 'Worker authentication failed' });
    }
    req.worker = {
      id: r.rows[0].worker_id,
      organizationId: r.rows[0].organization_id,
      state: r.rows[0].state,
    };
    next();
  } catch (e) {
    next(e);
  }
}

// Organization Access Authorization Middleware
async function orgAccess(req, res, next) {
  try {
    const orgId = req.params.orgId || req.body?.organizationId || req.query.organizationId;
    if (!orgId) {
      return res.status(400).json({ error: 'organizationId required' });
    }
    const r = await query(
      'select role from public.organization_members where organization_id = $1 and user_id = $2',
      [orgId, req.user.id]
    );
    if (!r.rowCount) {
      return res.status(403).json({ error: 'Organization access denied' });
    }
    req.organizationId = orgId;
    req.orgRole = r.rows[0].role;
    next();
  } catch (e) {
    next(e);
  }
}

// Authentication uses Supabase Auth directly from the client. No Kestrel OTP endpoints are used.

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  try {
    // New Kestrel accounts use Supabase Auth for password hashing and signed sessions.
    if (supabase) {
      const signedIn = await supabase.auth.signInWithPassword({ email, password });
      if (!signedIn.error && signedIn.data?.session) {
        return res.json({
          user: signedIn.data.user,
          session: {
            access_token: signedIn.data.session.access_token,
            token_type: signedIn.data.session.token_type || 'bearer',
            expires_in: signedIn.data.session.expires_in,
            refresh_token: signedIn.data.session.refresh_token,
          },
        });
      }
    }

    // Backward compatibility for accounts created by the previous Kestrel PBKDF2 flow.
    const r = await query('select * from auth.users where lower(email) = lower($1)', [email]);
    if (!r.rowCount) return res.status(401).json({ error: 'Invalid email or password.' });
    const user = r.rows[0];
    const [salt, storedHash] = (user.encrypted_password || '').split(':');
    if (!salt || !storedHash || !verifyPassword(password, salt, storedHash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const appMeta = user.raw_app_meta_data || {};
    const userMeta = user.raw_user_meta_data || {};
    const token = signJwt({ sub: user.id, email: user.email, app_metadata: appMeta, user_metadata: userMeta });
    return res.json({
      user: { id: user.id, email: user.email, app_metadata: appMeta, user_metadata: userMeta },
      session: { access_token: token, token_type: 'bearer' },
    });
  } catch (e) {
    console.error('Login error:', e);
    return res.status(500).json({ error: 'Authentication failed.' });
  }
});

// ==========================================
// Health & System Info
// ==========================================
app.get('/api/health', async (_req, res) => {
  try {
    await query('select 1');
    res.json({
      ok: true,
      service: 'kestrel-control-plane',
      version: '1.0.0',
      database: 'connected',
      time: now(),
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      database: 'unavailable',
      error: 'Database connection failed',
    });
  }
});

// ==========================================
// Workspaces (Organizations)
// ==========================================
app.post('/api/workspaces', sensitiveLimiter, userAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (name.length < 2 || name.length > 120) {
    return res.status(400).json({ error: 'Workspace name must be 2–120 characters' });
  }
  const slug =
    (
      String(req.body.slug || name)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    ).slice(0, 50) +
    '-' +
    crypto.randomBytes(3).toString('hex');

  try {
    const result = await transaction(async (c) => {
      const o = await c.query(
        'insert into public.organizations(name, slug, created_by) values($1, $2, $3) returning *',
        [name, slug, req.user.id]
      );
      await c.query(
        'insert into public.organization_members(organization_id, user_id, role) values($1, $2, $3)',
        [o.rows[0].id, req.user.id, 'owner']
      );
      await c.query(
        'insert into public.profiles(id, full_name) values($1, $2) on conflict(id) do update set full_name = excluded.full_name',
        [req.user.id, req.user.user_metadata?.full_name || null]
      );
      await c.query(
        'insert into public.audit_events(organization_id, actor_id, action, target_type, target_id) values($1, $2, $3, $4, $5)',
        [o.rows[0].id, req.user.id, 'workspace.created', 'organization', o.rows[0].id]
      );
      return o.rows[0];
    });
    res.status(201).json(result);
  } catch (e) {
    res.status(500).json({ error: 'Could not create workspace' });
  }
});

app.get('/api/workspaces', userAuth, async (req, res) => {
  try {
    const r = await query(
      `select o.*, m.role
       from public.organizations o
       join public.organization_members m on m.organization_id = o.id
       where m.user_id = $1
       order by o.created_at`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch workspaces' });
  }
});

// Workspace Snapshot
app.get('/api/snapshot', userAuth, orgAccess, async (req, res) => {
  try {
    const [p, r, w, a] = await Promise.all([
      query(
        `select id, name, repository_url as repo, default_branch as "defaultBranch", created_at as "createdAt"
         from public.projects
         where organization_id = $1
         order by created_at desc`,
        [req.organizationId]
      ),
      query(
        `select r.id, r.project_id as "projectId", r.run_number as "runNumber", r.branch,
                r.commit_sha as "commitSha", r.commit_message as "commitMessage", r.status,
                r.triggered_at as "triggeredAt", r.finished_at as "finishedAt", r.canceled_at as "canceledAt",
                coalesce(
                  json_agg(
                    json_build_object(
                      'id', j.external_id,
                      'internalId', j.id,
                      'name', j.name,
                      'stage', j.stage,
                      'status', j.status,
                      'workerId', j.worker_id,
                      'exitCode', j.exit_code,
                      'durationMs', j.duration_ms,
                      'timeoutSeconds', j.timeout_seconds,
                      'attempt', j.attempt,
                      'startedAt', j.started_at,
                      'finishedAt', j.finished_at
                    ) order by j.created_at
                  ) filter (where j.id is not null),
                  '[]'
                ) jobs
         from public.pipeline_runs r
         join public.projects p on p.id = r.project_id
         left join public.jobs j on j.run_id = r.id
         where p.organization_id = $1
         group by r.id
         order by r.triggered_at desc
         limit 100`,
        [req.organizationId]
      ),
      query(
        `select id, hostname, architecture as arch, region, state,
                last_seen_at as "lastSeenAt", max_concurrency as "maxConcurrency"
         from public.workers
         where organization_id = $1
         order by created_at desc`,
        [req.organizationId]
      ),
      query(
        `select a.id, a.name, a.run_id as "runId", a.object_key as "objectKey",
                a.size_bytes as "sizeBytes", a.sha256, a.content_type as "contentType",
                a.created_at as "createdAt"
         from public.artifacts a
         join public.pipeline_runs r on r.id = a.run_id
         join public.projects p on p.id = r.project_id
         where p.organization_id = $1
         order by a.created_at desc
         limit 100`,
        [req.organizationId]
      ),
    ]);

    res.json({
      projects: p.rows,
      runs: r.rows,
      workers: w.rows,
      artifacts: a.rows,
      serverTime: now(),
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load workspace snapshot' });
  }
});

// ==========================================
// Projects
// ==========================================
app.post('/api/projects', sensitiveLimiter, userAuth, orgAccess, async (req, res) => {
  if (!['owner', 'admin', 'developer'].includes(req.orgRole)) {
    return res.status(403).json({ error: 'Developer access required' });
  }
  const { name, repo, defaultBranch = 'main' } = req.body || {};
  let repoUrl;
  try {
    repoUrl = new URL(repo);
  } catch {
    return res.status(400).json({ error: 'Invalid repository URL format' });
  }

  const allowedHosts = (
    process.env.KESTREL_GIT_ALLOWED_HOSTS || 'github.com,gitlab.com,bitbucket.org'
  )
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  if (
    !name ||
    typeof name !== 'string' ||
    name.trim().length < 2 ||
    !repoUrl ||
    repoUrl.protocol !== 'https:' ||
    repoUrl.username ||
    repoUrl.password ||
    !allowedHosts.includes(repoUrl.hostname.toLowerCase())
  ) {
    return res.status(400).json({
      error: `Use a valid name and credential-free HTTPS repository on an approved Git host: ${allowedHosts.join(', ')}`,
    });
  }

  try {
    const r = await transaction(async (c) => {
      const proj = await c.query(
        'insert into public.projects(organization_id, name, repository_url, default_branch, created_by) values($1, $2, $3, $4, $5) returning *',
        [req.organizationId, name.trim(), repo.trim(), defaultBranch.trim() || 'main', req.user.id]
      );
      // Generate default webhook secret
      const webhookSecret = crypto.randomBytes(24).toString('hex');
      await c.query(
        'insert into public.github_webhooks(project_id, webhook_secret) values($1, $2)',
        [proj.rows[0].id, webhookSecret]
      );
      await c.query(
        'insert into public.audit_events(organization_id, actor_id, action, target_type, target_id) values($1, $2, $3, $4, $5)',
        [req.organizationId, req.user.id, 'project.created', 'project', proj.rows[0].id]
      );
      return proj.rows[0];
    });
    res.status(201).json(r);
  } catch (e) {
    res.status(409).json({ error: 'Project could not be created; name may already exist in workspace' });
  }
});

// ==========================================
// Project Secrets Management
// ==========================================
app.get('/api/projects/:projectId/secrets', userAuth, async (req, res) => {
  const { projectId } = req.params;
  try {
    const authCheck = await query(
      `select m.role from public.projects p
       join public.organization_members m on m.organization_id = p.organization_id
       where p.id = $1 and m.user_id = $2`,
      [projectId, req.user.id]
    );
    if (!authCheck.rowCount) return res.status(403).json({ error: 'Project access denied' });

    const r = await query(
      'select id, name, created_at as "createdAt", updated_at as "updatedAt" from public.project_secrets where project_id = $1 order by name',
      [projectId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch secrets' });
  }
});

app.post('/api/projects/:projectId/secrets', sensitiveLimiter, userAuth, async (req, res) => {
  const { projectId } = req.params;
  const { name, value } = req.body || {};

  if (!name || !/^[A-Za-z0-9_]{1,128}$/.test(name)) {
    return res.status(400).json({ error: 'Secret name must be 1–128 alphanumeric characters or underscores' });
  }
  if (!value || typeof value !== 'string' || value.length > 32768) {
    return res.status(400).json({ error: 'Secret value must be between 1 and 32,768 characters' });
  }

  try {
    const authCheck = await query(
      `select m.role, p.organization_id from public.projects p
       join public.organization_members m on m.organization_id = p.organization_id
       where p.id = $1 and m.user_id = $2`,
      [projectId, req.user.id]
    );
    if (!authCheck.rowCount || !['owner', 'admin', 'developer'].includes(authCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Developer access required to manage secrets' });
    }

    const { encryptedValue, iv, authTag } = encryptSecret(value);
    await query(
      `insert into public.project_secrets(project_id, name, encrypted_value, iv, auth_tag, updated_at)
       values($1, $2, $3, $4, $5, now())
       on conflict (project_id, name)
       do update set encrypted_value = excluded.encrypted_value, iv = excluded.iv, auth_tag = excluded.auth_tag, updated_at = now()`,
      [projectId, name, encryptedValue, iv, authTag]
    );

    await query(
      'insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata) values($1, $2, $3, $4, $5, $6)',
      [authCheck.rows[0].organization_id, req.user.id, 'project.secret.updated', 'project', projectId, JSON.stringify({ secretName: name })]
    );

    res.status(200).json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: 'Could not save secret' });
  }
});

app.delete('/api/projects/:projectId/secrets/:name', sensitiveLimiter, userAuth, async (req, res) => {
  const { projectId, name } = req.params;
  try {
    const authCheck = await query(
      `select m.role, p.organization_id from public.projects p
       join public.organization_members m on m.organization_id = p.organization_id
       where p.id = $1 and m.user_id = $2`,
      [projectId, req.user.id]
    );
    if (!authCheck.rowCount || !['owner', 'admin', 'developer'].includes(authCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Developer access required' });
    }

    await query('delete from public.project_secrets where project_id = $1 and name = $2', [projectId, name]);
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete secret' });
  }
});

// ==========================================
// GitHub Webhook & Integration
// ==========================================
app.get('/api/projects/:projectId/webhook-config', userAuth, async (req, res) => {
  const { projectId } = req.params;
  try {
    const authCheck = await query(
      `select m.role from public.projects p
       join public.organization_members m on m.organization_id = p.organization_id
       where p.id = $1 and m.user_id = $2`,
      [projectId, req.user.id]
    );
    if (!authCheck.rowCount || !['owner', 'admin', 'developer'].includes(authCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Developer access required to view webhook signing credentials' });
    }

    let r = await query(
      'select id, webhook_secret as "webhookSecret", events, active, last_triggered_at as "lastTriggeredAt" from public.github_webhooks where project_id = $1',
      [projectId]
    );
    if (!r.rowCount) {
      const secret = crypto.randomBytes(24).toString('hex');
      const created = await query(
        'insert into public.github_webhooks(project_id, webhook_secret) values($1, $2) returning id, webhook_secret as "webhookSecret", events, active, last_triggered_at as "lastTriggeredAt"',
        [projectId, secret]
      );
      r = created;
    }
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Could not load webhook config' });
  }
});

// GitHub Webhook Receiver. Every event, including ping, must be authenticated.
app.post('/api/webhooks/github', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const event = String(req.headers['x-github-event'] || '');
  const deliveryId = String(req.headers['x-github-delivery'] || '');
  const body = req.body || {};
  const repoFullName = body?.repository?.full_name?.toLowerCase();
  const repoHtmlUrl = body?.repository?.html_url?.toLowerCase();
  const repoCloneUrl = body?.repository?.clone_url?.toLowerCase();

  if (!repoFullName && !repoHtmlUrl) {
    return res.status(400).json({ error: 'Missing repository information in webhook payload' });
  }

  try {
    const matched = await query(
      `select p.*, w.webhook_secret, w.active, w.events
       from public.projects p
       join public.github_webhooks w on w.project_id = p.id
       where lower(p.repository_url) in ($1, $2, $3, $4, $5)
       limit 2`,
      [
        repoHtmlUrl || '',
        repoCloneUrl || '',
        `https://github.com/${repoFullName}`,
        `https://github.com/${repoFullName}.git`,
        repoFullName || '',
      ]
    );

    if (matched.rowCount !== 1) {
      return res.status(matched.rowCount > 1 ? 409 : 404).json({
        error: matched.rowCount > 1 ? 'Repository URL matches multiple projects; make it unique' : 'No configured webhook found for this repository',
      });
    }

    const project = matched.rows[0];
    if (!project.active || !project.webhook_secret) {
      return res.status(403).json({ error: 'Webhook is disabled or has no signing secret' });
    }
    if (!req.rawBody || !verifyGitHubSignature(req.rawBody, signature, project.webhook_secret)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    if (event === 'ping') {
      return res.json({ ok: true, message: 'Authenticated webhook ping received.' });
    }
    if (event !== 'push' && event !== 'pull_request') {
      return res.status(200).json({ message: `Ignored authenticated event: ${event || 'unknown'}` });
    }
    if (!deliveryId || deliveryId.length > 128) {
      return res.status(400).json({ error: 'X-GitHub-Delivery header is required' });
    }
    if (event === 'pull_request' && !['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(body.action)) {
      return res.status(200).json({ message: `Ignored pull request action: ${body.action || 'unknown'}` });
    }
    if (event === 'push' && body.deleted) {
      return res.status(200).json({ message: 'Deleted branch push ignored' });
    }

    let branch = project.default_branch;
    let commitSha = null;
    let commitMessage = 'Triggered by GitHub Webhook';
    if (event === 'push') {
      branch = (body.ref || '').replace(/^refs\/heads\//, '') || project.default_branch;
      commitSha = body.after || body.head_commit?.id || null;
      commitMessage = body.head_commit?.message || `Push to ${branch}`;
    } else {
      branch = body.pull_request?.head?.ref || project.default_branch;
      commitSha = body.pull_request?.head?.sha || null;
      commitMessage = `PR #${body.pull_request?.number}: ${body.pull_request?.title || 'Pull request'}`;
    }
    if (!commitSha || !/^[a-f0-9]{40}$/i.test(commitSha)) {
      return res.status(400).json({ error: 'Webhook did not contain a valid 40-character commit SHA' });
    }

    const defaultJobs = [
      { id: 'install', name: 'Install dependencies', stage: 'build', command: 'npm ci' },
      { id: 'test', name: 'Run tests', stage: 'test', command: 'npm test', needs: ['install'] },
      { id: 'build', name: 'Build application', stage: 'package', command: 'npm run build', needs: ['test'] },
    ];
    const safe = validatePipelineJobs(defaultJobs);
    const run = await transaction(async (c) => {
      const delivery = await c.query(
        `insert into public.github_webhook_deliveries(project_id, delivery_id, event_name)
         values($1, $2, $3)
         on conflict (project_id, delivery_id) do nothing
         returning delivery_id`,
        [project.id, deliveryId, event]
      );
      if (!delivery.rowCount) return { duplicate: true };

      // Serialize run-number allocation per project. Locking an aggregate SELECT is invalid in PostgreSQL.
      await c.query('select id from public.projects where id = $1 for update', [project.id]);
      const n = await c.query(
        'select coalesce(max(run_number), 0) + 1 n from public.pipeline_runs where project_id = $1',
        [project.id]
      );
      const rr = await c.query(
        'insert into public.pipeline_runs(project_id, run_number, branch, commit_sha, commit_message) values($1, $2, $3, $4, $5) returning *',
        [project.id, n.rows[0].n, branch, commitSha, commitMessage.slice(0, 300)]
      );
      for (const j of safe) {
        await c.query(
          `insert into public.jobs(run_id, external_id, name, stage, command, needs, memory_limit_mb, cpu_millicores, timeout_seconds, max_retries)
           values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [rr.rows[0].id, j.id, j.name, j.stage, j.command, j.needs, j.memory, j.cpu, j.timeoutSeconds, j.maxRetries]
        );
      }
      await c.query(
        'update public.github_webhook_deliveries set run_id = $3, processed_at = now() where project_id = $1 and delivery_id = $2',
        [project.id, deliveryId, rr.rows[0].id]
      );
      await c.query('update public.github_webhooks set last_triggered_at = now() where project_id = $1', [project.id]);
      await c.query(
        'insert into public.audit_events(organization_id, action, target_type, target_id, metadata) values($1, $2, $3, $4, $5)',
        [project.organization_id, 'pipeline.run.webhook_triggered', 'pipeline_run', rr.rows[0].id, JSON.stringify({ event, branch, commitSha, deliveryId })]
      );
      return rr.rows[0];
    });

    if (run.duplicate) return res.status(202).json({ ok: true, duplicate: true });
    res.status(201).json({ ok: true, runId: run.id, runNumber: run.run_number });
  } catch (e) {
    console.error('GitHub webhook processing failed:', e);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ==========================================
// Pipeline Runs & Job Management
// ==========================================
app.post('/api/runs', sensitiveLimiter, userAuth, async (req, res) => {
  const { projectId, branch, commitSha, commitMessage, jobs } = req.body || {};
  if (!projectId || !Array.isArray(jobs)) {
    return res.status(400).json({ error: 'A project and job array are required' });
  }

  try {
    const run = await transaction(async (c) => {
      const pr = await c.query(
        `select p.*, m.role
         from public.projects p
         join public.organization_members m on m.organization_id = p.organization_id
         where p.id = $1 and m.user_id = $2
         for update of p`,
        [projectId, req.user.id]
      );
      if (!pr.rowCount || !['owner', 'admin', 'developer'].includes(pr.rows[0].role)) {
        throw Object.assign(new Error('Project access denied'), { status: 403 });
      }

      const safe = validatePipelineJobs(jobs);
      const n = await c.query('select coalesce(max(run_number), 0) + 1 n from public.pipeline_runs where project_id = $1', [projectId]);
      const rr = await c.query(
        'insert into public.pipeline_runs(project_id, run_number, branch, commit_sha, commit_message, triggered_by) values($1, $2, $3, $4, $5, $6) returning *',
        [projectId, n.rows[0].n, branch || pr.rows[0].default_branch, commitSha || null, (commitMessage || 'Manual pipeline run').slice(0, 300), req.user.id]
      );

      for (const j of safe) {
        await c.query(
          `insert into public.jobs(run_id, external_id, name, stage, command, needs, memory_limit_mb, cpu_millicores, timeout_seconds, max_retries)
           values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [rr.rows[0].id, j.id, j.name, j.stage, j.command, j.needs, j.memory, j.cpu, j.timeoutSeconds, j.maxRetries]
        );
      }

      await c.query(
        'insert into public.audit_events(organization_id, actor_id, action, target_type, target_id) values($1, $2, $3, $4, $5)',
        [pr.rows[0].organization_id, req.user.id, 'pipeline.run.created', 'pipeline_run', rr.rows[0].id]
      );
      return rr.rows[0];
    });

    res.status(201).json(run);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Pipeline could not be queued' });
  }
});

// Get individual run details
app.get('/api/runs/:runId', userAuth, async (req, res) => {
  const { runId } = req.params;
  try {
    const r = await query(
      `select r.*, p.name as "projectName", p.repository_url as "repoUrl"
       from public.pipeline_runs r
       join public.projects p on p.id = r.project_id
       join public.organization_members m on m.organization_id = p.organization_id
       where r.id = $1 and m.user_id = $2`,
      [runId, req.user.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Run not found or access denied' });

    const jobs = await query(
      'select * from public.jobs where run_id = $1 order by created_at',
      [runId]
    );
    const artifacts = await query(
      'select * from public.artifacts where run_id = $1 order by created_at desc',
      [runId]
    );

    res.json({
      run: r.rows[0],
      jobs: jobs.rows,
      artifacts: artifacts.rows,
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch run details' });
  }
});

// Cancel a pipeline run
app.post('/api/runs/:runId/cancel', sensitiveLimiter, userAuth, async (req, res) => {
  const { runId } = req.params;
  try {
    const authCheck = await query(
      `select r.id, p.organization_id, m.role
       from public.pipeline_runs r
       join public.projects p on p.id = r.project_id
       join public.organization_members m on m.organization_id = p.organization_id
       where r.id = $1 and m.user_id = $2`,
      [runId, req.user.id]
    );
    if (!authCheck.rowCount || !['owner', 'admin', 'developer'].includes(authCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Developer access required to cancel run' });
    }

    await transaction(async (c) => {
      // Mark queued and running jobs as canceled
      await c.query(
        "update public.jobs set status = 'canceled', finished_at = now(), canceled_at = now() where run_id = $1 and status in ('queued', 'running')",
        [runId]
      );
      // Mark run as canceled
      await c.query(
        "update public.pipeline_runs set status = 'canceled', finished_at = now(), canceled_at = now(), canceled_by = $2 where id = $1",
        [runId, req.user.id]
      );
      await c.query(
        'insert into public.audit_events(organization_id, actor_id, action, target_type, target_id) values($1, $2, $3, $4, $5)',
        [authCheck.rows[0].organization_id, req.user.id, 'pipeline.run.canceled', 'pipeline_run', runId]
      );
    });

    res.json({ ok: true, runId, status: 'canceled' });
  } catch (e) {
    res.status(500).json({ error: 'Could not cancel run' });
  }
});

// Retry a failed or canceled pipeline run
app.post('/api/runs/:runId/retry', sensitiveLimiter, userAuth, async (req, res) => {
  const { runId } = req.params;
  try {
    const authCheck = await query(
      `select r.*, p.organization_id, m.role
       from public.pipeline_runs r
       join public.projects p on p.id = r.project_id
       join public.organization_members m on m.organization_id = p.organization_id
       where r.id = $1 and m.user_id = $2`,
      [runId, req.user.id]
    );
    if (!authCheck.rowCount || !['owner', 'admin', 'developer'].includes(authCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Developer access required to retry run' });
    }

    const run = authCheck.rows[0];
    if (run.status === 'running') {
      return res.status(400).json({ error: 'Run is already in progress' });
    }

    await transaction(async (c) => {
      // Reset failed, canceled, or skipped jobs
      await c.query(
        `update public.jobs
         set status = 'queued',
             attempt = 0,
             exit_code = null,
             duration_ms = null,
             started_at = null,
             finished_at = null,
             worker_id = null,
             lease_token = null,
             lease_expires_at = null,
             canceled_at = null
         where run_id = $1 and status in ('failed', 'canceled', 'skipped')`,
        [runId]
      );
      // Reset run status to queued
      await c.query(
        "update public.pipeline_runs set status = 'queued', finished_at = null, canceled_at = null where id = $1",
        [runId]
      );
      await c.query(
        'insert into public.audit_events(organization_id, actor_id, action, target_type, target_id) values($1, $2, $3, $4, $5)',
        [run.organization_id, req.user.id, 'pipeline.run.retried', 'pipeline_run', runId]
      );
    });

    res.json({ ok: true, runId, status: 'queued' });
  } catch (e) {
    res.status(500).json({ error: 'Could not retry run' });
  }
});

// ==========================================
// Job Logs & Status
// ==========================================
app.get('/api/jobs/:jobId/logs', userAuth, async (req, res) => {
  const { jobId } = req.params;
  const sinceId = Number(req.query.sinceId || 0);
  const stream = req.query.stream; // 'stdout' | 'stderr' | undefined

  try {
    const authCheck = await query(
      `select j.id, p.organization_id
       from public.jobs j
       join public.pipeline_runs r on r.id = j.run_id
       join public.projects p on p.id = r.project_id
       join public.organization_members m on m.organization_id = p.organization_id
       where j.id = $1 and m.user_id = $2`,
      [jobId, req.user.id]
    );
    if (!authCheck.rowCount) {
      return res.status(404).json({ error: 'Job not found or access denied' });
    }

    let logQuery = 'select id, stream, message, created_at as "createdAt" from public.job_logs where job_id = $1 and id > $2';
    const params = [jobId, sinceId];

    if (stream === 'stdout' || stream === 'stderr') {
      logQuery += ' and stream = $3';
      params.push(stream);
    }
    logQuery += ' order by id asc limit 2000';

    const r = await query(logQuery, params);
    res.json({
      jobId,
      logs: r.rows.map((row) => ({
        id: String(row.id),
        seq: Number(row.id),
        stream: row.stream,
        message: redactSecrets(row.message),
        timestamp: row.createdAt,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch job logs' });
  }
});

// ==========================================
// Worker Protocol Endpoints
// ==========================================
app.post('/api/workers/register', workerAuth, async (req, res) => {
  const { workerId, hostname = workerId, arch = 'linux/amd64', region = 'unknown', maxConcurrency = 1 } = req.body || {};
  if (workerId !== req.worker.id) {
    return res.status(403).json({ error: 'Worker identity mismatch' });
  }
  try {
    await query(
      `update public.workers
       set hostname = $2, architecture = $3, region = $4,
           max_concurrency = $5, state = 'online', last_seen_at = now()
       where id = $1 and organization_id = $6`,
      [workerId, hostname, arch, region, Math.min(128, Math.max(1, Number(maxConcurrency))), req.worker.organizationId]
    );
    res.json({ ok: true, workerId });
  } catch (e) {
    res.status(500).json({ error: 'Worker registration failed' });
  }
});

app.post('/api/workers/heartbeat', workerAuth, async (req, res) => {
  const r = await query(
    `update public.workers
     set last_seen_at = now(),
         state = case when $2 then 'draining' else 'online' end
     where id = $1 and id = $3 returning id`,
    [req.body.workerId, !!req.body.draining, req.worker.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Worker not registered' });
  res.json({ ok: true });
});

// Atomic Job Claiming with Dependency Resolution and Secret Decryption
app.post('/api/workers/claim', workerAuth, async (req, res) => {
  if (req.body.workerId !== req.worker.id) {
    return res.status(403).json({ error: 'Worker identity mismatch' });
  }
  try {
    const job = await transaction(async (c) => {
      const worker = await c.query('select * from public.workers where id = $1 for update', [req.body.workerId]);
      if (!worker.rowCount) return null;
      const w = worker.rows[0];

      const active = await c.query("select count(*)::int n from public.jobs where worker_id = $1 and status = 'running'", [w.id]);
      if (active.rows[0].n >= w.max_concurrency || w.state === 'draining') return null;

      // Skip jobs whose dependencies have failed, canceled, or were skipped
      await c.query(
        `update public.jobs j
         set status = 'skipped', finished_at = now(), exit_code = 125
         where j.status = 'queued'
           and exists (
             select 1 from public.pipeline_runs rr
             join public.projects pp on pp.id = rr.project_id
             where rr.id = j.run_id and pp.organization_id = $1
           )
           and exists (
             select 1 from public.jobs d
             where d.run_id = j.run_id and d.external_id = any(j.needs)
               and d.status in ('failed', 'canceled', 'skipped')
           )`,
        [w.organization_id]
      );

      // Find candidate job where all dependencies succeeded
      const candidate = await c.query(
        `select j.*, r.branch, r.commit_sha, p.repository_url, p.id as project_id
         from public.jobs j
         join public.pipeline_runs r on r.id = j.run_id
         join public.projects p on p.id = r.project_id
         where p.organization_id = $1 and j.status = 'queued'
           and not exists (
             select 1 from unnest(j.needs) d(id)
             join public.jobs dep on dep.run_id = j.run_id and dep.external_id = d.id
             where dep.status not in ('succeeded')
           )
         order by j.created_at
         limit 1
         for update of j skip locked`,
        [w.organization_id]
      );

      if (!candidate.rowCount) return null;
      const j = candidate.rows[0];
      const lease = crypto.randomBytes(32).toString('hex');
      const leaseDurationSec = 45;

      const u = await c.query(
        `update public.jobs
         set status = 'running',
             worker_id = $2,
             lease_token = $3,
             lease_expires_at = now() + interval '${leaseDurationSec} seconds',
             started_at = now(),
             attempt = attempt + 1
         where id = $1 returning *`,
        [j.id, w.id, lease]
      );

      await c.query("update public.workers set state = 'busy', last_seen_at = now() where id = $1", [w.id]);

      // Fetch and decrypt project secrets for this job
      const secretsQuery = await c.query(
        'select name, encrypted_value, iv, auth_tag from public.project_secrets where project_id = $1',
        [j.project_id]
      );
      const secrets = {};
      for (const s of secretsQuery.rows) {
        try {
          secrets[s.name] = decryptSecret(s.encrypted_value, s.iv, s.auth_tag);
        } catch {
          // Ignore decryption failure on single corrupt secret
        }
      }

      return {
        ...u.rows[0],
        leaseToken: lease,
        repositoryUrl: j.repository_url,
        branch: j.branch,
        commitSha: j.commit_sha,
        runId: j.run_id,
        projectId: j.project_id,
        memoryLimitMb: j.memory_limit_mb,
        cpuMillicores: j.cpu_millicores,
        timeoutSeconds: j.timeout_seconds,
        secrets,
      };
    });

    res.json({ job });
  } catch (e) {
    res.status(500).json({ error: 'Could not claim job' });
  }
});

// Job Logs Ingest
app.post('/api/workers/jobs/:jobId/logs', workerAuth, async (req, res) => {
  const { leaseToken, entries = [] } = req.body || {};
  const valid = await query(
    "select id, status from public.jobs where id = $1 and lease_token = $2 and worker_id = $3 and status = 'running' and lease_expires_at > now()",
    [req.params.jobId, leaseToken, req.worker.id]
  );
  if (!valid.rowCount) {
    return res.status(409).json({ error: 'Lease is invalid or expired' });
  }

  for (const e of entries.slice(0, 100)) {
    const cleanMessage = redactSecrets(String(e.message || '')).slice(0, 8000);
    await query(
      'insert into public.job_logs(job_id, stream, message) values($1, $2, $3)',
      [req.params.jobId, e.stream === 'stderr' ? 'stderr' : 'stdout', cleanMessage]
    );
  }

  // Extend lease by 45 seconds on successful heartbeat / log flush
  await query("update public.jobs set lease_expires_at = now() + interval '45 seconds' where id = $1", [req.params.jobId]);
  res.json({ ok: true });
});

// Job Completion
app.post('/api/workers/jobs/:jobId/complete', workerAuth, async (req, res) => {
  const { leaseToken, exitCode, durationMs, status } = req.body || {};
  const finalStatus = status === 'canceled' ? 'canceled' : Number(exitCode) === 0 ? 'succeeded' : 'failed';

  const r = await query(
    `update public.jobs
     set status = $3,
         exit_code = $4,
         duration_ms = $5,
         finished_at = now(),
         lease_token = null,
         lease_expires_at = null
     where id = $1 and lease_token = $2 and worker_id = $6 and status = 'running'
     returning run_id`,
    [req.params.jobId, leaseToken, finalStatus, Number(exitCode), Math.max(0, Number(durationMs || 0)), req.worker.id]
  );

  if (!r.rowCount) {
    return res.status(409).json({ error: 'Lease is invalid or expired' });
  }

  const runId = r.rows[0].run_id;

  await transaction(async (c) => {
    // Check overall run status
    await c.query(
      `update public.pipeline_runs r
       set status = case
         when exists(select 1 from public.jobs j where j.run_id = r.id and j.status = 'failed') then 'failed'
         when exists(select 1 from public.jobs j where j.run_id = r.id and j.status = 'canceled')
              and not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then 'canceled'
         when not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then 'succeeded'
         else 'running'
       end,
       finished_at = case
         when not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then now()
         else null
       end
       where r.id = $1`,
      [runId]
    );

    // Update worker state to online if no remaining running jobs
    const remaining = await c.query("select count(*)::int n from public.jobs where worker_id = $1 and status = 'running'", [req.worker.id]);
    await c.query(
      "update public.workers set state = case when $2 > 0 then 'busy' else 'online' end, last_seen_at = now() where id = $1",
      [req.worker.id, remaining.rows[0].n]
    );
  });

  res.json({ ok: true, status: finalStatus });
});

// Artifacts Upload Registration
app.post('/api/workers/jobs/:jobId/artifacts', workerAuth, async (req, res) => {
  const { leaseToken, name, objectKey, sizeBytes = 0, sha256 = null, contentType = 'application/octet-stream' } = req.body || {};
  if (!name || !objectKey) {
    return res.status(400).json({ error: 'Artifact name and objectKey are required' });
  }

  const valid = await query(
    "select run_id from public.jobs where id = $1 and lease_token = $2 and worker_id = $3 and status = 'running'",
    [req.params.jobId, leaseToken, req.worker.id]
  );
  if (!valid.rowCount) {
    return res.status(409).json({ error: 'Lease is invalid or expired' });
  }

  try {
    const r = await query(
      `insert into public.artifacts(run_id, name, object_key, size_bytes, sha256, content_type)
       values($1, $2, $3, $4, $5, $6)
       returning *`,
      [valid.rows[0].run_id, name.slice(0, 255), objectKey.slice(0, 1024), Math.max(0, Number(sizeBytes)), sha256, contentType]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Could not register artifact' });
  }
});

// ==========================================
// Admin & Platform Management
// ==========================================
app.get('/api/admin/organizations', userAuth, platformAdmin, async (_req, res) => {
  const r = await query(
    `select o.id, o.name, o.slug, o.created_at as created_at,
            (select count(*)::int from public.organization_members m where m.organization_id = o.id) as members,
            (select count(*)::int from public.projects p where p.organization_id = o.id) as projects
     from public.organizations o
     order by o.created_at desc limit 500`
  );
  res.json(r.rows);
});

app.post('/api/admin/workers', sensitiveLimiter, userAuth, platformAdmin, async (req, res) => {
  const { organizationId, name = 'Worker node', region = 'unknown', maxConcurrency = 2 } = req.body || {};
  if (!organizationId) return res.status(400).json({ error: 'organizationId required' });

  const workerId = `wrk_${crypto.randomUUID()}`;
  const token = crypto.randomBytes(32).toString('hex');

  try {
    await transaction(async (c) => {
      await c.query(
        "insert into public.workers(id, organization_id, hostname, architecture, region, state, max_concurrency) values($1, $2, $3, 'pending', $4, 'offline', $5)",
        [workerId, organizationId, name, region, Math.min(128, Math.max(1, Number(maxConcurrency)))]
      );
      await c.query('insert into public.worker_credentials(worker_id, token_hash) values($1, $2)', [workerId, sha(token)]);
      await c.query(
        "insert into public.audit_events(organization_id, actor_id, action, target_type, target_id) values($1, $2, 'worker.credential.created', 'worker', $3)",
        [organizationId, req.user.id, workerId]
      );
    });
    res.status(201).json({
      workerId,
      token,
      warning: 'Copy this token now. It will not be shown again.',
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not provision worker' });
  }
});

// Revoke Worker Credential
app.post('/api/admin/workers/:workerId/revoke', sensitiveLimiter, userAuth, platformAdmin, async (req, res) => {
  const { workerId } = req.params;
  try {
    await transaction(async (c) => {
      await c.query('update public.worker_credentials set revoked_at = now() where worker_id = $1', [workerId]);
      await c.query("update public.workers set state = 'offline' where id = $1", [workerId]);
    });
    res.json({ ok: true, workerId, revoked: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not revoke worker credentials' });
  }
});

app.get('/api/admin/overview', userAuth, platformAdmin, async (_req, res) => {
  const [p, r, w, j] = await Promise.all([
    query('select count(*)::int n from public.projects'),
    query('select count(*)::int n from public.pipeline_runs'),
    query('select id, hostname, architecture, region, state, last_seen_at from public.workers order by last_seen_at desc limit 100'),
    query('select status, count(*)::int n from public.jobs group by status'),
  ]);
  res.json({
    generatedAt: now(),
    totals: {
      projects: p.rows[0].n,
      runs: r.rows[0].n,
      workers: w.rowCount,
      jobs: j.rows.reduce((a, x) => a + x.n, 0),
    },
    workers: w.rows,
    jobStatuses: Object.fromEntries(j.rows.map((x) => [x.status, x.n])),
  });
});

app.get('/api/admin/audit', userAuth, platformAdmin, async (_req, res) => {
  const r = await query('select * from public.audit_events order by created_at desc limit 200');
  res.json(r.rows);
});

// Periodic Lease Recovery (can also be invoked by Vercel Cron via /api/cron/recovery)
app.get('/api/cron/recovery', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!cronSecret || cronSecret.length < 32 || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized cron request' });
  }
  try {
    const result = await query('select * from public.recover_stale_leases()');
    res.json({ ok: true, recovery: result.rows[0], time: now() });
  } catch (e) {
    res.status(500).json({ error: 'Lease recovery failed' });
  }
});

// Safe Error Handling Middleware
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;

// In standalone server mode, run background lease recovery timer
const isMain = process.argv[1] && (process.argv[1].endsWith('control-plane.mjs') || process.argv[1].endsWith('control-plane.js'));
if (!process.env.VERCEL && process.env.NODE_ENV !== 'test' && isMain) {
  const recovery = setInterval(async () => {
    try {
      await query('select * from public.recover_stale_leases()');
    } catch {
      // In case the migration hasn't been applied yet, fallback to inline recovery
      try {
        await query(
          "update public.jobs set status = case when attempt >= 3 then 'failed' else 'queued' end, worker_id = null, lease_token = null, lease_expires_at = null, finished_at = case when attempt >= 3 then now() else null end where status = 'running' and lease_expires_at < now()"
        );
        await query(
          "update public.workers set state = 'offline' where last_seen_at < now() - interval '45 seconds' and state not in ('offline', 'draining')"
        );
      } catch {}
    }
  }, 5000).unref();

  const server = app.listen(port, '0.0.0.0', () =>
    console.log(`Kestrel control plane listening on :${port}`)
  );

  async function shutdown() {
    clearInterval(recovery);
    server.close();
    try {
      await pool.end();
    } catch {}
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
