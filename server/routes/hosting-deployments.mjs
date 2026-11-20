import { decryptSecret } from '../lib/security.mjs';
import { deployToHostingProvider, refreshHostingDeployment, getHostingDeploymentLogs, cleanupHostingDeployment } from '../deploy/providers/index.mjs';
import { redactSecrets } from '../lib/security.mjs';
import { getHostingProvider, normalizeSubdomain, providerDomainCandidates } from '../deploy/providers/catalog.mjs';

const ADMIN_ROLES = ['owner', 'admin'];

const NETLIFY_MAX_FILES = 50;
const NETLIFY_MAX_BYTES = 25 * 1024 * 1024;
const safeRelativeArtifact = (name) => typeof name === 'string' && name.length <= 512 && !name.startsWith('/') && !name.includes('\\') && !/^[A-Za-z]:/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..' && !part.split('').some(char => char.charCodeAt(0) < 32));

export function validateNetlifyDeployFiles(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Netlify deploy files must be an object');
  const entries=Object.entries(input);
  if (!entries.length || entries.length > NETLIFY_MAX_FILES) throw new Error('Netlify deploy must contain 1-50 files');
  let total=0;const files={};
  for (const [rawPath,content] of entries) {
    if (typeof content !== 'string' || !rawPath.startsWith('/') || !safeRelativeArtifact(rawPath.slice(1))) throw new Error('Unsafe Netlify file path or content');
    let bytes;
    if (content.startsWith('base64:')) {
      const encoded=content.slice(7);bytes=Buffer.from(encoded,'base64');
      if (!bytes.length || bytes.toString('base64') !== encoded) throw new Error('Invalid base64 deploy file');
    } else bytes=Buffer.from(content,'utf8');
    if (!bytes.length || bytes.length > 10 * 1024 * 1024 || total + bytes.length > NETLIFY_MAX_BYTES) throw new Error('Netlify files exceed the 25 MiB limit');
    total+=bytes.length;files[rawPath]=content;
  }
  if (!files['/index.html']) throw new Error('Netlify static deployments must include /index.html');
  return files;
}

export async function prepareNetlifyArtifactFiles(runId, { query, fetchImpl = fetch, publishDirectory = '', storageUrl = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY } = {}) {
  if (!storageUrl || !serviceKey) throw new Error('Artifact storage is not configured for automatic static deployments');
  const prefix = String(publishDirectory || '').trim().split('/').filter(Boolean).join('/');
  const storageBase = storageUrl.endsWith('/') ? storageUrl.slice(0, -1) : storageUrl;
  if (prefix && !safeRelativeArtifact(prefix)) throw new Error('Publish directory must be a safe relative path');
  const artifacts = await query('select name,object_key,size_bytes from public.artifacts where run_id=$1 and deleted_at is null and (expires_at is null or expires_at > now()) order by name', [runId]);
  if (!artifacts.rowCount) throw new Error('Successful pipeline run has no build artifacts. Add an artifact-producing build job first.');
  if (artifacts.rowCount > NETLIFY_MAX_FILES) throw new Error('Static deployment exceeds the 50-file limit; reduce build artifacts.');
  const files = {};
  let total = 0;
  for (const artifact of artifacts.rows) {
    let name = String(artifact.name || '');
    while (name.startsWith('/')) name = name.slice(1);
    if (prefix) { if (!name.startsWith(prefix + '/')) continue; name = name.slice(prefix.length + 1); }
    else if (name.startsWith('dist/')) name = name.slice(5);
    else if (name.startsWith('build/')) name = name.slice(6);
    else if (name.startsWith('artifacts/')) name = name.slice(10);
    if (!safeRelativeArtifact(name)) throw new Error('Build artifact contains an unsafe path');
    const key = String(artifact.object_key || '');
    if (!safeRelativeArtifact(key)) throw new Error('Stored artifact key is invalid');
    const objectPath = key.split('/').map(encodeURIComponent).join('/');
    const response = await fetchImpl(storageBase + '/storage/v1/object/kestrel-artifacts/' + objectPath, { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Could not retrieve a pipeline build artifact from private storage');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 10 * 1024 * 1024 || total + bytes.length > NETLIFY_MAX_BYTES) throw new Error('Static build artifacts exceed the 25 MiB automatic deploy limit');
    if (files['/' + name]) throw new Error('Build artifact names conflict after publish-directory mapping');
    total += bytes.length;
    files['/' + name] = 'base64:' + bytes.toString('base64');
  }
  if (!Object.keys(files).length) throw new Error('No build artifacts matched the configured publish directory');
  if (!files['/index.html']) throw new Error('Static deployment artifacts must include index.html at the publish root');
  return files;
}

export async function prepareHerokuSourceArchive({ repositoryUrl, commitSha, organizationId, runId, query, fetchImpl = fetch, storageUrl = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY } = {}) {
  if (!storageUrl || !serviceKey) throw new Error('Private artifact storage is not configured for Heroku source builds');
  if (!/^[a-f0-9]{40,64}$/i.test(String(commitSha || ''))) throw new Error('A verified commit SHA is required to build a source archive');
  let parsed;
  try { parsed = new URL(repositoryUrl); } catch { throw new Error('Heroku source build requires a GitHub repository URL'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password) throw new Error('Automatic Heroku source builds currently require a public GitHub repository');
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test((parts[1].endsWith('.git')?parts[1].slice(0,-4):parts[1]))) throw new Error('GitHub repository URL is invalid');
  const owner=parts[0],repo=(parts[1].endsWith('.git')?parts[1].slice(0,-4):parts[1]);
  const sourceUrl='https://codeload.github.com/'+owner+'/'+repo+'/tar.gz/'+commitSha;
  const sourceResponse=await fetchImpl(sourceUrl,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
  if (!sourceResponse.ok) throw new Error(sourceResponse.status===404?'Repository is private or the validated commit is unavailable; connect GitHub access or supply an archive URL':'GitHub source archive download failed');
  const archive=Buffer.from(await sourceResponse.arrayBuffer());
  if (!archive.length || archive.length > 50*1024*1024) throw new Error('GitHub source archive exceeds the 50 MiB Heroku source-build limit');
  const sha256=crypto.createHash('sha256').update(archive).digest('hex');
  const storageBase=storageUrl.endsWith('/')?storageUrl.slice(0,-1):storageUrl;
  const objectKey=organizationId+'/'+runId+'/heroku-source-'+commitSha+'.tgz';
  const encodedKey=objectKey.split('/').map(encodeURIComponent).join('/');
  const upload=await fetchImpl(storageBase+'/storage/v1/object/kestrel-artifacts/'+encodedKey,{method:'POST',headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/gzip','x-upsert':'true'},body:archive,signal:AbortSignal.timeout(30000)});
  if(!upload.ok)throw new Error('Could not store the verified Heroku source archive');
  try {
    const signed=await fetchImpl(storageBase+'/storage/v1/object/sign/kestrel-artifacts/'+encodedKey,{method:'POST',headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},body:JSON.stringify({expiresIn:3600}),signal:AbortSignal.timeout(15000)});
    const signedData=await signed.json().catch(()=>null);
    if(!signed.ok)throw new Error('Could not create a temporary source archive URL');
    const signedPath=signedData?.signedURL||signedData?.signedUrl;
    if(typeof signedPath!=='string')throw new Error('Storage did not return a signed source archive URL');
    const archiveUrl=signedPath.startsWith('http')?signedPath:storageBase+'/storage/v1'+(signedPath.startsWith('/')?'':'/')+signedPath;
    await query('insert into public.artifacts(run_id,name,object_key,size_bytes,sha256,content_type,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval \'1 day\')',[runId,'heroku-source-'+commitSha+'.tgz',objectKey,archive.length,sha256,'application/gzip']);
    return archiveUrl;
  } catch (error) {
    await fetchImpl(storageBase+'/storage/v1/object/kestrel-artifacts/'+encodedKey,{method:'DELETE',headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey},signal:AbortSignal.timeout(10000)}).catch(()=>{});
    throw error;
  }
}

export function registerHostingDeploymentRoutes(app, { userAuth, query }) {
  app.post('/api/organizations/:organizationId/hosting-connections/:connectionId/deploy', userAuth, async (req, res) => {
    const { projectId, pipelineRunId, projectSlug, image, imageRepository, imageTag, registryType, appType = 'docker', port = 3000, buildCommand, startCommand, sourceTarball, gitSource, env = {} } = req.body || {};
    const slug = normalizeSubdomain(projectSlug);
    if (!projectId || !pipelineRunId || !slug) return res.status(400).json({ error: 'Project, successful pipeline run and valid subdomain are required' });
    if (image && !/@sha256:[a-fA-F0-9]{64}$/.test(image)) return res.status(400).json({ error: 'Deployments must use immutable container image digests' });
    if (!image && !sourceTarball && !gitSource && appType !== 'static') return res.status(400).json({ error: 'A verified image, source archive or connected Git source is required' });
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 100) return res.status(400).json({ error: 'Deployment environment variables are invalid' });
    const envEntries = Object.entries(env);
    if (envEntries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 8192) || envEntries.reduce((size, [key, value]) => size + key.length + String(value).length, 0) > 65536) {
      return res.status(400).json({ error: 'Deployment environment variables contain invalid keys or values' });
    }
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return res.status(400).json({ error: 'Port must be an integer between 1 and 65535' });
    let deploymentRecordId = null;
    let partialProviderResourceId = null;
    let partialProviderMetadata = {};
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
      if (!image && !sourceTarball && !gitSource && connection.provider_id !== 'netlify') return res.status(400).json({ error: 'A verified image, source archive or connected Git source is required' });
      if (connection.provider_id === 'netlify' && appType !== 'static') return res.status(400).json({ error: 'Netlify direct artifact deployments currently support static sites only' });
      if (connection.provider_id === 'netlify' && req.body?.deployFiles) { try { validateNetlifyDeployFiles(req.body.deployFiles); } catch (error) { return res.status(400).json({ error: error.message }); } }

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
      if (connection.provider_id === 'heroku' && sourceTarball) {
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
      const credential = decryptSecret(connection.encrypted_credentials, connection.credentials_iv, connection.credentials_auth_tag);
      const deploymentRequest = {
        projectSlug: slug, appType, image, repoUrl, branch: run.branch || run.default_branch,
        commitSha, port: portNumber, buildCommand, startCommand, sourceTarball, gitSource: pinnedGitSource, imageRepository, imageTag, registryType,
        env, healthPath: req.body?.healthPath, target: req.body?.target, outputDirectory: req.body?.outputDirectory,
        deployFiles: req.body?.deployFiles, publishDirectory: req.body?.publishDirectory, imageRepository: req.body?.imageRepository,
        imageTag: req.body?.imageTag, registryType: req.body?.registryType, instanceSize: req.body?.instanceSize, buildpacks: req.body?.buildpacks,
      };
      if (connection.provider_id === 'heroku' && !deploymentRequest.sourceTarball) {
        deploymentRequest.sourceTarball = await prepareHerokuSourceArchive({ repositoryUrl: repoUrl, commitSha, organizationId: connection.organization_id, runId: pipelineRunId, query });
      }
      if (connection.provider_id === 'netlify' && !deploymentRequest.deployFiles) {
        deploymentRequest.deployFiles = await prepareNetlifyArtifactFiles(pipelineRunId, { query, publishDirectory: req.body?.publishDirectory || req.body?.outputDirectory });
      }
      const result = await deployToHostingProvider(connection.provider_id, credential, deploymentRequest);
      partialProviderResourceId = result.providerDeploymentId || null;
      partialProviderMetadata = result.metadata || {};
      if (!result.ok) {
        await query(`update public.hosting_provider_deployments set status='failed',error_message=$2,provider_resource_id=$3,metadata=metadata || $4::jsonb,updated_at=now(),completed_at=now() where id=$1`, [record.rows[0].id,result.error,result.providerDeploymentId||null,JSON.stringify(result.metadata||{})]);
        return res.status(502).json({ deployment: { ...record.rows[0], status: 'failed' }, error: result.error });
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
      res.status(202).json({ deployment: updated.rows[0], providerStatus: result.providerStatus, providerUrl: result.url, note: 'Provider accepted deployment request; live status is not confirmed yet.' });
    } catch (error) {
      if (deploymentRecordId) {
        try {
          await query(`update public.hosting_provider_deployments set status='failed',error_message='Deployment request failed before provider confirmation',provider_resource_id=$2,metadata=metadata || $3::jsonb,updated_at=now(),completed_at=now() where id=$1 and status in ('provisioning','building','deploying')`, [deploymentRecordId,partialProviderResourceId,JSON.stringify(partialProviderMetadata)]);
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
      const updated=await query(`update public.hosting_provider_deployments set status=$2,live_url=$3,metadata=metadata || $4::jsonb,updated_at=now(),completed_at=case when $2 in ('live','failed') then now() else completed_at end where id=$1 returning id,status,live_url as "liveUrl",provider_id as "providerId",project_slug as "projectSlug",updated_at as "updatedAt"`,[d.id,refreshed.status,refreshed.url,JSON.stringify({providerStatus:refreshed.providerStatus})]);
      res.json({ deployment: updated.rows[0], providerStatus: refreshed.providerStatus });
    } catch { res.status(500).json({ error: 'Could not refresh hosting deployment status' }); }
  });
  app.get('/api/hosting-deployments/:deploymentId/logs', userAuth, async (req, res) => {
    try {
      const row = await query(
        `select d.*, c.encrypted_credentials,c.credentials_iv,c.credentials_auth_tag,m.role
         from public.hosting_provider_deployments d
         join public.hosting_provider_connections c on c.id=d.connection_id
         join public.organization_members m on m.organization_id=d.organization_id
         where d.id=$1 and m.user_id=$2`,
        [req.params.deploymentId,req.user.id]
      );
      if (!row.rowCount) return res.status(404).json({ error: 'Hosting deployment not found' });
      const d=row.rows[0];
      const credential=decryptSecret(d.encrypted_credentials,d.credentials_iv,d.credentials_auth_tag);
      const result=await getHostingDeploymentLogs(d.provider_id,credential,{providerResourceId:d.provider_resource_id,metadata:d.metadata||{}});
      if (!result.ok) return res.status(501).json({ error: result.error });
      const knownSecrets=[credential];
      try { const parsed=JSON.parse(credential); knownSecrets.push(...Object.values(parsed).filter(v=>typeof v==='string')); } catch {}
      res.json({ deploymentId:d.id, providerId:d.provider_id, logs:redactSecrets(result.logs,knownSecrets) });
    } catch { res.status(500).json({ error: 'Could not retrieve provider deployment logs' }); }
  });

  app.post('/api/hosting-deployments/:deploymentId/cleanup', userAuth, async (req, res) => {
    try {
      const row=await query(
        `select d.*,c.encrypted_credentials,c.credentials_iv,c.credentials_auth_tag,m.role
         from public.hosting_provider_deployments d
         join public.hosting_provider_connections c on c.id=d.connection_id
         join public.organization_members m on m.organization_id=d.organization_id
         where d.id=$1 and m.user_id=$2`,
        [req.params.deploymentId,req.user.id]
      );
      if (!row.rowCount) return res.status(404).json({error:'Hosting deployment not found'});
      const d=row.rows[0];
      if (!ADMIN_ROLES.includes(d.role)) return res.status(403).json({error:'Workspace admin permission required to cleanup provider resources'});
      if (d.status !== 'failed') return res.status(409).json({error:'Cleanup is only allowed for deployments marked failed'});
      const credential=decryptSecret(d.encrypted_credentials,d.credentials_iv,d.credentials_auth_tag);
      const cleaned=await cleanupHostingDeployment(d.provider_id,credential,{providerResourceId:d.provider_resource_id,metadata:d.metadata||{}});
      if (!cleaned.ok) return res.status(502).json({error:cleaned.error});
      const updated=await query(
        `update public.hosting_provider_deployments set status='cancelled',error_message=null,metadata=metadata || $2::jsonb,updated_at=now(),completed_at=now()
         where id=$1 and status='failed' returning id,status,provider_id as "providerId",project_slug as "projectSlug",updated_at as "updatedAt"`,
        [d.id,JSON.stringify({cleanupCompletedAt:new Date().toISOString(),cleanupResourceId:cleaned.deletedResourceId})]
      );
      res.json({ok:true,deployment:updated.rows[0],cleanupScope:'Provider resource deleted. Some providers delete the entire app/service rather than only one deployment.'});
    } catch {res.status(500).json({error:'Could not cleanup failed hosting deployment'});}
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
