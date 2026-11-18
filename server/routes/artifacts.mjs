import express from 'express';
import crypto from 'node:crypto';

const BUCKET = 'kestrel-artifacts';
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

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

export function registerArtifactRoutes(app, { userAuth, workerAuth, query }) {
  app.put('/api/workers/jobs/:jobId/artifacts/upload', workerAuth, express.raw({ type: 'application/octet-stream', limit: MAX_ARTIFACT_BYTES }), async (req, res) => {
    try {
      const lease = String(req.get('x-kestrel-lease') || '');
      const name = String(req.get('x-artifact-name') || '').slice(0, 255);
      const run = await query(
        `select j.run_id, p.organization_id
         from public.jobs j join public.pipeline_runs r on r.id = j.run_id
         join public.projects p on p.id = r.project_id
         where j.id = $1 and j.lease_token = $2 and j.worker_id = $3
           and j.status = 'running' and j.lease_expires_at > now()`,
        [req.params.jobId, lease, req.worker.id]
      );
      if (!run.rowCount) return res.status(409).json({ error: 'Job lease is invalid or expired' });
      if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        return res.status(400).json({ error: 'Artifact name must be a simple file name' });
      }
      if (!Buffer.isBuffer(req.body) || !req.body.length || req.body.length > MAX_ARTIFACT_BYTES) {
        return res.status(413).json({ error: 'Artifact must be between 1 byte and 100 MiB' });
      }
      const digest = crypto.createHash('sha256').update(req.body).digest('hex');
      const objectKey = `${run.rows[0].organization_id}/${run.rows[0].run_id}/${crypto.randomUUID()}-${name}`;
      await storageRequest(`/object/${BUCKET}/${objectKey.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }, body: req.body,
      });
      const result = await query(
        `insert into public.artifacts(run_id, name, object_key, size_bytes, sha256, content_type)
         values($1, $2, $3, $4, $5, $6) returning id, name, size_bytes, sha256, created_at`,
        [run.rows[0].run_id, name, objectKey, req.body.length, digest, req.get('x-artifact-content-type') || 'application/octet-stream']
      );
      res.status(201).json({ artifact: result.rows[0] });
    } catch (error) {
      console.error('Artifact upload failed:', error.message);
      res.status(error.status || 500).json({ error: error.message || 'Artifact upload failed' });
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
        'select id, name, size_bytes as "sizeBytes", sha256, content_type as "contentType", created_at as "createdAt" from public.artifacts where run_id = $1 order by created_at desc',
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
         where a.id = $1 and m.user_id = $2`,
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
      res.json({ url: path.startsWith('http') ? path : `${url}/storage/v1${path.startsWith('/') ? '' : '/'}${path}`, name: result.rows[0].name });
    } catch (error) {
      res.status(error.status || 500).json({ error: 'Could not create artifact download link' });
    }
  });
}
