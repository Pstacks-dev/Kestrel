import crypto from 'node:crypto';
import { decryptSecret, redactSecrets } from '../lib/security.mjs';
import { parseGitHubRepository } from './git-import.mjs';
import { detectProjectProfile, rankHostingProviders } from '../lib/hosting-providers.mjs';
import {
  ACTIVE_MANAGED_PROVIDERS, createManagedProviderDeployment, deployManagedProviderService,
  getManagedProviderDeployment, getManagedProviderDeploymentLogs, rollbackManagedProviderDeployment,
} from '../lib/hosting-managed-adapters.mjs';

const WRITE_ROLES = ['owner', 'admin', 'developer'];
const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Kestrel-Managed-Deployments',
};

function fail(res, status, error) { return res.status(status).json({ error }); }

async function githubJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: API_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Object.assign(new Error('GitHub repository inspection failed'), { status: response.status });
  return response.json();
}

async function inspectProject(repository, branch, fetchImpl) {
  const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const root = await githubJson(`${base}/contents/?ref=${encodeURIComponent(branch)}`, fetchImpl);
  if (!Array.isArray(root)) throw new Error('GitHub repository root could not be inspected');
  const files = root.filter((item) => item.type === 'file').map((item) => item.name);
  let packageJson = null;
  if (files.some((name) => name.toLowerCase() === 'package.json')) {
    const file = await githubJson(`${base}/contents/package.json?ref=${encodeURIComponent(branch)}`, fetchImpl);
    try { packageJson = JSON.parse(Buffer.from(file.content || '', 'base64').toString('utf8')); }
    catch { throw new Error('Repository package.json is invalid'); }
  }
  return detectProjectProfile({ files, packageJson });
}

async function resolveCommit(repository, branch, suppliedSha, fetchImpl) {
  const ref = suppliedSha || branch.split('/').map(encodeURIComponent).join('/');
  const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/commits/${ref}`;
  const commit = await githubJson(base, fetchImpl);
  const sha = commit.sha;
  if (!/^[a-fA-F0-9]{40}$/.test(sha || '')) throw new Error('GitHub did not return a valid commit SHA');
  return sha;
}

async function loadStaticArtifactFiles(query, projectId, artifactIds, storageFetch = fetch, artifactPrefix = '') {
  if (!Array.isArray(artifactIds) || artifactIds.length < 1 || artifactIds.length > 5000 ||
      artifactIds.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) ||
      new Set(artifactIds).size !== artifactIds.length) {
    throw Object.assign(new Error('Select between 1 and 5000 unique completed build artifacts for this static deployment'), { status: 422 });
  }
  const result = await query(
    `select a.id, a.name, a.object_key, a.size_bytes, a.sha256
     from public.artifacts a
     join public.pipeline_runs r on r.id = a.run_id
     join public.projects p on p.id = r.project_id
     where a.id = any($1::uuid[]) and p.id = $2 and a.deleted_at is null
       and (a.expires_at is null or a.expires_at > now())`,
    [artifactIds, projectId],
  );
  if (result.rowCount !== artifactIds.length) throw Object.assign(new Error('One or more selected build artifacts are missing or do not belong to this project'), { status: 422 });
  const storageUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const storageKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!storageUrl || !storageKey) throw Object.assign(new Error('Private artifact storage is not configured'), { status: 503 });
  const names = result.rows.map((artifact) => String(artifact.name || ''));
  let prefix = String(artifactPrefix || '').replace(/^\/+|\/+$/g, '');
  if (!prefix) {
    const common = ['dist', 'build', 'out', 'public'].find((candidate) => names.every((name) => name.startsWith(`${candidate}/`)));
    if (common) prefix = common;
  }
  let total = 0;
  const files = [];
  for (const artifact of result.rows) {
    const storedName = String(artifact.name || '');
    const name = prefix && storedName.startsWith(`${prefix}/`) ? storedName.slice(prefix.length + 1) : storedName;
    if (!name || name.startsWith('/') || name.includes('\\') ||
        name.split('/').some((part) => !part || part === '.' || part === '..')) throw Object.assign(new Error('A build artifact contains an unsafe file path'), { status: 422 });
    const encodedKey = String(artifact.object_key).split('/').map(encodeURIComponent).join('/');
    const response = await storageFetch(`${storageUrl}/storage/v1/object/kestrel-artifacts/${encodedKey}`, {
      headers: { apikey: storageKey, Authorization: `Bearer ${storageKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Object.assign(new Error('A selected build artifact could not be downloaded from private storage'), { status: 502 });
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length !== Number(artifact.size_bytes) ||
        crypto.createHash('sha256').update(content).digest('hex') !== artifact.sha256) {
      throw Object.assign(new Error('A selected build artifact failed its size or SHA-256 integrity check'), { status: 422 });
    }
    total += content.length;
    if (total > 50 * 1024 * 1024) throw Object.assign(new Error('Static build output exceeds the 50 MiB provider upload limit'), { status: 413 });
    files.push({ path: name, content });
  }
  return files;
}

async function loadProjectEnvironment(query, projectId) {
  const result = await query(
    'select name, encrypted_value, iv, auth_tag from public.project_secrets where project_id = $1 order by name',
    [projectId],
  );
  const env = {};
  for (const row of result.rows) {
    env[row.name] = decryptSecret(row.encrypted_value, row.iv, row.auth_tag);
  }
  return env;
}

function deploymentView(row) {
  return {
    id: row.id, projectId: row.project_id, provider: row.provider_id,
    status: row.status, branch: row.branch, commitSha: row.commit_sha,
    providerUrl: row.provider_url, rollbackOf: row.rollback_of,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function registerManagedDeploymentRoutes(app, { userAuth, query, transaction, fetchImpl = fetch, storageFetch = fetch }) {
  app.post('/api/projects/:projectId/managed-deployments', userAuth, async (req, res) => {
    try {
      const projectResult = await query(
        `select p.id, p.organization_id, p.name, p.repository_url, p.default_branch,
                p.source_type, m.role
         from public.projects p
         join public.organization_members m on m.organization_id = p.organization_id
         where p.id = $1 and m.user_id = $2`,
        [req.params.projectId, req.user.id],
      );
      if (!projectResult.rowCount) return fail(res, 404, 'Project not found');
      const project = projectResult.rows[0];
      if (!WRITE_ROLES.includes(project.role)) return fail(res, 403, 'Developer access is required to deploy this project');
      const repository = parseGitHubRepository(project.repository_url);
      if (project.source_type !== 'git' || !repository) {
        return fail(res, 422, 'Managed source deployments currently require a public GitHub repository');
      }

      const branch = String(req.body?.branch || project.default_branch || 'main');
      const commitSha = await resolveCommit(repository, branch, req.body?.commitSha, fetchImpl);
      const profile = await inspectProject(repository, branch, fetchImpl);
      const compatible = rankHostingProviders(profile, {});
      const connectionResult = await query(
        `select provider_id, credentials_ciphertext, credentials_iv, credentials_auth_tag
         from public.hosting_provider_connections
         where organization_id = $1 and status = 'verified'`,
        [project.organization_id],
      );
      const verified = new Map(connectionResult.rows.map((row) => [row.provider_id, row]));
      const selected = compatible.find((provider) => ACTIVE_MANAGED_PROVIDERS.includes(provider.id) && verified.has(provider.id) && (provider.id !== 'netlify' || (Array.isArray(req.body?.artifactIds) && req.body.artifactIds.length > 0)));
      if (!selected) {
        return fail(res, 409, 'No verified compatible managed provider is available. For Netlify static deployments, include artifact IDs from a completed Kestrel build.');
      }

      const providerId = selected.id;
      const projectEnv = await loadProjectEnvironment(query, project.id);
      const staticFiles = providerId === 'netlify' ? await loadStaticArtifactFiles(query, project.id, req.body?.artifactIds, storageFetch, req.body?.artifactPrefix) : null;
      const containerImage = String(req.body?.containerImage || '').trim();
      if (['flyio', 'google-cloud-run', 'aws-ecs-express'].includes(providerId) && !containerImage) {
        return fail(res, 422, 'This provider requires a published OCI image. Connect the Kestrel image build and registry pipeline before deploying this project.');
      }
      const connection = verified.get(providerId);
      let credentials;
      try {
        credentials = JSON.parse(decryptSecret(connection.credentials_ciphertext, connection.credentials_iv, connection.credentials_auth_tag));
      } catch {
        return fail(res, 503, 'Provider credentials could not be decrypted. Check the Kestrel encryption key.');
      }

      const existing = await query(
        `select * from public.managed_hosting_resources
         where organization_id = $1 and project_id = $2 and provider_id = $3`,
        [project.organization_id, project.id, providerId],
      );
      const resource = existing.rows[0] || null;
      const providerInput = {
        repositoryUrl: project.repository_url, branch, commitSha, profile,
        projectName: `kestrel-${project.name}-${String(project.id).slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60),
        containerImage,
        port: req.body?.port || (providerId === 'flyio' ? 3000 : 8080),
        env: projectEnv,
        files: staticFiles,
        buildCommand: req.body?.buildCommand || 'npm run build',
        destinationDir: req.body?.destinationDir || 'dist',
        rootDir: req.body?.rootDir || '/',
      };
      const providerDeployment = resource
        ? await deployManagedProviderService(providerId, credentials, resource, commitSha, { fetchImpl }, { repositoryUrl: project.repository_url, branch, profile, projectName: providerInput.projectName, containerImage: providerInput.containerImage, port: providerInput.port, env: providerInput.env, files: providerInput.files, buildCommand: providerInput.buildCommand, destinationDir: providerInput.destinationDir, rootDir: providerInput.rootDir })
        : await createManagedProviderDeployment(providerId, credentials, providerInput, { fetchImpl });

      const saved = await transaction(async (client) => {
        let resourceId;
        if (resource) {
          resourceId = resource.id;
        } else {
          const insertedResource = await client.query(
            `insert into public.managed_hosting_resources
               (organization_id, project_id, provider_id, provider_project_id,
                provider_service_id, provider_environment_id, provider_url, created_by)
             values($1,$2,$3,$4,$5,$6,$7,$8)
             returning id`,
            [project.organization_id, project.id, providerId, providerDeployment.projectId,
              providerDeployment.serviceId, providerDeployment.environmentId || null,
              providerDeployment.providerUrl || null, req.user.id],
          );
          resourceId = insertedResource.rows[0].id;
        }
        const inserted = await client.query(
          `insert into public.managed_hosting_deployments
             (resource_id, organization_id, project_id, provider_id, provider_deployment_id,
              branch, commit_sha, status, provider_url, created_by)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           returning *`,
          [resourceId, project.organization_id, project.id, providerId, providerDeployment.deploymentId,
            branch, commitSha, providerDeployment.status || 'queued', providerDeployment.providerUrl || null, req.user.id],
        );
        await client.query(
          `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
           values($1,$2,'managed_deployment.queued','managed_deployment',$3,$4::jsonb)`,
          [project.organization_id, req.user.id, inserted.rows[0].id,
            JSON.stringify({ provider: providerId, branch, commitSha })],
        );
        return inserted.rows[0];
      });
      return res.status(202).json({
        deployment: deploymentView(saved), selectedProvider: providerId, profile,
        providerUrl: providerDeployment.providerUrl || null,
      });
    } catch (error) {
      const status = error.status === 404 ? 404 : error.status === 422 ? 422 : 502;
      console.error('Managed deployment request failed:', { code: error.code || 'PROVIDER_ERROR' });
      return fail(res, status, status === 404 ? 'GitHub repository or commit was not found' : 'Could not start managed deployment');
    }
  });

  app.get('/api/projects/:projectId/managed-deployments', userAuth, async (req, res) => {
    try {
      const access = await query(
        `select p.id from public.projects p
         join public.organization_members m on m.organization_id = p.organization_id
         where p.id = $1 and m.user_id = $2`,
        [req.params.projectId, req.user.id],
      );
      if (!access.rowCount) return fail(res, 404, 'Project not found');
      const result = await query(
        `select * from public.managed_hosting_deployments
         where project_id = $1 order by created_at desc limit 100`,
        [req.params.projectId],
      );
      res.json({ deployments: result.rows.map(deploymentView) });
    } catch {
      fail(res, 500, 'Could not load managed deployment history');
    }
  });

  async function loadAuthorizedDeployment(deploymentId, userId) {
    const result = await query(
      `select d.*, c.credentials_ciphertext, c.credentials_iv, c.credentials_auth_tag,
              r.provider_project_id, r.provider_service_id, r.provider_environment_id
       from public.managed_hosting_deployments d
       join public.managed_hosting_resources r on r.id = d.resource_id
       join public.hosting_provider_connections c
         on c.organization_id = d.organization_id and c.provider_id = d.provider_id
       join public.organization_members m on m.organization_id = d.organization_id
       where d.id = $1 and m.user_id = $2 and d.provider_id = any($3)`,
      [deploymentId, userId, ACTIVE_MANAGED_PROVIDERS],
    );
    return result.rows[0] || null;
  }

  app.get('/api/managed-deployments/:deploymentId', userAuth, async (req, res) => {
    try {
      const row = await loadAuthorizedDeployment(req.params.deploymentId, req.user.id);
      if (!row) return fail(res, 404, 'Managed deployment not found');
      const credentials = JSON.parse(decryptSecret(row.credentials_ciphertext, row.credentials_iv, row.credentials_auth_tag));
      const current = await getManagedProviderDeployment(row.provider_id, credentials, row, row.provider_deployment_id, { fetchImpl });
      await query(
        `update public.managed_hosting_deployments
         set status = $2, provider_url = $3,
             provider_deployment_id = coalesce($4, provider_deployment_id), updated_at = now()
         where id = $1`,
        [row.id, current.status, current.providerUrl, current.providerDeploymentId || null],
      );
      if (current.providerUrl) {
        await query(
          `update public.managed_hosting_resources set provider_url = $2, updated_at = now() where id = $1`,
          [row.resource_id, current.providerUrl],
        );
      }
      res.json({ deployment: { ...deploymentView(row), status: current.status, providerUrl: current.providerUrl, providerStatus: current.providerStatus } });
    } catch {
      fail(res, 502, 'Could not retrieve managed deployment status');
    }
  });

  app.get('/api/managed-deployments/:deploymentId/logs', userAuth, async (req, res) => {
    try {
      const row = await loadAuthorizedDeployment(req.params.deploymentId, req.user.id);
      if (!row) return fail(res, 404, 'Managed deployment not found');
      const credentials = JSON.parse(decryptSecret(row.credentials_ciphertext, row.credentials_iv, row.credentials_auth_tag));
      const logs = await getManagedProviderDeploymentLogs(row.provider_id, credentials, row, row.provider_deployment_id, { fetchImpl });
      const projectEnv = await loadProjectEnvironment(query, row.project_id);
      const secrets = [...Object.values(credentials), ...Object.values(projectEnv)].filter((value) => typeof value === 'string' && value.length > 3);
      const redact = (entries = []) => entries.map((entry) => ({
        ...entry, message: redactSecrets(String(entry.message || ''), secrets),
      }));
      res.json({ build: redact(logs.build), runtime: redact(logs.runtime), ...(logs.unavailable ? { unavailable: true, message: logs.message } : {}), ...(logs.logUrls ? { logUrls: logs.logUrls } : {}) });
    } catch {
      fail(res, 502, 'Could not retrieve managed deployment logs');
    }
  });

  app.post('/api/managed-deployments/:deploymentId/rollback', userAuth, async (req, res) => {
    try {
      const row = await loadAuthorizedDeployment(req.params.deploymentId, req.user.id);
      if (!row) return fail(res, 404, 'Managed deployment not found');
      if (!WRITE_ROLES.includes((await query(
        'select role from public.organization_members where organization_id = $1 and user_id = $2',
        [row.organization_id, req.user.id],
      )).rows[0]?.role)) return fail(res, 403, 'Developer access is required to roll back');
      const credentials = JSON.parse(decryptSecret(row.credentials_ciphertext, row.credentials_iv, row.credentials_auth_tag));
      const rollback = await rollbackManagedProviderDeployment(row.provider_id, credentials, row, row.provider_deployment_id, { fetchImpl });
      const saved = await transaction(async (client) => {
        const inserted = await client.query(
          `insert into public.managed_hosting_deployments
             (resource_id, organization_id, project_id, provider_id, provider_deployment_id,
              branch, commit_sha, status, rollback_of, created_by)
           values($1,$2,$3,$10,$4,$5,$6,$7,$8,$9) returning *`,
          [row.resource_id, row.organization_id, row.project_id, rollback.deploymentId,
            row.branch, row.commit_sha, rollback.status, row.id, req.user.id, row.provider_id],
        );
        await client.query(
          `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
           values($1,$2,'managed_deployment.rollback_queued','managed_deployment',$3,$4::jsonb)`,
          [row.organization_id, req.user.id, inserted.rows[0].id, JSON.stringify({ provider: row.provider_id, rollbackOf: row.id })],
        );
        return inserted.rows[0];
      });
      res.status(202).json({ deployment: deploymentView(saved) });
    } catch {
      fail(res, 502, 'Could not roll back managed deployment');
    }
  });
}
