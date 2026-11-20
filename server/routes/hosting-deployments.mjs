import { decryptSecret } from '../lib/security.mjs';
import { deployToHostingProvider, refreshHostingDeployment } from '../deploy/providers/index.mjs';
import { getHostingProvider, normalizeSubdomain, providerDomainCandidates } from '../deploy/providers/catalog.mjs';

const ADMIN_ROLES = ['owner', 'admin'];

async function writeDeploymentEvent(query, deploymentId, eventType, message, metadata = {}, actorId = null) {
  try {
    await query(
      `insert into public.hosting_deployment_events(deployment_id,event_type,message,metadata,created_by)
       values($1,$2,$3,$4::jsonb,$5)`,
      [deploymentId,eventType,String(message).slice(0,500),JSON.stringify(metadata),actorId]
    );
  } catch (error) {
    console.error('Hosting deployment event could not be recorded:', error.message);
  }
}

export function registerHostingDeploymentRoutes(app, { userAuth, query }) {
  app.post('/api/organizations/:organizationId/hosting-connections/:connectionId/deploy', userAuth, async (req, res) => {
    const { projectId, pipelineRunId, projectSlug, image, imageRepository, imageTag, registryType, appType = 'docker', port = 3000, buildCommand, startCommand, sourceTarball, gitSource, env = {} } = req.body || {};
    const slug = normalizeSubdomain(projectSlug);
    if (!projectId || !pipelineRunId || !slug) return res.status(400).json({ error: 'Project, successful pipeline run and valid subdomain are required' });
    if (image && !/@sha256:[a-fA-F0-9]{64}$/.test(image)) return res.status(400).json({ error: 'Deployments must use immutable container image digests' });
    if (!image && !sourceTarball && !gitSource) return res.status(400).json({ error: 'A verified image, source archive or connected Git source is required' });
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 100) return res.status(400).json({ error: 'Deployment environment variables are invalid' });
    const envEntries = Object.entries(env);
    if (envEntries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 8192) || envEntries.reduce((size, [key, value]) => size + key.length + String(value).length, 0) > 65536) {
      return res.status(400).json({ error: 'Deployment environment variables contain invalid keys or values' });
    }
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return res.status(400).json({ error: 'Port must be an integer between 1 and 65535' });
    let deploymentRecordId = null;
    try {
      const connectionResult = await query(
        `select c.*, m.role from public.hosting_provider_connections c
         join public.organization_members m on m.organization_id=c.organization_id
         where c.id=$1 and c.organization_id=$2 and m.user_id=$3`,
        [req.params.connectionId, req.params.organizationId, req.user.id]
      );
      if (!connectionResult.rowCount) return res.status(404).json({ error: 'Hosting connection not found' });
      const connection = connectionResult.rows[0];
      if (!ADMIN_ROLES.includes(connection.role)) return res.status(403).json({ error: 'Workspace owner or admin permission required to deploy' });
      if (connection.status !== 'connected') return res.status(409).json({ error: 'Verify the provider connection before deploying' });
      const provider = getHostingProvider(connection.provider_id);
      if (!provider) return res.status(400).json({ error: 'Provider is unsupported' });
      if (!provider.appTypes.includes(appType)) return res.status(400).json({ error: `${provider.name} does not support the selected application type` });

      const source = await query(
        `select p.organization_id,p.repository_url,p.default_branch,r.status,r.branch,r.commit_sha
         from public.projects p join public.pipeline_runs r on r.project_id=p.id
         join public.organization_members m on m.organization_id=p.organization_id
         where p.id=$1 and r.id=$2 and m.user_id=$3`,
        [projectId, pipelineRunId, req.user.id]
      );
      if (!source.rowCount) return res.status(404).json({ error: 'Project or pipeline run not found' });
      const run = source.rows[0];
      if (run.organization_id !== connection.organization_id) return res.status(403).json({ error: 'Project is outside this workspace' });
      if (run.status !== 'succeeded') return res.status(409).json({ error: 'Deployment is only allowed after a successful pipeline run' });
      const commitSha = run.commit_sha;
      if (!commitSha) return res.status(409).json({ error: 'Successful pipeline run does not have a pinned commit SHA' });
      if (gitSource?.sha && gitSource.sha !== commitSha) return res.status(400).json({ error: 'Git source SHA must match the validated pipeline commit' });
      const repoUrl = run.repository_url;
      if (gitSource && gitSource.repoUrl && gitSource.repoUrl !== repoUrl) return res.status(400).json({ error: 'Git source repository must match the Kestrel project source' });
      let pinnedGitSource;
      if (connection.provider_id === 'vercel') {
        let githubParts = [];
        try { const parsed = new URL(repoUrl); githubParts = parsed.hostname === 'github.com' ? parsed.pathname.split('/').filter(Boolean) : []; } catch {}
        if (githubParts.length < 2) return res.status(400).json({ error: 'Vercel requires a GitHub repository connected to the provider account' });
        const org = githubParts[0], repoName = githubParts[1].endsWith('.git') ? githubParts[1].slice(0, -4) : githubParts[1];
        if (gitSource && (gitSource.org !== org || gitSource.repo !== repoName)) return res.status(400).json({ error: 'Git source must match the Kestrel project repository' });
        pinnedGitSource = { org, repo: repoName, ref: run.branch, sha: commitSha };
      }
      if (connection.provider_id === 'heroku') {
        let archive;
        try { archive = new URL(sourceTarball); } catch {}
        if (!archive || archive.protocol !== 'https:' || !archive.pathname.includes(commitSha)) return res.status(400).json({ error: 'Heroku source archive must be HTTPS and pinned to the validated commit SHA' });
      }

      const existing = await query('select id,status,live_url as "liveUrl" from public.hosting_provider_deployments where connection_id=$1 and pipeline_run_id=$2', [connection.id,pipelineRunId]);
      if (existing.rowCount && existing.rows[0].status === 'live') return res.status(200).json({ deployment: existing.rows[0], reused: true });
      if (existing.rowCount) return res.status(409).json({ error: 'This pipeline run already has a provider deployment record', deployment: existing.rows[0] });

      const candidates = providerDomainCandidates(connection.provider_id, slug);
      const requestedHostname = candidates[0]?.hostname || null;
      const record = await query(
        `insert into public.hosting_provider_deployments
         (organization_id,project_id,connection_id,pipeline_run_id,provider_id,project_slug,requested_hostname,status,created_by)
         values($1,$2,$3,$4,$5,$6,$7,'provisioning',$8)
         returning id,status,provider_id as "providerId",project_slug as "projectSlug",requested_hostname as "requestedHostname",created_at as "createdAt"`,
        [connection.organization_id,projectId,connection.id,pipelineRunId,connection.provider_id,slug,requestedHostname,req.user.id]
      );
      deploymentRecordId = record.rows[0].id;
      await writeDeploymentEvent(query, deploymentRecordId, 'deployment.created', 'Deployment request accepted by Kestrel', { providerId: connection.provider_id, pipelineRunId }, req.user.id);
      const credential = decryptSecret(connection.encrypted_credentials, connection.credentials_iv, connection.credentials_auth_tag);
      const deploymentRequest = {
        projectSlug: slug, appType, image, repoUrl, branch: run.branch || run.default_branch,
        commitSha, port: portNumber, buildCommand, startCommand, sourceTarball, gitSource: pinnedGitSource, imageRepository, imageTag, registryType,
        env, healthPath: req.body?.healthPath, target: req.body?.target, outputDirectory: req.body?.outputDirectory,
        deployFiles: req.body?.deployFiles, publishDirectory: req.body?.publishDirectory, imageRepository: req.body?.imageRepository,
        imageTag: req.body?.imageTag, registryType: req.body?.registryType, instanceSize: req.body?.instanceSize, buildpacks: req.body?.buildpacks,
      };
      const result = await deployToHostingProvider(connection.provider_id, credential, deploymentRequest);
      if (!result.ok) {
        const safeError = String(result.error || 'Provider deployment failed').slice(0, 500);
        await query(`update public.hosting_provider_deployments set status='failed',error_message=$2,updated_at=now(),completed_at=now() where id=$1`, [record.rows[0].id,safeError]);
        await writeDeploymentEvent(query, deploymentRecordId, 'provider.failed', 'Hosting provider rejected or failed the deployment', { error: safeError, providerId: connection.provider_id, cleanupRequired: Boolean(result.cleanupRequired), cleanupStatus: result.cleanupStatus || 'unknown' }, req.user.id);
        return res.status(502).json({ deployment: { ...record.rows[0], status: 'failed' }, error: safeError });
      }
      const hostname = result.hostname || requestedHostname;
      const updated = await query(
        `update public.hosting_provider_deployments set provider_resource_id=$2,live_url=$3,status=$4,
          metadata=$5,updated_at=now(),completed_at=case when $4='live' then now() else null end
         where id=$1 returning id,status,provider_id as "providerId",provider_resource_id as "providerResourceId",
          project_slug as "projectSlug",requested_hostname as "requestedHostname",live_url as "liveUrl",created_at as "createdAt"`,
        [record.rows[0].id,result.providerDeploymentId,result.url,result.providerStatus === 'live' ? 'live' : 'deploying',
          { providerStatus: result.providerStatus, actualHostname: hostname, commitSha, ...(result.metadata || {}) }]
      );
      await writeDeploymentEvent(query, deploymentRecordId, 'provider.accepted', 'Hosting provider accepted the deployment request', { providerStatus: result.providerStatus, providerResourceId: result.id || null }, req.user.id);
      res.status(202).json({ deployment: updated.rows[0], providerStatus: result.providerStatus, providerUrl: result.url, note: 'Provider accepted deployment request; live status is not confirmed yet.' });
    } catch (error) {
      if (deploymentRecordId) {
        await writeDeploymentEvent(query, deploymentRecordId, 'deployment.failed', 'Deployment request failed before provider confirmation', {}, req.user.id);
        try {
          await query(`update public.hosting_provider_deployments set status='failed',error_message='Deployment request failed before provider confirmation',updated_at=now(),completed_at=now() where id=$1 and status in ('provisioning','building','deploying')`, [deploymentRecordId]);
        } catch { /* preserve the original failure response */ }
      }
      res.status(500).json({ error: 'Could not initiate hosting-provider deployment' });
    }
  });

  app.get('/api/organizations/:organizationId/hosting-deployments', userAuth, async (req, res) => {
    try {
      const rows = await query(
        `select d.id,d.provider_id as "providerId",d.project_id as "projectId",d.pipeline_run_id as "pipelineRunId",
          d.provider_resource_id as "providerResourceId",d.project_slug as "projectSlug",d.requested_hostname as "requestedHostname",
          d.live_url as "liveUrl",d.status,d.error_message as "errorMessage",d.metadata,d.created_at as "createdAt",d.updated_at as "updatedAt"
         from public.hosting_provider_deployments d join public.organization_members m on m.organization_id=d.organization_id
         where d.organization_id=$1 and m.user_id=$2 order by d.created_at desc limit 100`,
        [req.params.organizationId,req.user.id]
      );
      res.json({ deployments: rows.rows });
    } catch { res.status(500).json({ error: 'Could not load hosting deployments' }); }
  });

  app.post('/api/hosting-deployments/:deploymentId/refresh', userAuth, async (req, res) => {
    try {
      const row = await query(`select d.*, c.encrypted_credentials,c.credentials_iv,c.credentials_auth_tag,m.role from public.hosting_provider_deployments d join public.hosting_provider_connections c on c.id=d.connection_id join public.organization_members m on m.organization_id=d.organization_id where d.id=$1 and m.user_id=$2`, [req.params.deploymentId,req.user.id]);
      if (!row.rowCount) return res.status(404).json({ error: 'Hosting deployment not found' });
      const d=row.rows[0]; if (!ADMIN_ROLES.includes(d.role)) return res.status(403).json({ error: 'Workspace admin permission required to refresh deployment status' });
      const credential=decryptSecret(d.encrypted_credentials,d.credentials_iv,d.credentials_auth_tag);
      const refreshed=await refreshHostingDeployment(d.provider_id,credential,{providerResourceId:d.provider_resource_id,liveUrl:d.live_url,metadata:d.metadata||{}});
      if (!refreshed.ok) return res.status(502).json({ error: refreshed.error });
      await writeDeploymentEvent(query, d.id, 'status.refreshed', 'Provider deployment status was refreshed', { providerStatus: refreshed.providerStatus, status: refreshed.status }, req.user.id);
      const updated=await query(`update public.hosting_provider_deployments set status=$2,live_url=$3,metadata=metadata || $4::jsonb,updated_at=now(),completed_at=case when $2 in ('live','failed') then now() else completed_at end where id=$1 returning id,status,live_url as "liveUrl",provider_id as "providerId",project_slug as "projectSlug",updated_at as "updatedAt"`,[d.id,refreshed.status,refreshed.url,JSON.stringify({providerStatus:refreshed.providerStatus})]);
      res.json({ deployment: updated.rows[0], providerStatus: refreshed.providerStatus });
    } catch { res.status(500).json({ error: 'Could not refresh hosting deployment status' }); }
  });
  app.get('/api/hosting-deployments/:deploymentId/events', userAuth, async (req, res) => {
    try {
      const access = await query(
        `select d.id from public.hosting_provider_deployments d
         join public.organization_members m on m.organization_id=d.organization_id
         where d.id=$1 and m.user_id=$2`,
        [req.params.deploymentId, req.user.id]
      );
      if (!access.rowCount) return res.status(404).json({ error: 'Hosting deployment not found' });
      const events = await query(
        `select id,event_type as "eventType",message,metadata,created_at as "createdAt"
         from public.hosting_deployment_events where deployment_id=$1
         order by created_at asc limit 200`,
        [req.params.deploymentId]
      );
      res.json({ events: events.rows });
    } catch {
      res.status(500).json({ error: 'Could not load hosting deployment events' });
    }
  });

  app.get('/api/hosting-deployments/:deploymentId', userAuth, async (req, res) => {
    try {
      const row = await query(
        `select d.* from public.hosting_provider_deployments d join public.organization_members m on m.organization_id=d.organization_id
         where d.id=$1 and m.user_id=$2`,
        [req.params.deploymentId,req.user.id]
      );
      if (!row.rowCount) return res.status(404).json({ error: 'Hosting deployment not found' });
      const d=row.rows[0];
      res.json({ deployment: { id:d.id, providerId:d.provider_id, projectId:d.project_id, pipelineRunId:d.pipeline_run_id,
        providerResourceId:d.provider_resource_id, projectSlug:d.project_slug, requestedHostname:d.requested_hostname,
        liveUrl:d.live_url,status:d.status,errorMessage:d.error_message,metadata:d.metadata,createdAt:d.created_at,updatedAt:d.updated_at } });
    } catch { res.status(500).json({ error: 'Could not load hosting deployment' }); }
  });
}
