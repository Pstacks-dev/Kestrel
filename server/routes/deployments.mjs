import crypto from 'node:crypto';

const MEMBER_ROLES = ['owner', 'admin', 'developer'];
const IMAGE_RE = /^(?=.{1,255}$)(?:[a-zA-Z0-9.-]+(?::[0-9]{1,5})?\/)?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-fA-F0-9]{64})?$/;

function fail(res, status, error) {
  return res.status(status).json({ error });
}

export function validPublicUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

export function validHealthCheckType(value) { return value === 'http' || value === 'tcp'; }

export function validHealthPath(value) {
  return typeof value === 'string' && value.startsWith('/') &&
    value.length <= 256 && !value.includes('..') &&
    /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(value);
}

export function validImage(value) {
  return typeof value === 'string' && IMAGE_RE.test(value) && !value.includes('..') && !value.includes('\\');
}

export function workerCanAcceptDeployments(state, lastSeenAt, now = Date.now()) {
  const heartbeat = Date.parse(lastSeenAt || '');
  return ['online', 'busy'].includes(state) && Number.isFinite(heartbeat) &&
    heartbeat <= now + 5_000 && now - heartbeat <= 45_000;
}

async function queueRelease({ query, transaction, environmentId, userId, image, rollbackOf = null }) {
  return transaction(async (c) => {
    const envResult = await c.query(
      `select e.*, p.organization_id, p.id as project_id, p.name as project_name,
              w.runtime, w.state as worker_state, w.last_seen_at,
              current_release.image as current_image,
              current_release.container_name as current_container_name
       from public.deployment_environments e
       join public.projects p on p.id = e.project_id
       join public.workers w on w.id = e.worker_id
       left join public.deployment_releases current_release on current_release.id = e.current_release_id
       join public.organization_members m on m.organization_id = p.organization_id
       where e.id = $1 and m.user_id = $2 and m.role = any($3)
       for update of e`,
      [environmentId, userId, MEMBER_ROLES]
    );
    if (!envResult.rowCount) throw Object.assign(new Error('Deployment environment not found or access denied'), { status: 404 });
    const env = envResult.rows[0];
    if (env.runtime !== 'rust') throw Object.assign(new Error('This environment must be assigned to a Rust execution worker'), { status: 409 });
    if (!workerCanAcceptDeployments(env.worker_state, env.last_seen_at)) {
      throw Object.assign(new Error('The assigned worker is offline, draining, or has a stale heartbeat'), { status: 409 });
    }
    if (env.environment_key === 'production' && !/@sha256:[a-fA-F0-9]{64}$/.test(image)) {
      throw Object.assign(new Error('Production releases must use an immutable image SHA-256 digest'), { status: 400 });
    }
    const pending = await c.query(
      "select id from public.deployment_releases where environment_id = $1 and status in ('queued', 'deploying') limit 1",
      [environmentId]
    );
    if (pending.rowCount) throw Object.assign(new Error('A deployment is already queued or running for this environment'), { status: 409 });

    await c.query('select id from public.projects where id = $1 for update', [env.project_id]);
    const runNumber = await c.query(
      'select coalesce(max(run_number), 0) + 1 as n from public.pipeline_runs where project_id = $1',
      [env.project_id]
    );
    const run = await c.query(
      `insert into public.pipeline_runs(project_id, run_number, branch, commit_message, status, triggered_by)
       values($1, $2, $3, $4, 'queued', $5) returning id, run_number`,
      [env.project_id, runNumber.rows[0].n, env.environment_key, (rollbackOf ? 'Rollback' : 'Deploy') + ' ' + image, userId]
    );

    const releaseNumber = await c.query(
      'select coalesce(max(release_number), 0) + 1 as n from public.deployment_releases where environment_id = $1',
      [environmentId]
    );
    const releaseId = crypto.randomUUID();
    const containerName = 'kestrel-' + environmentId.replace(/-/g, '').slice(0, 12) + '-r' + releaseNumber.rows[0].n;
    await c.query(
      `insert into public.deployment_releases
       (id, environment_id, release_number, image, container_name, status, previous_release_id, rollback_of, pipeline_run_id, worker_id, created_by)
       values($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10)`,
      [releaseId, environmentId, releaseNumber.rows[0].n, image, containerName,
       env.current_release_id, rollbackOf, run.rows[0].id, env.worker_id, userId]
    );
    await c.query(
      `insert into public.jobs
       (run_id, external_id, name, stage, command, needs, status, timeout_seconds, max_retries,
        job_type, deployment_environment_id, deployment_release_id)
       values($1, $2, $3, 'deploy', 'kestrel-deploy', '{}', 'queued', $4, 1, 'deployment', $5, $6)`,
      [run.rows[0].id, 'release-' + releaseNumber.rows[0].n,
       'Deploy release #' + releaseNumber.rows[0].n, env.health_timeout_seconds + 180,
       environmentId, releaseId]
    );
    return {
      id: releaseId,
      releaseNumber: Number(releaseNumber.rows[0].n),
      runId: run.rows[0].id,
      runNumber: Number(run.rows[0].run_number),
      status: 'queued',
      image,
      workerId: env.worker_id,
      publicUrl: env.public_url || null,
    };
  });
}

export function registerDeploymentRoutes(app, { userAuth, query, transaction }) {
  app.get('/api/projects/:projectId/deployments', userAuth, async (req, res) => {
    try {
      const access = await query(
        `select p.id from public.projects p
         join public.organization_members m on m.organization_id = p.organization_id
         where p.id = $1 and m.user_id = $2`,
        [req.params.projectId, req.user.id]
      );
      if (!access.rowCount) return fail(res, 404, 'Project not found');
      const environments = await query(
        `select e.id, e.name, e.environment_key as "environmentKey", e.worker_id as "workerId",
                e.host_port as "hostPort", e.container_port as "containerPort",
                e.health_path as "healthPath", e.health_check_type as "healthCheckType", e.health_timeout_seconds as "healthTimeoutSeconds",
                e.public_url as "publicUrl", e.current_release_id as "currentReleaseId",
                w.hostname as "workerName", w.state as "workerState", w.runtime,
                current_release.release_number as "currentReleaseNumber",
                current_release.image as "currentImage", current_release.status as "currentReleaseStatus",
                current_release.health_checked_at as "lastHealthCheck", current_release.error_message as "lastHealthError",
                pending_release.status as "pendingReleaseStatus", e.created_at as "createdAt"
         from public.deployment_environments e
         join public.workers w on w.id = e.worker_id
         left join public.deployment_releases current_release on current_release.id = e.current_release_id
         left join lateral (select status from public.deployment_releases pr where pr.environment_id = e.id and pr.status in ('queued','deploying') order by pr.release_number desc limit 1) pending_release on true
         where e.project_id = $1 order by e.created_at asc`,
        [req.params.projectId]
      );
      res.json({ environments: environments.rows });
    } catch (error) {
      res.status(500).json({ error: 'Could not load deployment environments' });
    }
  });

  app.post('/api/projects/:projectId/deployments', userAuth, async (req, res) => {
    const {
      name, environmentKey, workerId, hostPort, containerPort = 3000,
      healthPath = '/', healthCheckType = 'http', healthTimeoutSeconds = 60, publicUrl = null, secretNames = [],
    } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80) return fail(res, 400, 'Environment name must be 1-80 characters');
    if (!['development', 'staging', 'production', 'preview'].includes(environmentKey)) return fail(res, 400, 'Invalid environment type');
    if (!Number.isInteger(Number(hostPort)) || Number(hostPort) < 1024 || Number(hostPort) > 65535) return fail(res, 400, 'Host port must be between 1024 and 65535');
    if (!Number.isInteger(Number(containerPort)) || Number(containerPort) < 1 || Number(containerPort) > 65535) return fail(res, 400, 'Container port must be between 1 and 65535');
    if (!validHealthCheckType(healthCheckType)) return fail(res, 400, 'Health check type must be HTTP or TCP');
    if (healthCheckType === 'http' && !validHealthPath(healthPath)) return fail(res, 400, 'Health path must be a safe absolute URL path');
    if (!Number.isInteger(Number(healthTimeoutSeconds)) || Number(healthTimeoutSeconds) < 5 || Number(healthTimeoutSeconds) > 300) return fail(res, 400, 'Health timeout must be between 5 and 300 seconds');
    const normalizedUrl = publicUrl ? validPublicUrl(publicUrl) : null;
    if (publicUrl && !normalizedUrl) return fail(res, 400, 'Public URL must be a valid HTTP or HTTPS URL without credentials');
    if (!Array.isArray(secretNames) || secretNames.length > 50 || secretNames.some((v) => typeof v !== 'string' || !/^[A-Za-z0-9_]{1,128}$/.test(v))) {
      return fail(res, 400, 'Secret names must be valid environment variable names');
    }

    try {
      const project = await query(
        `select p.organization_id, m.role from public.projects p
         join public.organization_members m on m.organization_id = p.organization_id
         where p.id = $1 and m.user_id = $2`,
        [req.params.projectId, req.user.id]
      );
      if (!project.rowCount) return fail(res, 404, 'Project not found');
      if (!MEMBER_ROLES.includes(project.rows[0].role)) return fail(res, 403, 'You cannot manage deployments for this project');
      const worker = await query(
        `select id from public.workers where id = $1 and organization_id = $2 and runtime = 'rust'`,
        [workerId, project.rows[0].organization_id]
      );
      if (!worker.rowCount) return fail(res, 400, 'Choose a Rust worker belonging to this workspace');
      if (secretNames.length) {
        const secrets = await query('select name from public.project_secrets where project_id = $1 and name = any($2::text[])', [req.params.projectId, secretNames]);
        if (secrets.rowCount !== new Set(secretNames).size) return fail(res, 400, 'One or more deployment secrets do not exist in this project');
      }
      const result = await query(
        `insert into public.deployment_environments
         (project_id, name, environment_key, worker_id, host_port, container_port, health_path, health_check_type,
          health_timeout_seconds, public_url, secret_names, created_by)
         values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         returning id, name, environment_key as "environmentKey", worker_id as "workerId",
                   host_port as "hostPort", container_port as "containerPort", public_url as "publicUrl"`,
        [req.params.projectId, name.trim(), environmentKey, workerId, Number(hostPort), Number(containerPort),
         healthPath, healthCheckType, Number(healthTimeoutSeconds), normalizedUrl, secretNames, req.user.id]
      );
      res.status(201).json({ environment: result.rows[0] });
    } catch (error) {
      res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'This project environment or worker port is already configured' : 'Could not create deployment environment' });
    }
  });

  app.get('/api/deployments/:environmentId/releases', userAuth, async (req, res) => {
    try {
      const access = await query(
        `select e.id from public.deployment_environments e
         join public.projects p on p.id = e.project_id
         join public.organization_members m on m.organization_id = p.organization_id
         where e.id = $1 and m.user_id = $2`,
        [req.params.environmentId, req.user.id]
      );
      if (!access.rowCount) return fail(res, 404, 'Deployment environment not found');
      const result = await query(
        `select r.id, r.release_number as "releaseNumber", r.image, r.container_name as "containerName",
                r.status, r.previous_release_id as "previousReleaseId", r.rollback_of as "rollbackOf",
                r.health_checked_at as "healthCheckedAt", r.error_message as "errorMessage",
                r.created_at as "createdAt", r.deployed_at as "deployedAt", r.pipeline_run_id as "runId"
         from public.deployment_releases r
         where r.environment_id = $1 order by r.release_number desc limit 100`,
        [req.params.environmentId]
      );
      res.json({ releases: result.rows });
    } catch (error) {
      res.status(500).json({ error: 'Could not load release history' });
    }
  });

  app.get('/api/deployments/:environmentId/health', userAuth, async (req, res) => {
    try {
      const result = await query(
        `select e.id, e.public_url as "publicUrl", e.host_port as "hostPort",
                r.status as "releaseStatus", r.health_checked_at as "lastCheckedAt",
                r.error_message as "errorMessage", r.release_number as "releaseNumber",
                w.state as "workerState", w.last_seen_at as "workerLastSeenAt"
         from public.deployment_environments e
         join public.projects p on p.id = e.project_id
         join public.organization_members m on m.organization_id = p.organization_id
         join public.workers w on w.id = e.worker_id
         left join public.deployment_releases r on r.id = e.current_release_id
         where e.id = $1 and m.user_id = $2`,
        [req.params.environmentId, req.user.id]
      );
      if (!result.rowCount) return fail(res, 404, 'Deployment environment not found');
      const health = result.rows[0];
      res.json({ ...health, healthy: health.releaseStatus === 'healthy' });
    } catch (error) {
      res.status(500).json({ error: 'Could not read deployment health' });
    }
  });

  app.post('/api/deployments/:environmentId/releases', userAuth, async (req, res) => {
    const image = String(req.body?.image || '').trim();
    if (!validImage(image)) return fail(res, 400, 'Enter a valid container image reference, including an optional tag or SHA-256 digest');
    try {
      const release = await queueRelease({ transaction, environmentId: req.params.environmentId, userId: req.user.id, image });
      res.status(202).json({ release });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message || 'Could not queue deployment' });
    }
  });

  app.post('/api/deployments/:environmentId/rollback', userAuth, async (req, res) => {
    try {
      const target = await query(
        `select current_release.id, current_release.previous_release_id,
                previous_release.image as previous_image
         from public.deployment_environments e
         join public.projects p on p.id = e.project_id
         join public.organization_members m on m.organization_id = p.organization_id
         join public.deployment_releases current_release on current_release.id = e.current_release_id
         left join public.deployment_releases previous_release on previous_release.id = current_release.previous_release_id
         where e.id = $1 and m.user_id = $2 and m.role = any($3)`,
        [req.params.environmentId, req.user.id, MEMBER_ROLES]
      );
      if (!target.rowCount) return fail(res, 404, 'No current deployment or permission to roll back');
      if (!target.rows[0].previous_release_id || !target.rows[0].previous_image) return fail(res, 409, 'There is no previous healthy release to roll back to');
      const release = await queueRelease({
        transaction, environmentId: req.params.environmentId, userId: req.user.id,
        image: target.rows[0].previous_image, rollbackOf: target.rows[0].previous_release_id,
      });
      res.status(202).json({ release });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message || 'Could not queue rollback' });
    }
  });
}
