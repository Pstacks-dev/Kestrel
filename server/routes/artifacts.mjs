import crypto from 'node:crypto';

const BUCKET = 'kestrel-artifacts';
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

function retentionDays() {
  const raw = Number.parseInt(process.env.KESTREL_ARTIFACT_RETENTION_DAYS || '', 10);
  return Number.isInteger(raw) && raw >= 1 && raw <= 3650 ? raw : null;
}

export function validArtifactName(name) {
  if (typeof name !== 'string' || !name || name.length > 512 || name.startsWith('/') || name.includes('\\')) return false;
  return name.split('/').every((part) => part && part !== '.' && part !== '..' && !/[\u0000-\u001f]/.test(part));
}

function storageConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Artifact storage is not configured');
  return { url: url.replace(/\/$/, ''), key };
}

async function storageRequest(path, options = {}) {
  const { url, key } = storageConfig();
  const response = await fetch(`${url}/storage/v1${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...options.headers },
  });
  const body = await response.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  if (!response.ok) throw Object.assign(new Error(data?.message || 'Artifact storage failed'), { status: response.status });
  return data;
}

async function removeStoredObject(objectKey) {
  const key = objectKey.split('/').map(encodeURIComponent).join('/');
  try {
    await storageRequest('/object/' + BUCKET + '/' + key, { method: 'DELETE' });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

export function registerArtifactRoutes(app, { userAuth, workerAuth, query }) {
  app.post('/api/workers/jobs/:jobId/artifacts/upload-url', workerAuth, async (req, res) => {
    try {
      const lease = String(req.get('x-kestrel-lease') || req.body?.leaseToken || '');
      const name = String(req.body?.name || '');
      const sizeBytes = Number(req.body?.sizeBytes);
      const sha256 = String(req.body?.sha256 || '').toLowerCase();
      const contentType = String(req.body?.contentType || 'application/octet-stream').slice(0, 120);
      if (!validArtifactName(name)) return res.status(400).json({ error: 'Artifact name must be a safe relative file path' });
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ARTIFACT_BYTES) {
        return res.status(413).json({ error: 'Artifact must be between 1 byte and 100 MiB' });
      }
      if (!/^[a-f0-9]{64}$/.test(sha256)) return res.status(400).json({ error: 'A SHA-256 digest is required' });
      const run = await query(
        `select j.run_id, p.organization_id
         from public.jobs j join public.pipeline_runs r on r.id = j.run_id
         join public.projects p on p.id = r.project_id
         where j.id = $1 and j.lease_token = $2 and j.worker_id = $3
           and j.status = 'running' and j.lease_expires_at > now()`,
        [req.params.jobId, lease, req.worker.id]
      );
      if (!run.rowCount) return res.status(409).json({ error: 'Job lease is invalid or expired' });
      const objectKey = run.rows[0].organization_id + '/' + run.rows[0].run_id + '/' + crypto.randomUUID() + '-' + name;
      const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
      const signed = await storageRequest('/object/upload/sign/' + BUCKET + '/' + encodedKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upsert: false }),
      });
      const signedPath = signed?.url || signed?.signedURL || signed?.signedUrl;
      const { url } = storageConfig();
      let uploadUrl;
      if (typeof signedPath === 'string' && signedPath.startsWith('http')) uploadUrl = signedPath;
      else if (typeof signedPath === 'string') uploadUrl = url + (signedPath.startsWith('/storage/v1') ? signedPath : '/storage/v1' + (signedPath.startsWith('/') ? '' : '/') + signedPath);
      else if (signed?.token) uploadUrl = url + '/storage/v1/object/upload/sign/' + BUCKET + '/' + encodedKey + '?token=' + encodeURIComponent(signed.token);
      if (!uploadUrl) throw new Error('Storage did not return a signed upload URL');
      const session = await query(
        `insert into public.artifact_upload_sessions(job_id, worker_id, object_key, name, size_bytes, sha256, content_type)
         values($1, $2, $3, $4, $5, $6, $7)
         returning id, expires_at`,
        [req.params.jobId, req.worker.id, objectKey, name, sizeBytes, sha256, contentType]
      );
      res.status(201).json({ sessionId: session.rows[0].id, uploadUrl, expiresAt: session.rows[0].expires_at });
    } catch (error) {
      console.error('Artifact upload URL creation failed:', error.message);
      res.status(error.status || 500).json({ error: 'Could not create artifact upload URL' });
    }
  });

  app.post('/api/workers/jobs/:jobId/artifacts/finalize', workerAuth, async (req, res) => {
    try {
      const lease = String(req.get('x-kestrel-lease') || req.body?.leaseToken || '');
      const session = await query(
        `select s.*, j.run_id, p.organization_id
         from public.artifact_upload_sessions s
         join public.jobs j on j.id = s.job_id
         join public.pipeline_runs r on r.id = j.run_id
         join public.projects p on p.id = r.project_id
         where s.id = $1 and s.job_id = $2 and s.worker_id = $3
           and j.lease_token = $4 and j.worker_id = $3 and j.status = 'running'
           and j.lease_expires_at > now() and s.expires_at > now()`,
        [req.body?.sessionId, req.params.jobId, req.worker.id, lease]
      );
      if (!session.rowCount) return res.status(409).json({ error: 'Artifact upload session or job lease is invalid or expired' });
      const row = session.rows[0];
      const encodedKey = row.object_key.split('/').map(encodeURIComponent).join('/');
      const info = await storageRequest('/object/info/' + BUCKET + '/' + encodedKey);
      const actualSize = Number(info?.metadata?.size ?? info?.metadata?.contentLength ?? info?.size);
      if (!Number.isSafeInteger(actualSize) || actualSize !== Number(row.size_bytes)) {
        return res.status(409).json({ error: 'Uploaded artifact size does not match its upload session' });
      }
      const retention = retentionDays();
      const artifact = await query(
        `insert into public.artifacts(run_id, name, object_key, size_bytes, sha256, content_type, expires_at)
         values($1, $2, $3, $4, $5, $6, case when $7::int is null then null else now() + make_interval(days => $7::int) end)
         returning id, name, size_bytes, sha256, created_at, expires_at`,
        [row.run_id, row.name, row.object_key, row.size_bytes, row.sha256, row.content_type, retention]
      );
      await query('delete from public.artifact_upload_sessions where id = $1', [row.id]);
      res.status(201).json({ artifact: artifact.rows[0] });
    } catch (error) {
      console.error('Artifact finalization failed:', error.message);
      res.status(error.status || 500).json({ error: 'Could not finalize uploaded artifact' });
    }
  });

  app.get('/api/runs/:runId/artifacts', userAuth, async (req, res) => {
    try {
      const access = await query(
        `select r.id from public.pipeline_runs r join public.projects p on p.id = r.project_id
         join public.organization_members m on m.organization_id = p.organization_id
         where r.id = $1 and m.user_id = $2`,
        [req.params.runId, req.user.id]
      );
      if (!access.rowCount) return res.status(404).json({ error: 'Pipeline run not found' });
      const result = await query(
        'select id, name, size_bytes as "sizeBytes", sha256, content_type as "contentType", created_at as "createdAt", expires_at as "expiresAt" from public.artifacts where run_id = $1 and deleted_at is null order by created_at desc',
        [req.params.runId]
      );
      res.json({ artifacts: result.rows });
    } catch (error) {
      res.status(500).json({ error: 'Could not list artifacts' });
    }
  });

  app.get('/api/artifacts/:artifactId/download', userAuth, async (req, res) => {
    try {
      const result = await query(
        `select a.object_key, a.name from public.artifacts a
         join public.pipeline_runs r on r.id = a.run_id
         join public.projects p on p.id = r.project_id
         join public.organization_members m on m.organization_id = p.organization_id
         where a.id = $1 and m.user_id = $2 and a.deleted_at is null and (a.expires_at is null or a.expires_at > now())`,
        [req.params.artifactId, req.user.id]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Artifact not found' });
      const key = result.rows[0].object_key.split('/').map(encodeURIComponent).join('/');
      const signed = await storageRequest(`/object/sign/${BUCKET}/${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 120 }),
      });
      const { url } = storageConfig();
      const path = signed?.signedURL || signed?.signedUrl;
      if (!path) throw new Error('Storage did not return a signed download URL');
      await query('update public.artifacts set download_count = download_count + 1 where id = $1', [req.params.artifactId]);
      res.json({ url: path.startsWith('http') ? path : `${url}/storage/v1${path.startsWith('/') ? '' : '/'}${path}`, name: result.rows[0].name });
    } catch (error) {
      res.status(error.status || 500).json({ error: 'Could not create artifact download link' });
    }
  });

  app.delete('/api/artifacts/:artifactId', userAuth, async (req, res) => {
    try {
      const result = await query(`select a.id, a.object_key, a.name, p.organization_id, m.role
        from public.artifacts a join public.pipeline_runs r on r.id = a.run_id
        join public.projects p on p.id = r.project_id
        join public.organization_members m on m.organization_id = p.organization_id
        where a.id = $1 and m.user_id = $2 and a.deleted_at is null`, [req.params.artifactId, req.user.id]);
      if (!result.rowCount) return res.status(404).json({ error: 'Artifact not found' });
      if (!['owner', 'admin', 'developer'].includes(result.rows[0].role)) return res.status(403).json({ error: 'You do not have permission to delete artifacts' });
      await removeStoredObject(result.rows[0].object_key);
      await query('delete from public.artifacts where id = $1', [req.params.artifactId]);
      await query(`insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
        values($1, $2, 'artifact.deleted', 'artifact', $3, $4::jsonb)`,
        [result.rows[0].organization_id, req.user.id, req.params.artifactId, JSON.stringify({ name: result.rows[0].name })]);
      res.json({ ok: true });
    } catch (error) { res.status(error.status || 500).json({ error: 'Could not delete artifact' }); }
  });

  app.post('/api/cron/artifacts/cleanup', async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return res.status(503).json({ error: 'Artifact cleanup cron is not configured' });
    if (req.headers.authorization !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const expiredSessions = await query(
        'select id, object_key from public.artifact_upload_sessions where expires_at <= now() order by expires_at asc limit 100'
      );
      let expiredUploadsRemoved = 0;
      for (const session of expiredSessions.rows) {
        try {
          await removeStoredObject(session.object_key);
          await query('delete from public.artifact_upload_sessions where id = $1', [session.id]);
          expiredUploadsRemoved += 1;
        } catch (error) {
          console.error('Expired artifact upload cleanup failed:', { sessionId: session.id, message: error.message });
        }
      }
      const expired = await query(`select id, object_key from public.artifacts
        where expires_at is not null and expires_at <= now() order by expires_at asc limit 100`);
      let deleted = 0;
      for (const artifact of expired.rows) {
        try {
          await removeStoredObject(artifact.object_key);
          await query('delete from public.artifacts where id = $1 and expires_at <= now()', [artifact.id]);
          deleted += 1;
        } catch (error) { console.error('Expired artifact cleanup failed:', { artifactId: artifact.id, message: error.message }); }
      }
      res.json({ ok: true, deleted, expiredUploadsRemoved, remainingBatch: expired.rowCount - deleted });
    } catch (error) { res.status(500).json({ error: 'Artifact cleanup failed' }); }
  });
}
