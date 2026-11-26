import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { pool, query, transaction } from './lib/db.mjs';
import { validatePipelineJobs } from './lib/pipeline.mjs';
import { isGitHubWebhookSecretReadableRole, isSupportedGitHubWebhookEvent, shouldQueuePullRequestAction, shouldIgnoreGitHubPush, isValidGitHubDeliveryId, isValidGitBranch, isValidGitCommitSha, isValidGitHubInstallationId, claimGitHubProjectWebhookDelivery } from './lib/github-webhooks.mjs';
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
import { registerProjectFileRoutes } from './routes/project-files.mjs';
import { registerArtifactRoutes } from './routes/artifacts.mjs';
import { registerDeploymentRoutes } from './routes/deployments.mjs';
import { registerComputeRoutes } from './routes/compute.mjs';
import { registerSandboxRoutes } from './routes/sandboxes.mjs';
import { registerGitImportRoutes } from './routes/git-import.mjs';
import { registerGitHubAppRoutes } from './routes/github-app.mjs';
import { registerHostingRoutes } from './routes/hosting.mjs';
import { registerHostingConnectionRoutes } from './routes/hosting-connections.mjs';
import { registerManagedDeploymentRoutes } from './routes/managed-deployments.mjs';
import { startManagedHostingAutomation, processManagedHostingQueue } from './lib/managed-hosting-automation.mjs';
import { reconcileManagedDeploymentReadiness } from './lib/managed-deployment-readiness.mjs';
import { refreshProviderImageRegistryCredentials } from './lib/oci-registries.mjs';
import { createGitHubInstallationToken } from './lib/github-app.mjs';
import { summarizeManagedHostingHealth } from './lib/operations-health.mjs';

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

app.disable('x-powered-by');
// Vercel terminates public requests at its edge proxy; trust exactly one hop there.
app.set('trust proxy', process.env.VERCEL ? 1 : process.env.TRUST_PROXY === 'true' ? 1 : false);

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
  limit: 3000,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

// Stricter limiter for sensitive auth and admin actions
const sensitiveLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
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

// ==========================================
// Built-in Authentication (Standalone Mode)
// ==========================================
app.post('/api/auth/signup', sensitiveLimiter, async (req, res) => {
  const { email, password, fullName } = req.body || {};
  if (!email || !email.includes('@') || !password || password.length < 8) {
    return res.status(400).json({ error: 'Valid email and password (minimum 8 chars) required' });
  }

  try {
    const { salt, hash } = hashPassword(password);
    const existing = await query('select id from auth.users where lower(email) = lower($1)', [email]);
    if (existing.rowCount) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // First registered user is automatically promoted to platform_admin
    const countRes = await query('select count(*)::int n from auth.users');
    const isFirstUser = countRes.rows[0].n === 0;
    const appMeta = isFirstUser ? { platform_role: 'platform_admin' } : {};
    const userMeta = { full_name: fullName || email.split('@')[0] };

    const newUser = await transaction(async (c) => {
      const u = await c.query(
        `insert into auth.users(email, encrypted_password, raw_app_meta_data, raw_user_meta_data)
         values(lower($1), $2, $3, $4)
         returning id, email, raw_app_meta_data, raw_user_meta_data`,
        [email, `${salt}:${hash}`, JSON.stringify(appMeta), JSON.stringify(userMeta)]
      );
      const user = u.rows[0];
      await c.query(
        'insert into public.profiles(id, full_name) values($1, $2) on conflict (id) do nothing',
        [user.id, userMeta.full_name]
      );
      return user;
    });

    const token = signJwt({
      sub: newUser.id,
      email: newUser.email,
      app_metadata: appMeta,
      user_metadata: userMeta,
    });

    res.status(201).json({
      user: {
        id: newUser.id,
        email: newUser.email,
        app_metadata: appMeta,
        user_metadata: userMeta,
      },
      session: {
        access_token: token,
        token_type: 'bearer',
      },
    });
  } catch (e) {
    console.error('Signup error:', e);
    res.status(500).json({ error: 'Could not create account' });
  }
});

app.post('/api/auth/login', sensitiveLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const r = await query('select * from auth.users where lower(email) = lower($1)', [email]);
    if (!r.rowCount) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = r.rows[0];
    const [salt, storedHash] = (user.encrypted_password || '').split(':');
    if (!salt || !storedHash || !verifyPassword(password, salt, storedHash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const appMeta = user.raw_app_meta_data || {};
    const userMeta = user.raw_user_meta_data || {};

    const token = signJwt({
      sub: user.id,
      email: user.email,
      app_metadata: appMeta,
      user_metadata: userMeta,
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        app_metadata: appMeta,
        user_metadata: userMeta,
      },
      session: {
        access_token: token,
        token_type: 'bearer',
      },
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Authentication failed' });
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
    console.error('Database health check failed:', { code: e.code, message: e.message });
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
    console.error('Workspace lookup failed:', { code: e.code, message: e.message });
    res.status(500).json({ error: 'Could not fetch workspaces' });
  }
});

// Workspace Snapshot
app.get('/api/snapshot', userAuth, orgAccess, async (req, res) => {
  try {
    const [p, r, w, a] = await Promise.all([
      query(
        `select id, name, repository_url as repo, source_type as "sourceType", default_branch as "defaultBranch", created_at as "createdAt"
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
                      'finishedAt', j.finished_at,
                      'workingDirectory', j.working_directory
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
        `select id, hostname, architecture as arch, region, state, runtime,
                last_seen_at as "lastSeenAt", max_concurrency as "maxConcurrency"
         from public.workers
         where organization_id = $1
         order by created_at desc`,
        [req.organizationId]
      ),
      query(
        `select a.id, a.name, a.run_id as "runId", a.object_key as "objectKey",
                a.size_bytes as "sizeBytes", a.sha256, a.content_type as "contentType",
                a.created_at as "createdAt", a.expires_at as "expiresAt"
         from public.artifacts a
         join public.pipeline_runs r on r.id = a.run_id
         join public.projects p on p.id = r.project_id
         where p.organization_id = $1 and a.deleted_at is null and (a.expires_at is null or a.expires_at > now())
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
    console.error('Workspace snapshot lookup failed:', { code: e.code, message: e.message });
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
  const repoValue = typeof repo === 'string' ? repo.trim() : '';
  let repoUrl = null;
  if (repoValue) {
    try {
      repoUrl = new URL(repoValue);
    } catch {
      return res.status(400).json({ error: 'Invalid repository URL format' });
    }
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
    name.trim().length > 120 ||
    (repoValue && (
      !repoUrl ||
      repoUrl.protocol !== 'https:' ||
      repoUrl.username ||
      repoUrl.password ||
      !allowedHosts.includes(repoUrl.hostname.toLowerCase())
    ))
  ) {
    return res.status(400).json({
      error: repoValue
        ? `Use a valid credential-free HTTPS repository on an approved Git host: ${allowedHosts.join(', ')}`
        : 'Project name must be between 2 and 120 characters',
    });
  }

  try {
    const r = await transaction(async (c) => {
      const proj = await c.query(
        'insert into public.projects(organization_id, name, repository_url, default_branch, created_by, source_type) values($1, $2, $3, $4, $5, $6) returning *',
        [req.organizationId, name.trim(), repoValue || null, String(defaultBranch || 'main').trim() || 'main', req.user.id, repoValue ? 'git' : 'upload']
      );
      // Git-backed projects receive a signed webhook. Uploaded projects do not need a Git remote.
      if (repoValue) {
        const webhookSecret = crypto.randomBytes(24).toString('hex');
        await c.query(
          'insert into public.github_webhooks(project_id, webhook_secret) values($1, $2)',
          [proj.rows[0].id, webhookSecret]
        );
      }
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
    if (!authCheck.rowCount) return res.status(403).json({ error: 'Project access denied' });
    if (!isGitHubWebhookSecretReadableRole(authCheck.rows[0].role)) {
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

// Project-level OCI build settings. The worker validates the selected path against the pinned commit.
app.get('/api/projects/:projectId/build-settings', userAuth, async (req, res) => {
  try {
    const result = await query(
      `select p.oci_build_context as "ociBuildContext"
       from public.projects p
       join public.organization_members m on m.organization_id = p.organization_id
       where p.id = $1 and m.user_id = $2`,
      [req.params.projectId, req.user.id],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Project not found' });
    return res.json({ ociBuildContext: result.rows[0].ociBuildContext || null });
  } catch (error) {
    console.error('Project build settings lookup failed:', error.message);
    return res.status(500).json({ error: 'Could not load project build settings' });
  }
});

app.patch('/api/projects/:projectId/build-settings', userAuth, async (req, res) => {
  const rawContext = req.body?.ociBuildContext;
  const buildContext = rawContext === null || rawContext === '' ? null : rawContext;
  if (buildContext !== null) {
    if (typeof buildContext !== 'string' || buildContext.length > 200 ||
        buildContext.includes('\\') || buildContext.includes('\0') ||
        buildContext.startsWith('/') || /^[A-Za-z]:/.test(buildContext)) {
      return res.status(400).json({ error: 'OCI build context must be a safe repository-relative directory' });
    }
    const parts = buildContext.split('/');
    if (buildContext !== '.' && parts.some((part) => !part || part === '.' || part === '..')) {
      return res.status(400).json({ error: 'OCI build context cannot contain empty or traversal path segments' });
    }
  }
  try {
    const member = await query(
      `select m.role, p.organization_id from public.projects p
       join public.organization_members m on m.organization_id = p.organization_id
       where p.id = $1 and m.user_id = $2`,
      [req.params.projectId, req.user.id],
    );
    if (!member.rowCount) return res.status(404).json({ error: 'Project not found' });
    if (!['owner', 'admin', 'developer'].includes(member.rows[0].role)) {
      return res.status(403).json({ error: 'Developer access required to change build settings' });
    }
    await query(
      'update public.projects set oci_build_context = $2 where id = $1',
      [req.params.projectId, buildContext],
    );
    await query(
      `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
       values($1,$2,'project.build_context_updated','project',$3,$4::jsonb)`,
      [member.rows[0].organization_id, req.user.id, req.params.projectId, JSON.stringify({ ociBuildContext: buildContext })],
    );
    return res.json({ ok: true, ociBuildContext: buildContext });
  } catch (error) {
    console.error('Project build settings update failed:', error.message);
    return res.status(500).json({ error: 'Could not update project build settings' });
  }
});

// GitHub Webhook Receiver
app.post('/api/webhooks/github', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];
  const body = req.body;

  if (event === 'ping') {
    return res.json({ ok: true, message: 'Pong! Webhook configured successfully.' });
  }

  if (event === 'installation') {
    const appSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
    if (!appSecret) return res.status(503).json({ error: 'GitHub App webhook is not configured' });
    if (!verifyGitHubSignature(req.rawBody || JSON.stringify(body), signature, appSecret)) {
      return res.status(401).json({ error: 'Invalid GitHub App webhook signature' });
    }
    const installationId = String(body?.installation?.id || '');
    if (!isValidGitHubInstallationId(installationId)) return res.status(400).json({ error: 'Invalid GitHub installation event' });
    const deliveryId = String(req.headers['x-github-delivery'] || '').trim();
    if (!isValidGitHubDeliveryId(deliveryId)) return res.status(400).json({ error: 'A valid GitHub delivery ID is required' });
    const action = String(body?.action || '');
    if (!['deleted', 'suspend', 'unsuspend', 'created', 'new_permissions_accepted'].includes(action)) {
      return res.status(200).json({ message: `Ignored installation action: ${action || 'unknown'}` });
    }
    try {
      const result = await transaction(async (client) => {
        const { processGitHubInstallationDelivery } = await import('./lib/github-installation-webhooks.mjs');
        return processGitHubInstallationDelivery(client, { deliveryId, action, installationId });
      });
      return res.json({ ok: true, ...result, deliveryId });
    } catch {
      return res.status(500).json({ error: 'Could not update GitHub App installation state' });
    }
  }

  if (!isSupportedGitHubWebhookEvent(event)) {
    return res.status(200).json({ message: `Ignored event: ${event}` });
  }
  if (event === 'pull_request' && !shouldQueuePullRequestAction(body?.action)) {
    return res.status(200).json({ message: `Ignored pull request action: ${body?.action || 'unknown'}` });
  }
  if (event === 'push' && shouldIgnoreGitHubPush(body)) {
    return res.status(200).json({ message: 'Branch deletion does not trigger a pipeline' });
  }

  // Identify repository from payload
  const repoFullName = body?.repository?.full_name?.toLowerCase();
  const repoHtmlUrl = body?.repository?.html_url?.toLowerCase();
  const repoCloneUrl = body?.repository?.clone_url?.toLowerCase();

  if (!repoFullName && !repoHtmlUrl) {
    return res.status(400).json({ error: 'Missing repository information in webhook payload' });
  }

  const deliveryId = String(req.headers['x-github-delivery'] || '').trim();
  if (!isValidGitHubDeliveryId(deliveryId)) {
    return res.status(400).json({ error: 'A valid GitHub delivery ID is required' });
  }

  try {
    // Find matching project
    const projQuery = await query(
      `select p.*, w.webhook_secret, w.active, w.events,
              i.installation_id as linked_installation_id, i.suspended_at as installation_suspended_at
       from public.projects p
       left join public.github_webhooks w on w.project_id = p.id
       left join public.github_app_installations i
         on i.organization_id = p.organization_id and i.installation_id = p.github_installation_id
       where lower(p.repository_url) in ($1, $2, $3, $4, $5)
         and (p.github_installation_id is null or p.github_installation_id = $6)`,
      [
        repoHtmlUrl || '',
        repoCloneUrl || '',
        `https://github.com/${repoFullName}`,
        `https://github.com/${repoFullName}.git`,
        repoFullName || '',
        String(body?.installation?.id || ''),
      ]
    );

    if (!projQuery.rowCount) {
      return res.status(404).json({ error: 'No matching project found for this repository' });
    }

    const project = projQuery.rows[0];
    if (event === 'pull_request') {
      const baseRepository = String(body?.repository?.full_name || '').toLowerCase();
      const headRepository = String(body?.pull_request?.head?.repo?.full_name || '').toLowerCase();
      if (!baseRepository || !headRepository || baseRepository !== headRepository) {
        return res.status(202).json({ message: 'Pull requests from forks are not executed because project secrets are not exposed to untrusted fork code' });
      }
    }
    if (!project.active || !project.webhook_secret) {
      return res.status(403).json({ error: 'GitHub webhook is not active for this project' });
    }
    if (!Array.isArray(project.events) || !project.events.includes(event)) {
      return res.status(200).json({ message: `Webhook event is not subscribed: ${event}` });
    }
    const isAppDelivery = Boolean(project.github_installation_id);
    if (isAppDelivery && (String(project.github_installation_id) !== String(body?.installation?.id || '') ||
        String(project.linked_installation_id || '') !== String(project.github_installation_id) ||
        project.installation_suspended_at)) {
      return res.status(403).json({ error: 'GitHub App installation is missing, mismatched, or suspended' });
    }
    const webhookSecret = isAppDelivery ? process.env.GITHUB_APP_WEBHOOK_SECRET : project.webhook_secret;
    if (!webhookSecret || !verifyGitHubSignature(req.rawBody || JSON.stringify(body), signature, webhookSecret)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    let branch = project.default_branch;
    let commitSha = null;
    let commitMessage = 'Triggered by GitHub Webhook';

    if (event === 'push') {
      branch = (body.ref || '').replace(/^refs\/heads\//, '') || project.default_branch;
      commitSha = body.after || body.head_commit?.id || null;
      commitMessage = body.head_commit?.message || `Push to ${branch}`;
    } else if (event === 'pull_request') {
      branch = body.pull_request?.head?.ref || project.default_branch;
      commitSha = body.pull_request?.head?.sha || null;
      commitMessage = `PR #${body.pull_request?.number}: ${body.pull_request?.title || 'Pull request'}`;
    }

    if (!isValidGitBranch(branch)) {
      return res.status(400).json({ error: 'Invalid Git branch in webhook payload' });
    }
    if (!isValidGitCommitSha(commitSha)) {
      return res.status(400).json({ error: 'Webhook payload did not contain a valid commit SHA' });
    }

    // Default CI jobs pipeline
    const defaultJobs = [
      { id: 'install', name: 'Install dependencies', stage: 'build', workingDirectory: project.oci_build_context || '.', command: "if [ -f package.json ]; then if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci; else npm install; fi; elif [ -f requirements.txt ]; then python -m pip install -r requirements.txt; elif [ -f go.mod ]; then go mod download; elif [ -f Cargo.toml ]; then cargo fetch; else echo 'No dependency manifest found; skipping'; fi" },
      { id: 'test', name: 'Run tests', stage: 'test', workingDirectory: project.oci_build_context || '.', command: "if [ -f package.json ] && node -e \"process.exit(require('./package.json').scripts?.test ? 0 : 1)\"; then npm test; elif [ -f go.mod ]; then go test ./...; elif [ -f Cargo.toml ]; then cargo test; elif [ -f pytest.ini ] || [ -f tox.ini ]; then python -m pytest; else echo 'No test command detected; skipping'; fi", needs: ['install'] },
      { id: 'build', name: 'Build application', stage: 'package', workingDirectory: project.oci_build_context || '.', command: "if [ -f package.json ] && node -e \"process.exit(require('./package.json').scripts?.build ? 0 : 1)\"; then npm run build; elif [ -f go.mod ]; then go build ./...; elif [ -f Cargo.toml ]; then cargo build --release; elif [ -f pyproject.toml ] && python -m build --version >/dev/null 2>&1; then python -m build; else echo 'No build command detected; skipping'; fi", needs: ['test'] },
    ];
    const safe = validatePipelineJobs(defaultJobs);

    const result = await transaction(async (c) => {
      const accepted = await claimGitHubProjectWebhookDelivery(c, {
        projectId: project.id, deliveryId, eventName: event, branch, commitSha,
      });
      if (!accepted) return { duplicate: true };
      await c.query('select id from public.projects where id = $1 for update', [project.id]);
      const n = await c.query('select coalesce(max(run_number), 0) + 1 n from public.pipeline_runs where project_id = $1', [project.id]);
      const rr = await c.query(
        'insert into public.pipeline_runs(project_id, run_number, branch, commit_sha, commit_message) values($1, $2, $3, $4, $5) returning *',
        [project.id, n.rows[0].n, branch, commitSha, commitMessage.slice(0, 300)]
      );
      for (const j of safe) {
        await c.query(
          `insert into public.jobs(run_id, external_id, name, stage, command, needs, memory_limit_mb, cpu_millicores, timeout_seconds, max_retries, artifact_paths, working_directory)
           values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [rr.rows[0].id, j.id, j.name, j.stage, j.command, j.needs, j.memory, j.cpu, j.timeoutSeconds, j.maxRetries, j.artifacts, j.workingDirectory]
        );
      }
      await c.query('update public.github_webhooks set last_triggered_at = now() where project_id = $1', [project.id]);
      await c.query('update public.github_webhook_deliveries set run_id = $2 where id = $1', [accepted.id, rr.rows[0].id]);
      await c.query(
        'insert into public.audit_events(organization_id, action, target_type, target_id, metadata) values($1, $2, $3, $4, $5)',
        [project.organization_id, 'pipeline.run.webhook_triggered', 'pipeline_run', rr.rows[0].id, JSON.stringify({ event, deliveryId, branch, commitSha })]
      );
      return { duplicate: false, run: rr.rows[0] };
    });

    if (result.duplicate) return res.status(200).json({ ok: true, duplicate: true, deliveryId });
    res.status(201).json({ ok: true, runId: result.run.id, runNumber: result.run.run_number, deliveryId });
  } catch (e) {
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
          `insert into public.jobs(run_id, external_id, name, stage, command, needs, memory_limit_mb, cpu_millicores, timeout_seconds, max_retries, artifact_paths, working_directory)
           values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [rr.rows[0].id, j.id, j.name, j.stage, j.command, j.needs, j.memory, j.cpu, j.timeoutSeconds, j.maxRetries, j.artifacts, j.workingDirectory]
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
    if (!e.status || e.status >= 500) {
      console.error('[pipeline.queue] Failed to create pipeline run', {
        code: e.code || 'UNKNOWN',
        message: e.message || 'Unknown error',
      });
    }
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
      'select j.*, j.working_directory as "workingDirectory" from public.jobs j where j.run_id = $1 order by j.created_at',
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
      await c.query(
        `update public.deployment_releases
         set status = 'failed', health_checked_at = now(), error_message = 'Deployment run was canceled'
         where pipeline_run_id = $1 and status in ('queued', 'deploying')`,
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
             available_at = now(),
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
      await c.query(
        `update public.deployment_releases
         set status = 'queued', health_checked_at = null, error_message = null, deployed_at = null
         where pipeline_run_id = $1 and status = 'failed'`,
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
  const { workerId, hostname = workerId, arch = 'linux/amd64', region = 'unknown', maxConcurrency = 1, runtime = 'node' } = req.body || {};
  if (workerId !== req.worker.id) {
    return res.status(403).json({ error: 'Worker identity mismatch' });
  }
  try {
    await query(
      `update public.workers
       set hostname = $2, architecture = $3, region = $4,
           max_concurrency = $5, runtime = $7,\n           state = case when desired_state = 'offline' then 'offline' when desired_state = 'draining' then 'draining' else 'online' end,\n           last_seen_at = now()
       where id = $1 and organization_id = $6`,
      [workerId, hostname, arch, region, Math.min(128, Math.max(1, Number(maxConcurrency))), req.worker.organizationId, runtime === 'rust' ? 'rust' : 'node']
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
         state = case when desired_state = 'offline' then 'offline'\n                      when desired_state = 'draining' or $2 then 'draining'\n                      when exists (select 1 from public.jobs j where j.worker_id = workers.id and j.status = 'running') then 'busy'\n                      else 'online' end
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

      // Recover jobs abandoned by a worker that crashed or lost its connection.
      await c.query(
        `update public.jobs j
         set status = case when j.attempt <= j.max_retries then 'queued' else 'failed' end,
             worker_id = null,
             lease_token = null,
             lease_expires_at = null,
             started_at = case when j.attempt <= j.max_retries then null else j.started_at end,
             finished_at = case when j.attempt <= j.max_retries then null else now() end,
             exit_code = case when j.attempt <= j.max_retries then null else 124 end,
             available_at = case when j.attempt <= j.max_retries then now() + make_interval(secs => (least(300, 10 * power(2, least(j.attempt - 1, 5))))::int) else j.available_at end
         where j.status = 'running'
           and j.lease_expires_at <= now()
           and exists (
             select 1 from public.pipeline_runs rr
             join public.projects pp on pp.id = rr.project_id
             where rr.id = j.run_id and pp.organization_id = $1
           )`,
        [w.organization_id]
      );
      await c.query(
        `update public.deployment_releases dr
         set status = 'failed', health_checked_at = now(),
             error_message = 'Deployment worker lease expired after retries'
         where dr.status = 'deploying'
           and exists (select 1 from public.jobs j where j.deployment_release_id = dr.id and j.status = 'failed')`
      );
      await c.query(
        `update public.pipeline_runs r
         set status = 'failed', finished_at = now()
         where r.status = 'running'
           and exists (select 1 from public.jobs j where j.run_id = r.id and j.status = 'failed')
           and not exists (select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued', 'running'))
           and exists (select 1 from public.projects p where p.id = r.project_id and p.organization_id = $1)`,
        [w.organization_id]
      );
      await c.query(
        `update public.workers w
         set state = 'online'
         where w.organization_id = $1 and w.state = 'busy'
           and not exists (select 1 from public.jobs j where j.worker_id = w.id and j.status = 'running')`,
        [w.organization_id]
      );

      const active = await c.query("select count(*)::int n from public.jobs where worker_id = $1 and status = 'running'", [w.id]);
      if (active.rows[0].n >= w.max_concurrency || ['draining', 'offline'].includes(w.state)) return null;

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
      await c.query(
        `update public.pipeline_runs r
         set status = case
           when exists(select 1 from public.jobs j where j.run_id = r.id and j.status = 'failed')
                and not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then 'failed'
           when exists(select 1 from public.jobs j where j.run_id = r.id and j.status = 'canceled')
                and not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then 'canceled'
           when not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then 'succeeded'
           else 'running'
         end,
         finished_at = case
           when not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then now()
           else null end
         where r.id in (select pr.id from public.pipeline_runs pr join public.projects p on p.id = pr.project_id where p.organization_id = $1)
           and r.status in ('queued','running')
           and exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('failed','skipped','canceled'))`,
        [w.organization_id]
      );

      // Find candidate job where all dependencies succeeded
      const candidate = await c.query(
        `select j.*, r.branch, r.commit_sha, p.repository_url, p.source_type, p.id as project_id, p.github_installation_id,
                de.id as deployment_env_id, de.host_port as deployment_host_port,
                de.container_port as deployment_container_port, de.health_path as deployment_health_path,
                de.health_timeout_seconds as deployment_health_timeout,
                de.public_url as deployment_public_url, de.secret_names as deployment_secret_names,
                new_release.image as deployment_image, new_release.container_name as deployment_container_name,
                current_release.image as previous_deployment_image,
                current_release.container_name as previous_deployment_container
         from public.jobs j
         join public.pipeline_runs r on r.id = j.run_id
         join public.projects p on p.id = r.project_id
         left join public.deployment_environments de on de.id = j.deployment_environment_id
         left join public.deployment_releases current_release on current_release.id = de.current_release_id
         left join public.deployment_releases new_release on new_release.id = j.deployment_release_id
         where p.organization_id = $1 and j.status = 'queued' and j.available_at <= now()
           and (j.job_type = 'build' or (j.job_type = 'deployment' and de.worker_id = $2 and $3 = 'rust'))
           and not exists (
             select 1 from unnest(j.needs) d(id)
             join public.jobs dep on dep.run_id = j.run_id and dep.external_id = d.id
             where dep.status not in ('succeeded')
           )
         order by j.created_at
         limit 1
         for update of j skip locked`,
        [w.organization_id, w.id, w.runtime]
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
      if (j.job_type === 'deployment' && j.deployment_release_id) {
        await c.query("update public.deployment_releases set status = 'deploying' where id = $1 and status = 'queued'", [j.deployment_release_id]);
      }

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
        sourceType: j.source_type,
        branch: j.branch,
        commitSha: j.commit_sha,
        runId: j.run_id,
        projectId: j.project_id,
        githubInstallationId: j.github_installation_id,
        memoryLimitMb: j.memory_limit_mb,
        cpuMillicores: j.cpu_millicores,
        workingDirectory: j.working_directory || '.',
        timeoutSeconds: j.timeout_seconds,
        secrets,
        jobType: j.job_type || 'build',
        deployment: j.job_type === 'deployment' ? {
          environmentId: j.deployment_env_id,
          releaseId: j.deployment_release_id,
          image: j.deployment_image,
          containerName: j.deployment_container_name,
          hostPort: j.deployment_host_port,
          containerPort: j.deployment_container_port,
          healthPath: j.deployment_health_path,
          healthTimeoutSeconds: j.deployment_health_timeout,
          publicUrl: j.deployment_public_url,
          secretNames: j.deployment_secret_names || [],
          previousImage: j.previous_deployment_image,
          previousContainer: j.previous_deployment_container,
        } : null,
      };
    });

    if (job?.githubInstallationId) {
      const parsed = new URL(job.repositoryUrl);
      const parts = parsed.pathname.replace(/\\.git$/i, '').split('/').filter(Boolean);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parts.length !== 2) {
        return res.status(409).json({ error: 'Private GitHub repository URL is invalid' });
      }
      const linked = await query(
        'select installation_id from public.github_app_installations where organization_id = $1 and installation_id = $2 and suspended_at is null',
        [req.worker.organizationId, job.githubInstallationId],
      );
      if (!linked.rowCount) return res.status(409).json({ error: 'The GitHub App installation for this project is no longer connected' });
      const sourceToken = await createGitHubInstallationToken(job.githubInstallationId, {
        repository: `${parts[0]}/${parts[1]}`,
        permissions: { contents: 'read' },
      });
      job.sourceToken = sourceToken.token;
      delete job.githubInstallationId;
    }
    res.json({ job });
  } catch (e) {
    console.error('Worker job claim failed:', { code: e.code, message: redactSecrets(e.message) });
    res.status(503).json({ error: 'Could not claim job; any acquired lease will recover automatically' });
  }
});

// Dedicated managed OCI build leases. Registry credentials are decrypted only for the owning worker.
app.post('/api/workers/managed-image-builds/claim', workerAuth, async (req, res) => {
  if (req.body?.workerId !== req.worker.id) return res.status(403).json({ error: 'Worker identity mismatch' });
  try {
    const build = await transaction(async (client) => {
      const worker = await client.query('select * from public.workers where id = $1 for update', [req.worker.id]);
      if (!worker.rowCount || ['draining', 'offline'].includes(worker.rows[0].state)) return null;
      // Recover expired image-build leases before enforcing worker concurrency.
      // Otherwise a worker restarting with its own stale lease can count that lease
      // against max_concurrency and permanently prevent itself from reclaiming work.
      await client.query(
        `update public.managed_hosting_image_builds
         set status = case when attempt_count < 4 then 'queued' else 'failed' end,
             worker_id = null, lease_token = null, lease_expires_at = null,
             available_at = case when attempt_count < 4 then now() + interval '15 seconds' else available_at end,
             finished_at = case when attempt_count < 4 then null else now() end,
             last_error = case when attempt_count < 4
               then 'Worker lease expired; retrying managed image build'
               else 'Worker lease expired after retry budget was exhausted' end,
             updated_at = now()
         where organization_id = $1 and status = 'running' and lease_expires_at <= now()`,
        [worker.rows[0].organization_id],
      );
      await client.query(
        `update public.managed_hosting_automation_queue q
         set status = 'queued', locked_at = null, available_at = now(), updated_at = now()
         where q.organization_id = $1 and q.status = 'waiting_for_image'
           and exists (
             select 1 from public.managed_hosting_image_builds b
             where b.automation_queue_id = q.id and b.status = 'failed'
           )`,
        [worker.rows[0].organization_id],
      );
      const active = await client.query(
        `select
           (select count(*)::int from public.jobs
            where worker_id = $1 and status = 'running' and lease_expires_at > now()) +
           (select count(*)::int from public.managed_hosting_image_builds
            where worker_id = $1 and status = 'running' and lease_expires_at > now()) as count`,
        [req.worker.id],
      );
      if (active.rows[0].count >= worker.rows[0].max_concurrency) return null;
      const claimed = await client.query(
        "with candidate as (select b.id, p.github_installation_id from public.managed_hosting_image_builds b join public.projects p on p.id = b.project_id where p.organization_id = $1 and b.status = 'queued' and b.attempt_count < 4 and b.available_at <= now() order by b.created_at for update of b skip locked limit 1) update public.managed_hosting_image_builds b set status = 'running', attempt_count = attempt_count + 1, worker_id = $2, lease_token = $3, lease_expires_at = now() + interval '45 seconds', started_at = coalesce(started_at, now()), updated_at = now() from candidate where b.id = candidate.id returning b.*, candidate.github_installation_id",
        [worker.rows[0].organization_id, req.worker.id, crypto.randomBytes(32).toString('hex')],
      );
      if (!claimed.rowCount) return null;
      const row = claimed.rows[0];
      return {
        id: row.id, leaseToken: row.lease_token, organizationId: row.organization_id,
        projectId: row.project_id, repositoryUrl: row.repository_url,
        githubInstallationId: row.github_installation_id,
        branch: row.branch, commitSha: row.commit_sha, image: row.image, buildContext: row.build_context || null,
        registry: row.registry, provider: row.provider_id,
        registryUsername: decryptSecret(row.registry_username_ciphertext, row.registry_username_iv, row.registry_username_auth_tag),
        registryPassword: decryptSecret(row.registry_password_ciphertext, row.registry_password_iv, row.registry_password_auth_tag),
      };
    });
    if (!build) return res.json({ build: null });

    if (build.githubInstallationId) {
      const parsed = new URL(build.repositoryUrl);
      const parts = parsed.pathname.replace(/\\.git$/i, '').split('/').filter(Boolean);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parts.length !== 2) {
        throw new Error('Private GitHub repository URL is invalid');
      }
      const linked = await query(
        'select installation_id from public.github_app_installations where organization_id = $1 and installation_id = $2 and suspended_at is null',
        [build.organizationId, build.githubInstallationId],
      );
      if (!linked.rowCount) throw new Error('The GitHub App installation for this project is no longer connected');
      const sourceToken = await createGitHubInstallationToken(build.githubInstallationId, {
        repository: `${parts[0]}/${parts[1]}`,
        permissions: { contents: 'read' },
      });
      build.sourceToken = sourceToken.token;
    }
    delete build.githubInstallationId;
    // ECR authorization tokens expire after 12 hours. Refresh at claim time so a
    // queued build never relies on credentials minted when the pipeline was queued.
    if (build.provider === 'aws-ecs-express') {
      const connection = await query(
        `select credentials_ciphertext, credentials_iv, credentials_auth_tag
         from public.hosting_provider_connections
         where organization_id = $1 and provider_id = $2 and status = 'verified'`,
        [build.organizationId, build.provider],
      );
      if (!connection.rowCount) throw new Error('A verified AWS provider connection is required to refresh ECR credentials');
      const providerCredentials = JSON.parse(decryptSecret(
        connection.rows[0].credentials_ciphertext,
        connection.rows[0].credentials_iv,
        connection.rows[0].credentials_auth_tag,
      ));
      const refreshed = await refreshProviderImageRegistryCredentials(build.provider, providerCredentials);
      if (refreshed.registry !== build.registry) throw new Error('AWS ECR registry changed; create a fresh image build');
      const username = encryptSecret(refreshed.username);
      const password = encryptSecret(refreshed.password);
      const saved = await query(
        `update public.managed_hosting_image_builds
         set registry_username_ciphertext = $3, registry_username_iv = $4, registry_username_auth_tag = $5,
             registry_password_ciphertext = $6, registry_password_iv = $7, registry_password_auth_tag = $8,
             updated_at = now()
         where id = $1 and worker_id = $2 and status = 'running' and lease_expires_at > now()
         returning id`,
        [build.id, req.worker.id, username.encryptedValue, username.iv, username.authTag,
          password.encryptedValue, password.iv, password.authTag],
      );
      if (!saved.rowCount) throw new Error('Managed OCI build lease expired while refreshing ECR credentials');
      build.registryUsername = refreshed.username;
      build.registryPassword = refreshed.password;
    }
    delete build.organizationId;
    delete build.projectId;
    res.json({ build });
  } catch (error) {
    console.error('Managed OCI build claim failed:', { code: error.code, message: redactSecrets(error.message) });
    res.status(503).json({ error: 'Could not claim managed OCI build; the lease will be recovered automatically' });
  }
});

app.post('/api/workers/managed-image-builds/:buildId/release', workerAuth, async (req, res) => {
  const leaseToken = String(req.body?.leaseToken || '');
  if (!leaseToken) return res.status(400).json({ error: 'Lease token is required' });
  const released = await query(
    `update public.managed_hosting_image_builds
     set status = 'queued', worker_id = null, lease_token = null,
         lease_expires_at = null, attempt_count = greatest(attempt_count - 1, 0),
         started_at = null, finished_at = null, last_error = null,
         available_at = now(), updated_at = now()
     where id = $1 and worker_id = $2 and lease_token = $3
       and status = 'running' and lease_expires_at > now()
     returning id`,
    [req.params.buildId, req.worker.id, leaseToken],
  );
  if (!released.rowCount) return res.status(409).json({ error: 'Managed image build lease is invalid or expired' });
  res.json({ released: true });
});

app.post('/api/workers/managed-image-builds/:buildId/lease', workerAuth, async (req, res) => {
  const leaseToken = String(req.body?.leaseToken || '');
  const result = await query(
    "update public.managed_hosting_image_builds set lease_expires_at = now() + interval '45 seconds', updated_at = now() where id = $1 and worker_id = $2 and lease_token = $3 and status = 'running' and lease_expires_at > now() returning id",
    [req.params.buildId, req.worker.id, leaseToken],
  );
  if (!result.rowCount) return res.status(409).json({ error: 'Managed OCI build lease is invalid or expired' });
  res.json({ ok: true });
});

app.post('/api/workers/managed-image-builds/:buildId/complete', workerAuth, async (req, res) => {
  const { leaseToken, status, imageDigest, imageDigestRef, error } = req.body || {};
  const buildMeta = await query(
    "select image from public.managed_hosting_image_builds where id = $1 and worker_id = $2 and lease_token = $3 and status = 'running' and lease_expires_at > now()",
    [req.params.buildId, req.worker.id, leaseToken],
  );
  const expectedImagePrefix = buildMeta.rows[0]?.image?.split(':').slice(0, -1).join(':') + '@';
  const succeeded = status === 'succeeded' &&
    /^sha256:[a-f0-9]{64}$/.test(imageDigest || '') &&
    typeof imageDigestRef === 'string' &&
    expectedImagePrefix !== '@' && imageDigestRef === expectedImagePrefix + imageDigest;
  const result = await transaction(async (client) => {
    const updated = await client.query(
      "update public.managed_hosting_image_builds set status = case when $4 then 'succeeded' when attempt_count < 4 then 'queued' else 'failed' end, image_digest = case when $4 then $5 else null end, image_digest_ref = case when $4 then $6 else null end, last_error = case when $4 then null else $7 end, available_at = case when not $4 and attempt_count < 4 then now() + interval '30 seconds' else available_at end, finished_at = case when $4 or attempt_count >= 4 then now() else null end, worker_id = null, lease_token = null, lease_expires_at = null, updated_at = now() where id = $1 and worker_id = $2 and lease_token = $3 and status = 'running' and lease_expires_at > now() returning automation_queue_id, status, image_digest_ref",
      [req.params.buildId, req.worker.id, leaseToken, succeeded, imageDigest || null,
        imageDigestRef || null, redactSecrets(String(error || 'OCI build failed')).slice(0, 500)],
    );
    if (!updated.rowCount) return null;
    if (['succeeded', 'failed'].includes(updated.rows[0].status)) {
      await client.query(
        "update public.managed_hosting_automation_queue set status = 'queued', locked_at = null, available_at = now(), updated_at = now() where id = $1",
        [updated.rows[0].automation_queue_id],
      );
    }
    return updated.rows[0];
  });
  if (!result) return res.status(409).json({ error: 'Managed OCI build lease is invalid or expired' });
  res.json({ ok: true, status: result.status, imageDigestRef: result.image_digest_ref });
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
      [req.params.jobId, e.stream === 'stderr' ? 'stderr' : e.stream === 'system' ? 'system' : 'stdout', cleanMessage]
    );
  }

  // Refresh only while the same worker still owns the same unexpired lease.
  const extended = await query(
    "update public.jobs set lease_expires_at = now() + interval '45 seconds' where id = $1 and lease_token = $2 and worker_id = $3 and status = 'running' and lease_expires_at > now() returning id",
    [req.params.jobId, leaseToken, req.worker.id]
  );
  if (!extended.rowCount) return res.status(409).json({ error: 'Job lease is invalid or expired' });
  res.json({ ok: true });
});

// Refresh a running job lease without inserting a fake/empty log entry.
app.post('/api/workers/jobs/:jobId/lease', workerAuth, async (req, res) => {
  const lease = String(req.get('x-kestrel-lease') || req.body?.leaseToken || '');
  const result = await query(
    `update public.jobs
     set lease_expires_at = now() + interval '45 seconds'
     where id = $1 and worker_id = $2 and lease_token = $3
       and status = 'running' and lease_expires_at > now()
     returning id, lease_expires_at`,
    [req.params.jobId, req.worker.id, lease]
  );
  if (!result.rowCount) return res.status(409).json({ error: 'Job lease is invalid or expired' });
  res.json({ ok: true, leaseExpiresAt: result.rows[0].lease_expires_at });
});

// Worker-side cancellation polling. The lease token prevents another worker from inspecting this job.
app.get('/api/workers/jobs/:jobId/status', workerAuth, async (req, res) => {
  const lease = String(req.get('x-kestrel-lease') || '');
  const result = await query(
    'select status from public.jobs where id = $1 and worker_id = $2 and lease_token = $3',
    [req.params.jobId, req.worker.id, lease]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Job lease not found' });
  res.json({ status: result.rows[0].status });
});

// Release a just-claimed job when a worker begins draining before execution starts.
app.post('/api/workers/jobs/:jobId/release', workerAuth, async (req, res) => {
  const leaseToken = String(req.body?.leaseToken || '');
  if (!leaseToken) return res.status(400).json({ error: 'Lease token is required' });
  const released = await transaction(async (client) => {
    const selected = await client.query(
      `select id, deployment_release_id from public.jobs
       where id = $1 and worker_id = $2 and lease_token = $3
         and status = 'running' and lease_expires_at > now()
       for update`,
      [req.params.jobId, req.worker.id, leaseToken],
    );
    if (!selected.rowCount) return false;
    await client.query(
      `update public.jobs
       set status = 'queued', worker_id = null, lease_token = null,
           lease_expires_at = null, started_at = null, finished_at = null,
           exit_code = null, duration_ms = 0, attempt = greatest(attempt - 1, 0),
           available_at = now()
       where id = $1`,
      [req.params.jobId],
    );
    if (selected.rows[0].deployment_release_id) {
      await client.query(
        `update public.deployment_releases set status = 'queued', health_checked_at = null
         where id = $1 and status = 'deploying'`,
        [selected.rows[0].deployment_release_id],
      );
    }
    await client.query(
      `update public.workers
       set state = case when state in ('draining','offline') then state
         when exists (select 1 from public.jobs where worker_id = $1 and status = 'running') then 'busy'
         else 'online' end
       where id = $1`,
      [req.worker.id],
    );
    return true;
  });
  if (!released) return res.status(409).json({ error: 'Job lease is invalid or expired' });
  res.json({ released: true });
});

// Job Completion
app.post('/api/workers/jobs/:jobId/complete', workerAuth, async (req, res) => {
  const { leaseToken, exitCode, durationMs, status } = req.body || {};
  const finalStatus = status === 'canceled' ? 'canceled' : Number(exitCode) === 0 ? 'succeeded' : 'failed';

  const r = await query(
    `update public.jobs
     set status = case
           when status = 'canceled' then 'canceled'
           when $3 = 'failed' and attempt <= max_retries then 'queued'
           else $3 end,
         available_at = case
           when status <> 'canceled' and $3 = 'failed' and attempt <= max_retries
             then now() + make_interval(secs => (least(300, 10 * power(2, least(attempt - 1, 5))))::int)
           else available_at end,
         exit_code = $4,
         duration_ms = $5,
         finished_at = case
           when status = 'canceled' then coalesce(finished_at, now())
           when $3 = 'failed' and attempt <= max_retries then null
           else now() end,
         lease_token = null,
         lease_expires_at = null,
         worker_id = case
           when status = 'canceled' or ($3 = 'failed' and attempt <= max_retries) then null
           else worker_id end
     where id = $1 and lease_token = $2 and worker_id = $6 and status in ('running', 'canceled') and lease_expires_at > now()
     returning run_id, status`,
    [req.params.jobId, leaseToken, finalStatus, Number(exitCode), Math.max(0, Number(durationMs || 0)), req.worker.id]
  );

  if (!r.rowCount) {
    return res.status(409).json({ error: 'Lease is invalid or expired' });
  }

  const runId = r.rows[0].run_id;

  await transaction(async (c) => {
    const completedStatus = r.rows[0].status;
    const deploymentJob = await c.query(
      'select deployment_release_id from public.jobs where id = $1 and job_type = \'deployment\'',
      [req.params.jobId]
    );
    if (deploymentJob.rowCount && deploymentJob.rows[0].deployment_release_id && completedStatus !== 'queued') {
      const releaseId = deploymentJob.rows[0].deployment_release_id;
      await c.query(
        `update public.deployment_releases
         set status = case when $2 = 'succeeded' then 'healthy' else 'failed' end,
             deployed_at = case when $2 = 'succeeded' then now() else null end,
             health_checked_at = now(),
             error_message = case when $2 = 'succeeded' then null else 'Deployment failed health verification or container startup' end
         where id = $1`,
        [releaseId, completedStatus]
      );
      if (completedStatus === 'succeeded') {
        await c.query(
          'update public.deployment_environments set current_release_id = $1, updated_at = now() where id = (select environment_id from public.deployment_releases where id = $1)',
          [releaseId]
        );
      }
    }

    if (completedStatus === 'queued') {
      await c.query(
        "insert into public.job_logs(job_id, stream, message) values($1, 'system', $2)",
        [req.params.jobId, 'Job failed; retry scheduled because attempts remain']
      );
    } else {
      // Skip all downstream jobs that can no longer run, including transitive dependants.
      for (let pass = 0; pass < 100; pass += 1) {
        const skipped = await c.query(
          `update public.jobs j
           set status = 'skipped', finished_at = now(), exit_code = 125
           where j.run_id = $1 and j.status = 'queued'
             and exists (
               select 1 from public.jobs d
               where d.run_id = j.run_id and d.external_id = any(j.needs)
                 and d.status in ('failed', 'canceled', 'skipped')
             )`,
          [runId]
        );
        if (!skipped.rowCount) break;
      }
    }

    await c.query(
      `update public.pipeline_runs r
       set status = case
         when exists(select 1 from public.jobs j where j.run_id = r.id and j.status = 'failed')
              and not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then 'failed'
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
    await c.query(
      `insert into public.managed_hosting_automation_queue
         (pipeline_run_id, organization_id, project_id, branch, commit_sha)
       select r.id, p.organization_id, p.id, r.branch, r.commit_sha
       from public.pipeline_runs r join public.projects p on p.id = r.project_id
       where r.id = $1 and r.status = 'succeeded' and r.commit_sha is not null
       on conflict (pipeline_run_id) do nothing`,
      [runId],
    );

    const remaining = await c.query("select count(*)::int n from public.jobs where worker_id = $1 and status = 'running'", [req.worker.id]);
    await c.query(
      "update public.workers set state = case when state in ('draining', 'offline') then state when $2 > 0 then 'busy' else 'online' end, last_seen_at = now() where id = $1",
      [req.worker.id, remaining.rows[0].n]
    );
  });

  res.json({ ok: true, status: r.rows[0].status });
});

// Artifact bytes are uploaded through registerArtifactRoutes; metadata-only registration is intentionally disabled.

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

// Workspace-scoped worker provisioning for deployment runtime setup.
app.post('/api/workspaces/:orgId/workers', sensitiveLimiter, userAuth, orgAccess, async (req, res) => {
  const { name = 'Kestrel Deployment Worker', region = 'unknown', maxConcurrency = 1 } = req.body || {};
  const workerName = String(name).trim();
  const workerRegion = String(region || 'unknown').trim();
  const concurrency = Number(maxConcurrency);
  if (workerName.length < 2 || workerName.length > 80 || workerRegion.length > 80 ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    return res.status(400).json({ error: 'Worker name (2-80), region (max 80), and concurrency (1-8) are required' });
  }
  if (!['owner', 'admin', 'developer'].includes(req.orgRole)) {
    return res.status(403).json({ error: 'Workspace developer access required to provision workers' });
  }
  const workerId = `wrk_${crypto.randomUUID()}`;
  const token = crypto.randomBytes(32).toString('hex');
  try {
    await transaction(async (c) => {
      await c.query(
        "insert into public.workers(id, organization_id, hostname, architecture, region, state, desired_state, max_concurrency, runtime) values($1, $2, $3, 'pending', $4, 'offline', 'online', $5, 'rust')",
        [workerId, req.organizationId, workerName, workerRegion || 'unknown', concurrency]
      );
      await c.query('insert into public.worker_credentials(worker_id, token_hash) values($1, $2)', [workerId, sha(token)]);
      await c.query(
        "insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata) values($1, $2, 'worker.credential.created', 'worker', $3, $4::jsonb)",
        [req.organizationId, req.user.id, workerId, JSON.stringify({ runtime: 'rust', hostname: workerName, region: workerRegion })]
      );
    });
    res.status(201).json({ workerId, token, warning: 'Copy this token now. It will not be shown again.' });
  } catch (e) {
    console.error('Workspace worker provisioning failed:', { code: e.code, message: e.message });
    res.status(500).json({ error: 'Could not provision deployment worker' });
  }
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

// Change worker scheduling state without revoking its credential.
app.post('/api/admin/workers/:workerId/state', sensitiveLimiter, userAuth, platformAdmin, async (req, res) => {
  const { state } = req.body || {};
  if (!['online', 'draining', 'offline'].includes(state)) {
    return res.status(400).json({ error: 'State must be online, draining or offline' });
  }
  try {
    const result = await query(
      `update public.workers set desired_state = $2, state = $2
       where id = $1 returning id, state, desired_state, last_seen_at`,
      [req.params.workerId, state]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Worker not found' });
    await query(
      `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
       select organization_id, $2, $3, 'worker', id, $4::jsonb from public.workers where id = $1`,
      [req.params.workerId, req.user.id, `worker.state.${state}`, JSON.stringify({ state })]
    );
    res.json({ ok: true, worker: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Could not update worker state' });
  }
});

// Revoke Worker Credential
app.post('/api/admin/workers/:workerId/revoke', sensitiveLimiter, userAuth, platformAdmin, async (req, res) => {
  const { workerId } = req.params;
  try {
    await transaction(async (c) => {
      await c.query('update public.worker_credentials set revoked_at = now() where worker_id = $1', [workerId]);
      await c.query("update public.workers set desired_state = 'offline', state = 'offline' where id = $1", [workerId]);
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

app.get('/api/admin/health', userAuth, platformAdmin, async (_req, res) => {
  try {
    const [workers, queue, database, automationQueue, deployments, imageBuilds] = await Promise.all([
      query(`select
        count(*) filter (where state in ('online','busy') and last_seen_at >= now() - interval '45 seconds')::int as online,
        count(*) filter (where last_seen_at < now() - interval '45 seconds' or last_seen_at is null)::int as stale,
        count(*) filter (where state = 'draining')::int as draining,
        count(*) filter (where state = 'offline')::int as offline
        from public.workers`),
      query(`select
        count(*) filter (where status = 'queued')::int as queued,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (where status = 'failed')::int as failed
        from public.jobs`),
      query('select now() as checked_at'),
      query(`select status, count(*)::int as count
        from public.managed_hosting_automation_queue group by status order by status`),
      query(`select provider_id, status, count(*)::int as count
        from public.managed_hosting_deployments group by provider_id, status order by provider_id, status`),
      query(`select status, count(*)::int as count
        from public.managed_hosting_image_builds group by status order by status`),
    ]);
    const w = workers.rows[0], q = queue.rows[0];
    const managedHosting = summarizeManagedHostingHealth({
      automationQueueRows: automationQueue.rows,
      deploymentRows: deployments.rows,
      imageBuildRows: imageBuilds.rows,
    });
    res.json({
      checkedAt: database.rows[0].checked_at,
      database: 'connected',
      artifactStorage: process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? 'configured' : 'missing_configuration',
      workers: w,
      queue: q,
      managedHosting,
      scheduler: Number(w.online) > 0 ? 'worker_capacity_available' : Number(q.queued) > 0 ? 'queued_without_online_workers' : 'no_online_workers',
    });
  } catch (error) {
    console.error('Admin health check failed:', { code: error.code, message: error.message });
    res.status(503).json({ error: 'Could not read platform health' });
  }
});

app.get('/api/admin/audit', userAuth, platformAdmin, async (_req, res) => {
  const r = await query('select * from public.audit_events order by created_at desc limit 200');
  res.json(r.rows);
});

// Periodic Lease Recovery (can also be invoked by Vercel Cron via /api/cron/recovery)
const recoverCronLeases = async (req, res) => {
  const cronSecret = process.env.KESTREL_CRON_SECRET || process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!cronSecret) return res.status(503).json({ error: 'Cron authentication is not configured' });
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized cron request' });
  }
  try {
    const result = await query('select * from public.recover_stale_leases()');
    res.json({ ok: true, recovery: result.rows[0], time: now() });
  } catch (e) {
    res.status(500).json({ error: 'Lease recovery failed' });
  }
};
app.route('/api/cron/recovery').get(recoverCronLeases).post(recoverCronLeases);

// Process durable post-CI managed deployment events. Supabase Cron invokes this endpoint
// every minute on Hobby deployments; standalone mode also runs its own bounded queue poller.
const processManagedDeploymentCron = async (req, res) => {
  const cronSecret = process.env.KESTREL_CRON_SECRET || process.env.CRON_SECRET;
  if (!cronSecret) return res.status(503).json({ error: 'Cron authentication is not configured' });
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized cron request' });
  }
  try {
    const result = await processManagedHostingQueue({ query, transaction, logger: console }, 1);
    const readiness = await reconcileManagedDeploymentReadiness({ query, logger: console }, 10);
    res.json({ ok: true, ...result, readiness, time: now() });
  } catch (error) {
    console.error('Managed deployment cron failed:', { message: error?.message });
    res.status(500).json({ error: 'Managed deployment queue processing failed' });
  }
};
app.route('/api/cron/managed-deployments').get(processManagedDeploymentCron).post(processManagedDeploymentCron);

// Private project file storage endpoints; membership is checked on every request.
registerProjectFileRoutes(app, { userAuth, workerAuth, query });
registerArtifactRoutes(app, { userAuth, workerAuth, query });
registerDeploymentRoutes(app, { userAuth, query, transaction });
registerComputeRoutes(app, { userAuth, platformAdmin, query, transaction });
registerSandboxRoutes(app, { userAuth, platformAdmin, query, transaction });
registerGitImportRoutes(app, { userAuth, query, transaction });
registerGitHubAppRoutes(app, { userAuth, query, transaction });
registerHostingRoutes(app, { userAuth, query });
registerHostingConnectionRoutes(app, { userAuth, query, transaction });
registerManagedDeploymentRoutes(app, { userAuth, query, transaction });

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
    } catch (error) {
      // Do not run a weaker fallback that can bypass retry limits or dependency recovery.
      console.error('Scheduled worker recovery failed:', error.message);
    }
  }, 5000).unref();

  const stopManagedHostingAutomation = startManagedHostingAutomation({ query, transaction, logger: console });
  const server = app.listen(port, '0.0.0.0', () =>
    console.log(`Kestrel control plane listening on :${port}`)
  );

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Kestrel control plane received ${signal}; beginning graceful shutdown.`);
    clearInterval(recovery);

    const forceCloseTimer = setTimeout(() => {
      console.error('Control plane graceful shutdown deadline reached; closing remaining HTTP connections.');
      server.closeAllConnections?.();
    }, Math.max(1000, Number(process.env.KESTREL_SHUTDOWN_TIMEOUT_MS || 25000)));
    forceCloseTimer.unref?.();

    // Stop accepting new requests immediately, while allowing in-flight HTTP
    // requests and the current provider operation to finish using the DB pool.
    const httpDrain = new Promise((resolve) => {
      server.close((error) => {
        if (error) console.error('HTTP server close reported an error:', error.message);
        resolve();
      });
    });

    try {
      await stopManagedHostingAutomation();
      await httpDrain;
      await pool.end();
      console.info('Kestrel control plane shutdown completed.');
    } catch (error) {
      console.error('Kestrel control plane shutdown failed:', error?.message);
      process.exitCode = 1;
    } finally {
      clearTimeout(forceCloseTimer);
    }
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}