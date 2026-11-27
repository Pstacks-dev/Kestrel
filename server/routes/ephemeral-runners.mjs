import crypto from 'node:crypto';

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export function isEphemeralRunnerAuthorized(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length < 32) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function runnerSecret(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

export function registerEphemeralRunnerRoutes(app, { query, transaction }) {
  // This endpoint is called only by the protected workflow in the Kestrel repository.
  // It returns a one-time worker credential only when a runnable job is waiting and
  // no healthy persistent worker is available for that workspace.
  app.post('/api/runners/provision', async (req, res) => {
    const expected = process.env.KESTREL_EPHEMERAL_RUNNER_SECRET || '';
    if (!expected || expected.length < 32) return res.status(503).json({ error: 'Ephemeral runner provisioning is not configured' });
    if (!isEphemeralRunnerAuthorized(runnerSecret(req), expected)) return res.status(401).json({ error: 'Runner authentication failed' });

    try {
      const provisioned = await transaction(async (client) => {
        const runId = String(req.body?.workflowRunId || '');
        const workflowRunId = /^\d{1,24}$/.test(runId) ? runId : null;
        await client.query(
          `insert into public.execution_backend_heartbeats(backend, last_seen_at, last_result, workflow_run_id, updated_at)
           values ('github-actions', now(), 'polling', $1, now())
           on conflict (backend) do update set
             last_seen_at = now(), last_result = 'polling',
             workflow_run_id = excluded.workflow_run_id, updated_at = now()`,
          [workflowRunId],
        );
        // Expire old ephemeral workers and revoke their credentials before creating another.
        await client.query(
          `update public.workers
           set state = 'offline', desired_state = 'offline'
           where ephemeral = true and expires_at <= now()`,
        );
        await client.query(
          `update public.worker_credentials wc set revoked_at = coalesce(wc.revoked_at, now())
           from public.workers w
           where w.id = wc.worker_id and w.ephemeral = true
             and w.expires_at <= now() and wc.revoked_at is null`,
        );

        const queued = await client.query(
          `select p.organization_id
           from public.jobs j
           join public.pipeline_runs r on r.id = j.run_id
           join public.projects p on p.id = r.project_id
           where j.status = 'queued' and j.available_at <= now()
             and not exists (
               select 1 from public.workers w
               where w.organization_id = p.organization_id
                 and w.desired_state = 'online'
                 and w.state in ('online','busy')
                 and w.last_seen_at >= now() - interval '45 seconds'
             )
           order by j.created_at asc
           limit 1
           for update of j skip locked`,
        );
        if (!queued.rowCount) {
          await client.query("update public.execution_backend_heartbeats set last_result = 'queue_empty', updated_at = now() where backend = 'github-actions'");
          return null;
        }

        const workerId = 'wrk_' + crypto.randomBytes(18).toString('base64url');
        const token = crypto.randomBytes(32).toString('base64url');
        const hostname = String(req.body?.hostname || 'github-hosted-runner').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120) || 'github-hosted-runner';
        await client.query(
          `insert into public.workers
             (id, organization_id, hostname, region, architecture, state, desired_state,
              max_concurrency, last_seen_at, runtime, ephemeral, expires_at)
           values ($1,$2,$3,'github-hosted','linux/amd64','offline','online',1,now(),'node',true,now() + interval '55 minutes')`,
          [workerId, queued.rows[0].organization_id, hostname],
        );
        await client.query(
          'insert into public.worker_credentials(worker_id, token_hash) values($1,$2)',
          [workerId, sha(token)],
        );
        await client.query("update public.execution_backend_heartbeats set last_result = 'worker_provisioned', updated_at = now() where backend = 'github-actions'");
        return { workerId, token };
      });

      if (!provisioned) return res.status(204).end();
      res.set('Cache-Control', 'no-store');
      return res.status(201).json({ ok: true, workerId: provisioned.workerId, token: provisioned.token, maxJobs: 1 });
    } catch (error) {
      console.error('Ephemeral runner provisioning failed:', { message: error?.message });
      return res.status(500).json({ error: 'Could not provision an ephemeral runner' });
    }
  });

  app.post('/api/runners/retire', async (req, res) => {
    const expected = process.env.KESTREL_EPHEMERAL_RUNNER_SECRET || '';
    if (!expected || expected.length < 32) return res.status(503).json({ error: 'Ephemeral runner provisioning is not configured' });
    if (!isEphemeralRunnerAuthorized(runnerSecret(req), expected)) return res.status(401).json({ error: 'Runner authentication failed' });
    const workerId = String(req.body?.workerId || '');
    if (!/^wrk_[A-Za-z0-9_-]{20,40}$/.test(workerId)) return res.status(400).json({ error: 'Invalid ephemeral worker ID' });
    try {
      const retired = await transaction(async (client) => {
        const result = await client.query(
          `update public.workers set state = 'offline', desired_state = 'offline', last_seen_at = now()
           where id = $1 and ephemeral = true returning id`,
          [workerId],
        );
        if (!result.rowCount) return false;
        await client.query(
          'update public.worker_credentials set revoked_at = coalesce(revoked_at, now()) where worker_id = $1',
          [workerId],
        );
        return true;
      });
      return retired ? res.json({ ok: true, retired: true }) : res.status(404).json({ error: 'Ephemeral worker not found' });
    } catch (error) {
      console.error('Ephemeral runner retirement failed:', { message: error?.message });
      return res.status(500).json({ error: 'Could not retire ephemeral runner' });
    }
  });
}
