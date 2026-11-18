import express from 'express';

const BUCKET = 'kestrel-project-files';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function cleanRelativePath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw.length > 1024 || raw.startsWith('/') || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 255)) return null;
  return parts.join('/');
}

function storageConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Project file storage is not configured');
  return { url: url.replace(/\/$/, ''), key };
}

async function storageRequest(path, options = {}) {
  const { url, key } = storageConfig();
  const response = await fetch(`${url}/storage/v1${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(options.body && !(options.body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || 'Storage operation failed');
    error.status = response.status;
    throw error;
  }
  return data;
}

export function registerProjectFileRoutes(app, { userAuth, query }) {
  async function projectAccess(req, res, write = false) {
    const result = await query(
      `select p.organization_id, m.role
       from public.projects p
       join public.organization_members m on m.organization_id = p.organization_id
       where p.id = $1 and m.user_id = $2`,
      [req.params.projectId, req.user.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    if (write && !['owner', 'admin', 'developer'].includes(result.rows[0].role)) {
      res.status(403).json({ error: 'Developer access required to change project files' });
      return null;
    }
    return result.rows[0];
  }

  app.get('/api/projects/:projectId/files', userAuth, async (req, res) => {
    try {
      const access = await projectAccess(req, res);
      if (!access) return;
      const folder = req.query.path ? cleanRelativePath(req.query.path) : '';
      if (req.query.path && !folder) return res.status(400).json({ error: 'Invalid folder path' });
      const prefix = [access.organization_id, req.params.projectId, folder].filter(Boolean).join('/');
      const entries = await storageRequest(`/object/list/${BUCKET}`, {
        method: 'POST',
        body: JSON.stringify({ prefix, limit: 500, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
      });
      res.json({ files: (entries || []).map((entry) => ({
        name: entry.name,
        isFolder: !entry.id && !entry.metadata,
        sizeBytes: entry.metadata?.size ?? null,
        contentType: entry.metadata?.mimetype ?? null,
        updatedAt: entry.updated_at || entry.created_at || null,
      })) });
    } catch (error) {
      console.error('Project file listing failed:', error.message);
      res.status(error.status || 503).json({ error: error.message || 'Could not list project files' });
    }
  });

  app.put('/api/projects/:projectId/files', userAuth, express.raw({ type: 'application/octet-stream', limit: MAX_FILE_BYTES }), async (req, res) => {
    try {
      const access = await projectAccess(req, res, true);
      if (!access) return;
      const relativePath = cleanRelativePath(req.query.path);
      if (!relativePath) return res.status(400).json({ error: 'A safe relative file path is required' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'File is empty or missing' });
      const objectKey = [access.organization_id, req.params.projectId, relativePath].join('/');
      await storageRequest(`/object/${BUCKET}/${objectKey.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST',
        body: req.body,
        headers: {
          'Content-Type': String(req.headers['x-file-content-type'] || 'application/octet-stream').slice(0, 150),
          'x-upsert': 'true',
        },
      });
      res.status(201).json({ ok: true, path: relativePath, sizeBytes: req.body.length });
    } catch (error) {
      console.error('Project file upload failed:', error.message);
      res.status(error.status || 503).json({ error: error.message || 'Could not upload project file' });
    }
  });

  app.post('/api/projects/:projectId/files/download', userAuth, async (req, res) => {
    try {
      const access = await projectAccess(req, res);
      if (!access) return;
      const relativePath = cleanRelativePath(req.body?.path);
      if (!relativePath) return res.status(400).json({ error: 'Invalid file path' });
      const objectKey = [access.organization_id, req.params.projectId, relativePath].join('/');
      const signed = await storageRequest(`/object/sign/${BUCKET}/${objectKey.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST',
        body: JSON.stringify({ expiresIn: 60 }),
      });
      const { url } = storageConfig();
      const signedUrl = signed?.signedURL || signed?.signedUrl;
      if (!signedUrl) return res.status(502).json({ error: 'Storage did not return a download link' });
      res.json({ url: signedUrl.startsWith('http') ? signedUrl : `${url}/storage/v1${signedUrl.startsWith('/') ? '' : '/'}${signedUrl}` });
    } catch (error) {
      console.error('Project file download signing failed:', error.message);
      res.status(error.status || 503).json({ error: error.message || 'Could not prepare file download' });
    }
  });

  app.delete('/api/projects/:projectId/files', userAuth, async (req, res) => {
    try {
      const access = await projectAccess(req, res, true);
      if (!access) return;
      const relativePath = cleanRelativePath(req.query.path);
      if (!relativePath) return res.status(400).json({ error: 'Invalid file path' });
      const objectKey = [access.organization_id, req.params.projectId, relativePath].join('/');
      await storageRequest(`/object/${BUCKET}/${objectKey.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
      res.json({ ok: true, path: relativePath });
    } catch (error) {
      console.error('Project file deletion failed:', error.message);
      res.status(error.status || 503).json({ error: error.message || 'Could not delete project file' });
    }
  });
}
