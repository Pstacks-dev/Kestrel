import crypto from 'node:crypto';

export async function deployNetlifyArtifacts({ siteId, token, branch, commitSha, runId, environment = 'production', query, supabaseAdmin, bucket }) {
  if (!supabaseAdmin) throw new Error('Private artifact storage is not configured for Netlify deployments.');
  const result = await query(
    "select name,object_key,content_type,size_bytes from public.artifacts where run_id=$1 and uploaded_at is not null and (name like 'dist/%' or name like 'build/%') order by name",
    [runId]
  );
  if (!result.rowCount) throw new Error('This run has no uploaded dist/ or build/ files. Netlify needs compiled site output.');

  if (result.rowCount > 100) throw new Error('Netlify releases are limited to 100 uploaded files.');
  const declaredBytes = result.rows.reduce((total, artifact) => total + Number(artifact.size_bytes || 0), 0);
  if (declaredBytes > 300 * 1024 * 1024) throw new Error('Netlify release exceeds the 300 MiB deployment transfer limit.');
  const files = {};
  const bytesByPath = new Map();
  for (const artifact of result.rows) {
    const relative = artifact.name.replace(/^(dist|build)\//, '');
    if (!relative || relative.split('/').some((part) => part === '..' || part === '.')) throw new Error('Unsafe Netlify artifact path.');
    const destination = '/' + relative.replace(/^\/+/, '');
    const downloaded = await supabaseAdmin.storage.from(bucket).download(artifact.object_key);
    if (downloaded.error) throw downloaded.error;
    const bytes = Buffer.from(await downloaded.data.arrayBuffer());
    files[destination] = crypto.createHash('sha1').update(bytes).digest('hex');
    bytesByPath.set(destination, { bytes, contentType: artifact.content_type || 'application/octet-stream' });
  }

  const response = await fetch('https://api.netlify.com/api/v1/sites/' + encodeURIComponent(siteId) + '/deploys', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files,
      branch,
      title: 'Kestrel release ' + String(commitSha).slice(0, 8),
      draft: environment === 'preview'
    }),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(String(body.message || body.error || ('Netlify returned HTTP ' + response.status)).slice(0, 1000));
  if (!body.id) throw new Error('Netlify did not return a deployment ID.');

  const required = Array.isArray(body.required) ? body.required : Object.keys(body.required || {});
  for (const rawPath of required) {
    const filePath = String(rawPath).startsWith('/') ? String(rawPath) : '/' + String(rawPath);
    const file = bytesByPath.get(filePath);
    if (!file) throw new Error('Netlify requested a file not included in the successful run: ' + filePath);
    const encodedPath = filePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const upload = await fetch('https://api.netlify.com/api/v1/deploys/' + encodeURIComponent(body.id) + '/files/' + encodedPath, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': file.contentType },
      body: file.bytes,
      signal: AbortSignal.timeout(30000)
    });
    if (!upload.ok) throw new Error('Netlify rejected ' + filePath + ' (HTTP ' + upload.status + ').');
  }

  return {
    id: body.id,
    url: body.ssl_url || body.url || body.deploy_url || null,
    state: body.state || body.status || 'building'
  };
}
