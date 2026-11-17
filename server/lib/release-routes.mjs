import crypto from 'node:crypto';
import { deployNetlifyArtifacts } from './netlify-deploy.mjs';

const BUCKET = 'kestrel-artifacts';
const MAX_BYTES = Math.min(100 * 1024 * 1024, Number(process.env.KESTREL_MAX_ARTIFACT_BYTES || 100 * 1024 * 1024));
const secretName = (id) => 'KESTREL_DEPLOYMENT_' + String(id).replace(/-/g, '').toUpperCase() + '_TOKEN';

function safeName(value) {
  return String(value || '').replace(/\\/g, '/').split('/').filter((part) => part && part !== '.' && part !== '..').join('/').slice(0, 255);
}

function parseProviderState(body) {
  const state = String(body.readyState || body.state || body.phase || body.lifecycle_state || '').toUpperCase();
  if (['READY', 'PUBLISHED', 'LIVE', 'CURRENT'].includes(state)) return 'ready';
  if (['ERROR', 'FAILED', 'CANCELED', 'CANCELLED'].includes(state)) return 'failed';
  return 'deploying';
}

export function registerReleaseRoutes(app, deps) {
  const { userAuth, workerAuth, sensitiveLimiter, query, transaction, encryptSecret, decryptSecret, supabaseAdmin } = deps;

  async function launchDeployment(deploymentId) {
    const loaded = await query(
      'select d.*, t.provider, t.provider_site_id, t.provider_team_id, t.target_environment, p.repository_url, p.name as project_name, src.provider_deployment_id as rollback_provider_id from public.deployments d join public.deployment_targets t on t.id=d.target_id join public.pipeline_runs r on r.id=d.run_id join public.projects p on p.id=r.project_id left join public.deployments src on src.id=d.rollback_source_id where d.id=$1 and t.active=true',
      [deploymentId]
    );
    if (!loaded.rowCount) throw new Error('Deployment target or deployment not found');
    const d = loaded.rows[0];
    const secret = await query(
      'select encrypted_value, iv, auth_tag from public.project_secrets where project_id=(select project_id from public.deployment_targets where id=$1) and name=$2',
      [d.target_id, secretName(d.target_id)]
    );
    if (!secret.rowCount) throw new Error('Provider access token is missing. Reconfigure this deployment target.');
    const token = decryptSecret(secret.rows[0].encrypted_value, secret.rows[0].iv, secret.rows[0].auth_tag);
    if (d.provider === 'netlify' && !d.rollback_provider_id) {
      await query("update public.deployments set status='deploying', error_message=null where id=$1", [deploymentId]);
      try {
        const deployed = await deployNetlifyArtifacts({ siteId: d.provider_site_id, token, branch: d.branch, commitSha: d.commit_sha, runId: d.run_id, environment: d.target_environment, query, supabaseAdmin, bucket: BUCKET });
        const status = parseProviderState(deployed);
        await query("update public.deployments set provider_deployment_id=$2, deployment_url=$3, status=$4, finished_at=case when $4='ready' then now() else null end where id=$1", [deploymentId, deployed.id, deployed.url, status]);
        return { deploymentId, status, providerDeploymentId: deployed.id, deploymentUrl: deployed.url };
      } catch (error) {
        await query("update public.deployments set status='failed', error_message=$2, finished_at=now() where id=$1", [deploymentId, String(error.message || error).slice(0,1000)]);
        throw error;
      }
    }
    let endpoint;
    let payload = {};
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

    if (d.provider === 'vercel') {
      const parsed = new URL(d.repository_url);
      const parts = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
      if (parsed.hostname !== 'github.com' || !parts[0] || !parts[1]) throw new Error('Vercel Git deployments currently require a GitHub repository URL.');
      endpoint = new URL('https://api.vercel.com/v13/deployments');
      if (d.provider_team_id) endpoint.searchParams.set('teamId', d.provider_team_id);
      payload = {
        name: d.project_name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 52) || 'kestrel-project',
        project: d.provider_site_id,
        gitSource: { type: 'github', org: parts[0], repo: parts[1], ref: d.branch, sha: d.commit_sha }
      };
      if (d.target_environment === 'production') payload.target = 'production';
      if (d.rollback_provider_id) payload.meta = { kestrelRollbackFrom: d.rollback_provider_id };
    } else if (d.provider === 'netlify') {
      if (d.rollback_provider_id) {
        endpoint = new URL('https://api.netlify.com/api/v1/sites/' + encodeURIComponent(d.provider_site_id) + '/deploys/' + encodeURIComponent(d.rollback_provider_id) + '/restore');
      } else {
        throw new Error('Netlify artifact deployment adapter was not selected.');
      }
    } else {
      throw new Error('Unsupported deployment provider');
    }

    await query("update public.deployments set status='deploying', error_message=null where id=$1", [deploymentId]);
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 500) }; }
    if (!response.ok) {
      const message = String(body.error?.message || body.message || body.error || ('Provider returned HTTP ' + response.status)).slice(0, 1000);
      await query("update public.deployments set status='failed', error_message=$2, finished_at=now() where id=$1", [deploymentId, message]);
      throw new Error(message);
    }
    const providerId = body.id || body.deploy_id || body.deployment?.id || null;
    const rawUrl = body.url || body.ssl_url || body.deploy_url || null;
    const url = rawUrl ? (String(rawUrl).startsWith('http') ? rawUrl : 'https://' + rawUrl) : null;
    const status = parseProviderState(body);
    await query(
      "update public.deployments set provider_deployment_id=$2, deployment_url=$3, status=$4, finished_at=case when $4='ready' then now() else null end where id=$1",
      [deploymentId, providerId, url, status]
    );
    return { deploymentId, status, providerDeploymentId: providerId, deploymentUrl: url };
  }

  app.post('/api/workers/jobs/:jobId/artifacts', workerAuth, async (req, res) => {
    const { leaseToken, name, sizeBytes = 0, sha256 = null, contentType = 'application/octet-stream' } = req.body || {};
    const cleanName = safeName(name);
    const size = Number(sizeBytes);
    if (!cleanName || !Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) {
      return res.status(400).json({ error: 'Artifact name and valid size are required; maximum is ' + MAX_BYTES + ' bytes.' });
    }
    if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) return res.status(400).json({ error: 'Invalid SHA-256 checksum' });
    try {
      const valid = await query(
        "select run_id from public.jobs where id=$1 and lease_token=$2 and worker_id=$3 and status='running' and lease_expires_at>now()",
        [req.params.jobId, leaseToken, req.worker.id]
      );
      if (!valid.rowCount) return res.status(409).json({ error: 'Worker lease is invalid or expired' });
      const objectKey = 'runs/' + valid.rows[0].run_id + '/jobs/' + req.params.jobId + '/' + crypto.randomUUID() + '/' + cleanName;
      const created = await query(
        'insert into public.artifacts(run_id,name,object_key,size_bytes,sha256,content_type) values($1,$2,$3,$4,$5,$6) returning id, object_key as "objectKey"',
        [valid.rows[0].run_id, cleanName, objectKey, size, sha256, String(contentType).slice(0, 160)]
      );
      res.status(201).json(created.rows[0]);
    } catch (error) {
      console.error('[artifact-register]', error?.message || error);
      res.status(500).json({ error: 'Could not register artifact' });
    }
  });

  app.post('/api/workers/jobs/:jobId/artifacts/:artifactId/upload-url', workerAuth, async (req, res) => {
    const leaseToken = String(req.body?.leaseToken || '');
    try {
      const found = await query(
        "select a.object_key,a.uploaded_at from public.jobs j join public.artifacts a on a.run_id=j.run_id where j.id=$1 and a.id=$2 and j.lease_token=$3 and j.worker_id=$4 and j.status='running' and j.lease_expires_at>now()",
        [req.params.jobId, req.params.artifactId, leaseToken, req.worker.id]
      );
      if (!found.rowCount) return res.status(409).json({ error: 'Artifact or worker lease not found' });
      if (found.rows[0].uploaded_at) return res.status(409).json({ error: 'Artifact is already uploaded' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Private artifact storage is not configured' });
      const signed = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(found.rows[0].object_key, { upsert: false });
      if (signed.error) throw signed.error;
      res.json({ path: signed.data.path, token: signed.data.token });
    } catch (error) {
      console.error('[artifact-upload-url]', error?.message || error);
      res.status(500).json({ error: 'Could not authorize artifact upload' });
    }
  });

  app.post('/api/workers/jobs/:jobId/artifacts/:artifactId/complete', workerAuth, async (req, res) => {
    const leaseToken = String(req.body?.leaseToken || '');
    const claimedHash = String(req.body?.sha256 || '').toLowerCase();
    try {
      const found = await query(
        "select a.object_key,a.size_bytes,a.sha256 as expected_sha256,a.uploaded_at from public.jobs j join public.artifacts a on a.run_id=j.run_id where j.id=$1 and a.id=$2 and j.lease_token=$3 and j.worker_id=$4 and j.status='running' and j.lease_expires_at>now()",
        [req.params.jobId, req.params.artifactId, leaseToken, req.worker.id]
      );
      if (!found.rowCount) return res.status(409).json({ error: 'Artifact or worker lease not found' });
      if (found.rows[0].uploaded_at) return res.status(409).json({ error: 'Artifact is already finalized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Private artifact storage is not configured' });
      const downloaded = await supabaseAdmin.storage.from(BUCKET).download(found.rows[0].object_key);
      if (downloaded.error) throw downloaded.error;
      const bytes = Buffer.from(await downloaded.data.arrayBuffer());
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== Number(found.rows[0].size_bytes)) return res.status(422).json({ error: 'Stored byte count does not match registered size' });
      if (!/^[a-f0-9]{64}$/.test(claimedHash) || claimedHash !== digest || (found.rows[0].expected_sha256 && found.rows[0].expected_sha256 !== digest)) return res.status(422).json({ error: 'Stored artifact SHA-256 verification failed' });
      const finalized = await query(
        'update public.artifacts a set sha256=$5,uploaded_at=now(),checksum_verified_at=now() where a.id=$1 and a.uploaded_at is null and exists (select 1 from public.jobs j where j.id=$2 and j.run_id=a.run_id and j.lease_token=$3 and j.worker_id=$4 and j.status=\'running\' and j.lease_expires_at>now()) returning a.id',
        [req.params.artifactId, req.params.jobId, leaseToken, req.worker.id, digest]
      );
      if (!finalized.rowCount) return res.status(409).json({ error: 'Worker lease expired before artifact finalization' });
      res.json({ ok: true, artifactId: req.params.artifactId, sizeBytes: bytes.length, sha256: digest });
    } catch (error) {
      console.error('[artifact-finalize]', error?.message || error);
      res.status(500).json({ error: 'Could not verify uploaded artifact' });
    }
  });


  app.get('/api/projects/:projectId/artifacts', userAuth, async (req, res) => {
    const result = await query(
      'select a.id,a.name,a.size_bytes as "sizeBytes",a.sha256,a.content_type as "contentType",a.created_at as "createdAt",a.uploaded_at as "uploadedAt",a.download_count as "downloadCount",r.run_number as "runNumber" from public.artifacts a join public.pipeline_runs r on r.id=a.run_id join public.projects p on p.id=r.project_id join public.organization_members m on m.organization_id=p.organization_id where p.id=$1 and m.user_id=$2 and a.uploaded_at is not null order by a.created_at desc limit 200',
      [req.params.projectId, req.user.id]
    );
    res.json(result.rows);
  });

  app.get('/api/artifacts/:artifactId/download', userAuth, async (req, res) => {
    try {
      const found = await query(
        'select a.id,a.object_key,a.name from public.artifacts a join public.pipeline_runs r on r.id=a.run_id join public.projects p on p.id=r.project_id join public.organization_members m on m.organization_id=p.organization_id where a.id=$1 and a.uploaded_at is not null and m.user_id=$2',
        [req.params.artifactId, req.user.id]
      );
      if (!found.rowCount) return res.status(404).json({ error: 'Artifact not found or access denied' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Private artifact storage is not configured' });
      const signed = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(found.rows[0].object_key, 60, { download: found.rows[0].name });
      if (signed.error) throw signed.error;
      await query('update public.artifacts set download_count=download_count+1 where id=$1', [req.params.artifactId]);
      res.json({ url: signed.data.signedUrl, expiresIn: 60, name: found.rows[0].name });
    } catch (error) {
      console.error('[artifact-download]', error?.message || error);
      res.status(500).json({ error: 'Could not create a download link' });
    }
  });

  app.get('/api/projects/:projectId/deployment-targets', userAuth, async (req, res) => {
    const access = await query('select 1 from public.projects p join public.organization_members m on m.organization_id=p.organization_id where p.id=$1 and m.user_id=$2', [req.params.projectId, req.user.id]);
    if (!access.rowCount) return res.status(404).json({ error: 'Project not found' });
    const rows = await query(
      'select id,project_id as "projectId",provider,name,provider_site_id as "providerSiteId",provider_team_id as "providerTeamId",target_environment as environment,approval_required as "approvalRequired",active,created_at as "createdAt" from public.deployment_targets where project_id=$1 order by created_at desc',
      [req.params.projectId]
    );
    res.json(rows.rows);
  });

  app.post('/api/projects/:projectId/deployment-targets', sensitiveLimiter, userAuth, async (req, res) => {
    const body = req.body || {};
    if (!['vercel','netlify'].includes(body.provider) || typeof body.name !== 'string' || body.name.trim().length < 2 ||
        typeof body.providerSiteId !== 'string' || !body.providerSiteId.trim() || typeof body.token !== 'string' || body.token.length < 20 ||
        !['production','preview'].includes(body.environment || 'production')) {
      return res.status(400).json({ error: 'Provider, target name, provider project/site ID, access token and environment are required.' });
    }
    try {
      const result = await transaction(async (client) => {
        const access = await client.query(
          'select m.role from public.projects p join public.organization_members m on m.organization_id=p.organization_id where p.id=$1 and m.user_id=$2',
          [req.params.projectId, req.user.id]
        );
        if (!access.rowCount || !['owner','admin'].includes(access.rows[0].role)) throw Object.assign(new Error('Workspace owner or admin access required to configure provider credentials'), { status: 403 });
        const target = await client.query(
          'insert into public.deployment_targets(project_id,provider,name,provider_site_id,provider_team_id,target_environment,approval_required,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning id,project_id as "projectId",provider,name,provider_site_id as "providerSiteId",target_environment as environment,approval_required as "approvalRequired",active,created_at as "createdAt"',
          [req.params.projectId, body.provider, body.name.trim().slice(0,120), body.providerSiteId.trim(), body.providerTeamId ? String(body.providerTeamId).trim() : null, body.environment || 'production', body.approvalRequired !== false, req.user.id]
        );
        const encrypted = encryptSecret(body.token);
        await client.query(
          'insert into public.project_secrets(project_id,name,encrypted_value,iv,auth_tag) values($1,$2,$3,$4,$5) on conflict(project_id,name) do update set encrypted_value=excluded.encrypted_value,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=now()',
          [req.params.projectId, secretName(target.rows[0].id), encrypted.encryptedValue, encrypted.iv, encrypted.authTag]
        );
        return target.rows[0];
      });
      res.status(201).json(result);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not save deployment target' });
    }
  });

  app.post('/api/projects/:projectId/deployment-targets/:targetId/disable', sensitiveLimiter, userAuth, async (req, res) => {
    const changed = await query(
      "update public.deployment_targets t set active=false,updated_at=now() from public.projects p,public.organization_members m where t.id=$1 and t.project_id=p.id and p.id=$2 and m.organization_id=p.organization_id and m.user_id=$3 and m.role in ('owner','admin') returning t.id",
      [req.params.targetId, req.params.projectId, req.user.id]
    );
    if (!changed.rowCount) return res.status(404).json({ error: 'Target not found or owner/admin access required' });
    res.json({ ok: true, active: false });
  });

  app.get('/api/deployments', userAuth, async (req, res) => {
    const projectId = String(req.query.projectId || '');
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    const rows = await query(
      'select d.id,d.target_id as "targetId",t.name as "targetName",t.provider,t.target_environment as environment,d.run_id as "runId",d.status,d.branch,d.commit_sha as "commitSha",d.provider_deployment_id as "providerDeploymentId",d.deployment_url as "deploymentUrl",d.error_message as "errorMessage",d.rollback_of as "rollbackOf",d.approved_by as "approvedBy",d.approved_at as "approvedAt",d.created_at as "createdAt",d.finished_at as "finishedAt",m.role from public.deployments d join public.deployment_targets t on t.id=d.target_id join public.projects p on p.id=t.project_id join public.organization_members m on m.organization_id=p.organization_id where p.id=$1 and m.user_id=$2 order by d.created_at desc limit 100',
      [projectId, req.user.id]
    );
    res.json(rows.rows);
  });

  app.post('/api/deployments', sensitiveLimiter, userAuth, async (req, res) => {
    try {
      const access = await query(
        "select t.*,m.role,r.branch,r.commit_sha,r.status as run_status,r.project_id from public.deployment_targets t join public.projects p on p.id=t.project_id join public.organization_members m on m.organization_id=p.organization_id join public.pipeline_runs r on r.id=$2 and r.project_id=p.id where t.id=$1 and m.user_id=$3 and t.active=true",
        [req.body?.targetId, req.body?.runId, req.user.id]
      );
      if (!access.rowCount) return res.status(404).json({ error: 'Deployment target or run not found' });
      const target = access.rows[0];
      if (!['owner','admin','developer'].includes(target.role)) return res.status(403).json({ error: 'Developer access required' });
      if (target.run_status !== 'succeeded' || !/^[a-f0-9]{40}$/i.test(target.commit_sha || '')) return res.status(409).json({ error: 'Only successful runs with a recorded commit can be deployed' });
      const created = await query(
        'insert into public.deployments(target_id,run_id,requested_by,status,branch,commit_sha) values($1,$2,$3,$4,$5,$6) returning *',
        [target.id, req.body.runId, req.user.id, target.approval_required ? 'pending_approval' : 'queued', target.branch, target.commit_sha]
      );
      if (target.approval_required) return res.status(201).json(created.rows[0]);
      const launched = await launchDeployment(created.rows[0].id);
      res.status(201).json({ ...created.rows[0], ...launched });
    } catch (error) {
      console.error('[deployment-create]', error?.message || error);
      res.status(500).json({ error: error?.message || 'Could not start deployment' });
    }
  });

  app.post('/api/deployments/:deploymentId/approve', sensitiveLimiter, userAuth, async (req, res) => {
    try {
      const access = await query(
        "select d.status,m.role from public.deployments d join public.deployment_targets t on t.id=d.target_id join public.projects p on p.id=t.project_id join public.organization_members m on m.organization_id=p.organization_id where d.id=$1 and m.user_id=$2",
        [req.params.deploymentId, req.user.id]
      );
      if (!access.rowCount || !['owner','admin'].includes(access.rows[0].role)) return res.status(403).json({ error: 'Workspace owner or admin approval is required' });
      if (access.rows[0].status !== 'pending_approval') return res.status(409).json({ error: 'Deployment is not awaiting approval' });
      const claimed = await query("update public.deployments set status='queued',approved_by=$2,approved_at=now() where id=$1 and status='pending_approval' returning id", [req.params.deploymentId, req.user.id]);
      if (!claimed.rowCount) return res.status(409).json({ error: 'Deployment approval was already processed' });
      res.json({ ok: true, ...await launchDeployment(req.params.deploymentId) });
    } catch (error) {
      console.error('[deployment-approve]', error?.message || error);
      res.status(500).json({ error: error?.message || 'Could not approve deployment' });
    }
  });

  app.post('/api/deployments/:deploymentId/reject', sensitiveLimiter, userAuth, async (req, res) => {
    const access = await query(
      "select d.status,m.role from public.deployments d join public.deployment_targets t on t.id=d.target_id join public.projects p on p.id=t.project_id join public.organization_members m on m.organization_id=p.organization_id where d.id=$1 and m.user_id=$2",
      [req.params.deploymentId, req.user.id]
    );
    if (!access.rowCount || !['owner','admin'].includes(access.rows[0].role)) return res.status(403).json({ error: 'Workspace owner or admin access required' });
    if (access.rows[0].status !== 'pending_approval') return res.status(409).json({ error: 'Deployment is not awaiting approval' });
    const rejected = await query("update public.deployments set status='rejected',finished_at=now(),approved_by=$2,approved_at=now() where id=$1 and status='pending_approval' returning id", [req.params.deploymentId, req.user.id]);
    if (!rejected.rowCount) return res.status(409).json({ error: 'Deployment approval was already processed' });
    res.json({ ok: true, status: 'rejected' });
  });

  app.post('/api/deployments/:deploymentId/rollback', sensitiveLimiter, userAuth, async (req, res) => {
    try {
      const current = await query(
        "select d.*,t.approval_required,t.provider,t.target_environment,m.role from public.deployments d join public.deployment_targets t on t.id=d.target_id join public.projects p on p.id=t.project_id join public.organization_members m on m.organization_id=p.organization_id where d.id=$1 and m.user_id=$2",
        [req.params.deploymentId, req.user.id]
      );
      if (!current.rowCount || !['owner','admin'].includes(current.rows[0].role)) return res.status(403).json({ error: 'Workspace owner or admin access required to roll back' });
      if (current.rows[0].status !== 'ready') return res.status(409).json({ error: 'Only a successful deployment can be rolled back' });
      if (current.rows[0].provider === 'netlify' && current.rows[0].target_environment === 'preview') return res.status(409).json({ error: 'Netlify preview drafts cannot be restored as production releases. Rollback is available for Netlify production targets.' });
      const previous = await query(
        "select * from public.deployments where target_id=$1 and status='ready' and id<>$2 and created_at<$3 order by created_at desc limit 1",
        [current.rows[0].target_id, current.rows[0].id, current.rows[0].created_at]
      );
      if (!previous.rowCount) return res.status(409).json({ error: 'There is no earlier successful deployment to restore' });
      const source = previous.rows[0];
      const rollback = await query(
        'insert into public.deployments(target_id,run_id,requested_by,status,branch,commit_sha,rollback_of,rollback_source_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',
        [current.rows[0].target_id, source.run_id, req.user.id, current.rows[0].approval_required ? 'pending_approval' : 'queued', source.branch, source.commit_sha, current.rows[0].id, source.id]
      );
      if (current.rows[0].approval_required) return res.status(201).json(rollback.rows[0]);
      res.status(201).json({ ...rollback.rows[0], ...await launchDeployment(rollback.rows[0].id) });
    } catch (error) {
      console.error('[deployment-rollback]', error?.message || error);
      res.status(500).json({ error: error?.message || 'Rollback could not be started' });
    }
  });

  app.post('/api/deployments/:deploymentId/refresh', sensitiveLimiter, userAuth, async (req, res) => {
    try {
      const found = await query(
        'select d.id,d.status,d.provider_deployment_id,t.provider,t.provider_site_id,t.provider_team_id,p.id as project_id from public.deployments d join public.deployment_targets t on t.id=d.target_id join public.projects p on p.id=t.project_id join public.organization_members m on m.organization_id=p.organization_id where d.id=$1 and m.user_id=$2',
        [req.params.deploymentId, req.user.id]
      );
      if (!found.rowCount) return res.status(404).json({ error: 'Deployment not found' });
      const d = found.rows[0];
      if (!d.provider_deployment_id) return res.status(409).json({ error: 'Provider has not returned a deployment ID yet' });
      // Resolve the encrypted credential using the deployment target ID.
      const targetId = await query('select target_id from public.deployments where id=$1', [d.id]);
      const credential = await query('select encrypted_value,iv,auth_tag from public.project_secrets where project_id=$1 and name=$2', [d.project_id, secretName(targetId.rows[0].target_id)]);
      if (!credential.rowCount) return res.status(503).json({ error: 'Provider credential is missing' });
      const token = decryptSecret(credential.rows[0].encrypted_value, credential.rows[0].iv, credential.rows[0].auth_tag);
      let url;
      if (d.provider === 'vercel') {
        url = new URL('https://api.vercel.com/v13/deployments/' + encodeURIComponent(d.provider_deployment_id));
        if (d.provider_team_id) url.searchParams.set('teamId', d.provider_team_id);
      } else {
        url = new URL('https://api.netlify.com/api/v1/sites/' + encodeURIComponent(d.provider_site_id) + '/deploys/' + encodeURIComponent(d.provider_deployment_id));
      }
      const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return res.status(502).json({ error: 'Provider status request failed: HTTP ' + response.status });
      const status = parseProviderState(body);
      const deploymentUrl = body.url || body.ssl_url || body.deploy_url || null;
      await query("update public.deployments set status=$2,deployment_url=coalesce($3,deployment_url),finished_at=case when $2 in ('ready','failed') then coalesce(finished_at,now()) else null end,error_message=case when $2='failed' then coalesce($4,'Provider reported failure') else null end where id=$1", [d.id, status, deploymentUrl, body.error_message || body.error || null]);
      res.json({ ok: true, status, deploymentUrl });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Could not refresh deployment status' });
    }
  });
}
