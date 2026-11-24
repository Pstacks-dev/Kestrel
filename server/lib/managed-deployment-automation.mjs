import { decryptSecret } from './security.mjs';
import { parseGitHubRepository } from '../routes/git-import.mjs';
import { loadStaticArtifactFiles } from '../routes/managed-deployments.mjs';
import { detectProjectProfile, rankHostingProviders } from './hosting-providers.mjs';
import {
  ACTIVE_MANAGED_PROVIDERS, createManagedProviderDeployment, deployManagedProviderService,
} from './hosting-managed-adapters.mjs';

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Kestrel-Automatic-Deployments',
};

export function shouldAutomaticallyDeployRun({ status, eventName, branch, defaultBranch }) {
  return status === 'succeeded' && eventName === 'push' && Boolean(branch) &&
    branch === (defaultBranch || 'main');
}

async function githubJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Could not inspect the source repository for automatic deployment');
  return response.json();
}

async function inspectProfile(repositoryUrl, branch, fetchImpl) {
  const repository = parseGitHubRepository(repositoryUrl);
  if (!repository) throw new Error('Automatic managed deployments require a public GitHub repository');
  const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const root = await githubJson(`${base}/contents/?ref=${encodeURIComponent(branch)}`, fetchImpl);
  if (!Array.isArray(root)) throw new Error('Could not inspect repository files');
  const files = root.filter((item) => item.type === 'file').map((item) => item.name);
  let packageJson = null;
  if (files.some((name) => name.toLowerCase() === 'package.json')) {
    const file = await githubJson(`${base}/contents/package.json?ref=${encodeURIComponent(branch)}`, fetchImpl);
    try { packageJson = JSON.parse(Buffer.from(file.content || '', 'base64').toString('utf8')); }
    catch { throw new Error('Repository package.json is invalid'); }
  }
  return detectProjectProfile({ files, packageJson });
}

async function projectEnvironment(query, projectId) {
  const result = await query(
    'select name, encrypted_value, iv, auth_tag from public.project_secrets where project_id = $1 order by name',
    [projectId],
  );
  const env = {};
  for (const row of result.rows) env[row.name] = decryptSecret(row.encrypted_value, row.iv, row.auth_tag);
  return env;
}

function safeProjectName(project) {
  return `kestrel-${String(project.name || 'app')}-${String(project.id).slice(0, 8)}`
    .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 60);
}

async function claimRun(runId, query, transaction) {
  return transaction(async (client) => {
    const run = await client.query(
      `select r.id as run_id, r.project_id, r.branch, r.commit_sha, r.status,
              p.organization_id, p.name as project_name, p.repository_url, p.default_branch,
              d.event_name
       from public.pipeline_runs r
       join public.projects p on p.id = r.project_id
       join public.github_webhook_deliveries d on d.run_id = r.id
       where r.id = $1
       for update of r`,
      [runId],
    );
    if (!run.rowCount) return null;
    const value = run.rows[0];
    if (!shouldAutomaticallyDeployRun({
      status: value.status, eventName: value.event_name, branch: value.branch, defaultBranch: value.default_branch,
    })) return null;

    await client.query(
      `insert into public.managed_hosting_deployment_queue(run_id, project_id, organization_id)
       values($1,$2,$3) on conflict(run_id) do nothing`,
      [value.run_id, value.project_id, value.organization_id],
    );
    const queue = await client.query(
      `select * from public.managed_hosting_deployment_queue
       where run_id = $1 for update`,
      [runId],
    );
    if (!queue.rowCount || !['queued', 'failed'].includes(queue.rows[0].status) ||
        queue.rows[0].attempts >= 5 || new Date(queue.rows[0].next_attempt_at).getTime() > Date.now()) return null;
    const claimed = await client.query(
      `update public.managed_hosting_deployment_queue
       set status = 'processing', attempts = attempts + 1, locked_at = now(),
           error_message = null, updated_at = now()
       where id = $1 returning *`,
      [queue.rows[0].id],
    );
    return { run: value, queue: claimed.rows[0] };
  });
}

async function markQueue(query, queueId, status, { deploymentId = null, errorMessage = null, retry = false } = {}) {
  await query(
    `update public.managed_hosting_deployment_queue
     set status = $2, deployment_id = coalesce($3, deployment_id),
         error_message = $4, locked_at = null,
         next_attempt_at = case when $5 then now() + make_interval(secs => least(900, 30 * power(2, least(attempts - 1, 4)))::int) else next_attempt_at end,
         updated_at = now()
     where id = $1`,
    [queueId, status, deploymentId, errorMessage, retry],
  );
}

export async function processManagedDeploymentRun({
  runId, query, transaction, fetchImpl = fetch, storageFetch = fetch,
}) {
  const claimed = await claimRun(runId, query, transaction);
  if (!claimed) return { processed: false, reason: 'not-eligible-or-already-processed' };
  const { run, queue } = claimed;
  try {
    const profile = await inspectProfile(run.repository_url, run.branch, fetchImpl);
    const env = await projectEnvironment(query, run.project_id);
    const connections = await query(
      `select provider_id, credentials_ciphertext, credentials_iv, credentials_auth_tag
       from public.hosting_provider_connections
       where organization_id = $1 and status = 'verified'`,
      [run.organization_id],
    );
    const verified = new Map(connections.rows.map((row) => [row.provider_id, row]));
    const artifactResult = profile.isStatic
      ? await query(
        'select id from public.artifacts where run_id = $1 and deleted_at is null and (expires_at is null or expires_at > now()) order by created_at',
        [run.run_id],
      )
      : { rows: [] };
    const artifactIds = artifactResult.rows.map((row) => row.id);
    const selected = rankHostingProviders(profile, {}).find((provider) =>
      ACTIVE_MANAGED_PROVIDERS.includes(provider.id) && verified.has(provider.id) &&
      (provider.id !== 'netlify' || (artifactIds.length > 0 && Object.keys(env).length === 0)));
    if (!selected) {
      await markQueue(query, queue.id, 'skipped', { errorMessage: 'No verified compatible provider is available for this successful build.' });
      return { processed: true, status: 'skipped' };
    }

    const connection = verified.get(selected.id);
    const credentials = JSON.parse(decryptSecret(
      connection.credentials_ciphertext, connection.credentials_iv, connection.credentials_auth_tag,
    ));
    const existing = await query(
      `select * from public.managed_hosting_resources
       where organization_id = $1 and project_id = $2 and provider_id = $3`,
      [run.organization_id, run.project_id, selected.id],
    );
    const resource = existing.rows[0] || null;
    const files = selected.id === 'netlify'
      ? await loadStaticArtifactFiles(query, run.project_id, artifactIds, storageFetch)
      : null;
    const input = {
      repositoryUrl: run.repository_url, branch: run.branch, commitSha: run.commit_sha,
      profile, projectName: safeProjectName({ name: run.project_name, id: run.project_id }),
      env, files, buildCommand: 'npm run build', destinationDir: 'dist', rootDir: '/',
      port: selected.id === 'flyio' ? 3000 : 8080,
    };
    const providerDeployment = resource
      ? await deployManagedProviderService(selected.id, credentials, resource, run.commit_sha, { fetchImpl }, input)
      : await createManagedProviderDeployment(selected.id, credentials, input, { fetchImpl });
    if (!providerDeployment?.deploymentId || !providerDeployment?.projectId || !providerDeployment?.serviceId) {
      throw new Error('Hosting provider did not return deployment resource identifiers');
    }

    const saved = await transaction(async (client) => {
      let resourceId;
      if (resource) {
        resourceId = resource.id;
        await client.query(
          'update public.managed_hosting_resources set provider_url = coalesce($2, provider_url), updated_at = now() where id = $1',
          [resourceId, providerDeployment.providerUrl || null],
        );
      } else {
        const inserted = await client.query(
          `insert into public.managed_hosting_resources
             (organization_id, project_id, provider_id, provider_project_id, provider_service_id,
              provider_environment_id, provider_url)
           values($1,$2,$3,$4,$5,$6,$7) returning id`,
          [run.organization_id, run.project_id, selected.id, providerDeployment.projectId,
            providerDeployment.serviceId, providerDeployment.environmentId || null, providerDeployment.providerUrl || null],
        );
        resourceId = inserted.rows[0].id;
      }
      const deployment = await client.query(
        `insert into public.managed_hosting_deployments
           (resource_id, organization_id, project_id, provider_id, provider_deployment_id,
            branch, commit_sha, status, provider_url)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [resourceId, run.organization_id, run.project_id, selected.id, providerDeployment.deploymentId,
          run.branch, run.commit_sha, providerDeployment.status || 'queued', providerDeployment.providerUrl || null],
      );
      await client.query(
        `insert into public.audit_events(organization_id, action, target_type, target_id, metadata)
         values($1,'managed_deployment.auto_queued','managed_deployment',$2,$3::jsonb)`,
        [run.organization_id, deployment.rows[0].id, JSON.stringify({ provider: selected.id, runId: run.run_id, commitSha: run.commit_sha })],
      );
      await client.query(
        `update public.managed_hosting_deployment_queue
         set status = 'succeeded', deployment_id = $2, error_message = null, locked_at = null, updated_at = now()
         where id = $1`,
        [queue.id, deployment.rows[0].id],
      );
      return deployment.rows[0];
    });
    return { processed: true, status: 'succeeded', deploymentId: saved.id, provider: selected.id };
  } catch (error) {
    await markQueue(query, queue.id, 'failed', {
      errorMessage: 'Automatic provider deployment failed. Review the provider connection and retry.',
      retry: queue.attempts < 5,
    });
    console.error('Automatic managed deployment failed:', { runId, queueId: queue.id, code: error.code || 'PROVIDER_ERROR' });
    return { processed: true, status: 'failed' };
  }
}

export async function processManagedDeploymentQueue({ query, transaction, fetchImpl = fetch, storageFetch = fetch, limit = 10 }) {
  const pending = await query(
    `select run_id from public.managed_hosting_deployment_queue
     where status in ('queued','failed') and attempts < 5 and next_attempt_at <= now()
     order by created_at asc limit $1`,
    [Math.max(1, Math.min(50, Number(limit) || 10))],
  );
  const results = [];
  for (const item of pending.rows) {
    results.push(await processManagedDeploymentRun({ runId: item.run_id, query, transaction, fetchImpl, storageFetch }));
  }
  return results;
}
