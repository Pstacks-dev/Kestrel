import { encryptSecret, decryptSecret, redactSecrets } from './security.mjs';
import { provisionProviderImageRegistry } from './oci-registries.mjs';
import { detectProjectProfile, rankHostingProviders } from './hosting-providers.mjs';
import {
  ACTIVE_MANAGED_PROVIDERS, createManagedProviderDeployment, deployManagedProviderService,
} from './hosting-managed-adapters.mjs';
import { loadStaticArtifactFiles } from '../routes/managed-deployments.mjs';

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Kestrel-Managed-Hosting-Automation',
};

async function githubJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`GitHub source inspection failed (${response.status})`);
  return response.json();
}

function parsePublicGitHubRepository(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part))) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch { return null; }
}

async function inspectSource(repository, commitSha, fetchImpl) {
  const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const root = await githubJson(`${base}/contents/?ref=${encodeURIComponent(commitSha)}`, fetchImpl);
  if (!Array.isArray(root)) throw new Error('GitHub repository root could not be inspected');
  const files = root.filter((item) => item.type === 'file').map((item) => item.name);
  let packageJson = null;
  if (files.some((name) => name.toLowerCase() === 'package.json')) {
    const file = await githubJson(`${base}/contents/package.json?ref=${encodeURIComponent(commitSha)}`, fetchImpl);
    try { packageJson = JSON.parse(Buffer.from(file.content || '', 'base64').toString('utf8')); }
    catch { throw new Error('Repository package.json is invalid'); }
  }
  return detectProjectProfile({ files, packageJson });
}

async function loadProjectEnvironment(query, projectId) {
  const result = await query(
    'select name, encrypted_value, iv, auth_tag from public.project_secrets where project_id = $1',
    [projectId],
  );
  const env = {};
  for (const row of result.rows) {
    env[row.name] = decryptSecret(row.encrypted_value, row.iv, row.auth_tag);
  }
  return env;
}

function projectSlug(project) {
  const slug = `kestrel-${project.name}-${String(project.id).slice(0, 8)}`
    .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return slug || `kestrel-${String(project.id).slice(0, 8)}`;
}

async function markQueue(query, queueId, status, error = null, attemptCount = 0) {
  const retry = status === 'failed' && attemptCount < 6;
  await query(
    `update public.managed_hosting_automation_queue
     set status = $2, locked_at = null, last_error = $3,
         available_at = case when $4 then now() + make_interval(secs => least(900, 15 * power(2, greatest($5 - 1, 0)))::int) else available_at end,
         updated_at = now()
     where id = $1`,
    [queueId, retry ? 'queued' : status, error ? String(error).slice(0, 500) : null, retry, attemptCount],
  );
}

async function processQueueItem(item, { query, transaction, fetchImpl }) {
  try {
    const result = await query(
      `select r.id as run_id, r.project_id, r.branch, r.commit_sha, r.status as run_status,
              p.organization_id, p.name as project_name, p.repository_url, p.default_branch, p.source_type
       from public.pipeline_runs r join public.projects p on p.id = r.project_id
       where r.id = $1`,
      [item.pipeline_run_id],
    );
    const run = result.rows[0];
    if (!run || run.run_status !== 'succeeded') {
      await markQueue(query, item.id, 'skipped', 'Pipeline run is no longer successful', item.attempt_count);
      return { status: 'skipped' };
    }
    if (run.source_type !== 'git' || run.branch !== run.default_branch) {
      await markQueue(query, item.id, 'skipped', 'Automatic production deployments are limited to successful default-branch Git runs', item.attempt_count);
      return { status: 'skipped' };
    }
    if (!/^[a-fA-F0-9]{40}$/.test(run.commit_sha || '')) {
      await markQueue(query, item.id, 'skipped', 'Pipeline run has no immutable Git commit SHA', item.attempt_count);
      return { status: 'skipped' };
    }
    const repository = parsePublicGitHubRepository(run.repository_url);
    if (!repository) {
      await markQueue(query, item.id, 'skipped', 'Automatic managed deployments currently require a public GitHub repository', item.attempt_count);
      return { status: 'skipped' };
    }

    const profile = await inspectSource(repository, run.commit_sha, fetchImpl);
    const compatible = rankHostingProviders(profile, {});
    const connections = await query(
      `select provider_id, credentials_ciphertext, credentials_iv, credentials_auth_tag
       from public.hosting_provider_connections
       where organization_id = $1 and status = 'verified'`,
      [run.organization_id],
    );
    const verified = new Map(connections.rows.map((row) => [row.provider_id, row]));
    const artifacts = profile.isStatic
      ? await query('select id from public.artifacts where run_id = $1 and deleted_at is null and (expires_at is null or expires_at > now()) order by created_at', [run.run_id])
      : { rows: [] };
    const env = await loadProjectEnvironment(query, run.project_id);
    const selected = compatible.find((provider) =>
      ACTIVE_MANAGED_PROVIDERS.includes(provider.id) &&
      verified.has(provider.id) &&
      (provider.id !== 'netlify' || (artifacts.rows.length > 0 && Object.keys(env).length === 0)));
    if (!selected) {
      await markQueue(query, item.id, 'skipped', 'No verified compatible provider is available. Netlify requires successful static artifacts and currently cannot sync project secrets.', item.attempt_count);
      return { status: 'skipped' };
    }

    const connection = verified.get(selected.id);
    const credentials = JSON.parse(decryptSecret(connection.credentials_ciphertext, connection.credentials_iv, connection.credentials_auth_tag));
    let containerImage = null;
    if (['flyio', 'google-cloud-run', 'aws-ecs-express'].includes(selected.id)) {
      let imageBuild = item.image_build_id ? (await query(
        'select * from public.managed_hosting_image_builds where id = $1 and organization_id = $2 and project_id = $3',
        [item.image_build_id, run.organization_id, run.project_id],
      )).rows[0] : null;
      if (!imageBuild) {
        const registry = await provisionProviderImageRegistry(
          selected.id, credentials, projectSlug({ name: run.project_name, id: run.project_id }), run.commit_sha, { fetchImpl },
        );
        const username = encryptSecret(registry.username);
        const password = encryptSecret(registry.password);
        const inserted = await query(
          `insert into public.managed_hosting_image_builds
             (automation_queue_id, organization_id, project_id, provider_id, repository_url, branch,
              commit_sha, image, registry, registry_username_ciphertext, registry_username_iv,
              registry_username_auth_tag, registry_password_ciphertext, registry_password_iv,
              registry_password_auth_tag)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           on conflict (automation_queue_id) do update set updated_at = now()
           returning *`,
          [item.id, run.organization_id, run.project_id, selected.id, run.repository_url, run.branch,
            run.commit_sha, registry.image, registry.registry, username.encryptedValue, username.iv,
            username.authTag, password.encryptedValue, password.iv, password.authTag],
        );
        imageBuild = inserted.rows[0] || (await query(
          'select * from public.managed_hosting_image_builds where automation_queue_id = $1',
          [item.id],
        )).rows[0];
        await query(
          'update public.managed_hosting_automation_queue set image_build_id = $2, status = \'queued\', locked_at = null, available_at = now() + interval \'20 seconds\', updated_at = now() where id = $1',
          [item.id, imageBuild.id],
        );
        return { status: 'waiting_for_image', imageBuildId: imageBuild.id, provider: selected.id };
      }
      if (imageBuild.status !== 'succeeded' || !imageBuild.image_digest_ref) {
        if (imageBuild.status === 'failed' && imageBuild.attempt_count >= 4) {
          await markQueue(query, item.id, 'skipped', 'Managed OCI image build exhausted its retry budget', item.attempt_count);
          return { status: 'skipped' };
        }
        await query(
          'update public.managed_hosting_automation_queue set status = \'queued\', locked_at = null, available_at = now() + interval \'30 seconds\', updated_at = now() where id = $1',
          [item.id],
        );
        return { status: 'waiting_for_image', imageBuildId: imageBuild.id, buildStatus: imageBuild.status };
      }
      containerImage = imageBuild.image_digest_ref;
    }
    const files = selected.id === 'netlify'
      ? await loadStaticArtifactFiles(query, run.project_id, artifacts.rows.map((row) => row.id), fetchImpl, '', run.commit_sha)
      : undefined;
    const existingResult = await query(
      `select * from public.managed_hosting_resources
       where organization_id = $1 and project_id = $2 and provider_id = $3`,
      [run.organization_id, run.project_id, selected.id],
    );
    const resource = existingResult.rows[0] || null;
    const providerInput = {
      repositoryUrl: run.repository_url,
      branch: run.branch,
      commitSha: run.commit_sha,
      profile,
      projectName: projectSlug({ name: run.project_name, id: run.project_id }),
      containerImage,
      env,
      files,
      buildCommand: 'npm run build',
      destinationDir: profile.outputDirectory || 'dist',
      rootDir: '/',
    };
    const providerDeployment = resource
      ? await deployManagedProviderService(selected.id, credentials, resource, run.commit_sha, { fetchImpl }, providerInput)
      : await createManagedProviderDeployment(selected.id, credentials, providerInput, { fetchImpl });

    const saved = await transaction(async (client) => {
      let resourceId = resource?.id;
      if (!resourceId) {
        const insertedResource = await client.query(
          `insert into public.managed_hosting_resources
             (organization_id, project_id, provider_id, provider_project_id, provider_service_id,
              provider_environment_id, provider_url, created_by)
           values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [run.organization_id, run.project_id, selected.id, providerDeployment.projectId,
            providerDeployment.serviceId, providerDeployment.environmentId || null,
            providerDeployment.providerUrl || null, null],
        );
        resourceId = insertedResource.rows[0].id;
      }
      const inserted = await client.query(
        `insert into public.managed_hosting_deployments
           (resource_id, organization_id, project_id, provider_id, provider_deployment_id,
            branch, commit_sha, status, provider_url, created_by)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,null) returning id`,
        [resourceId, run.organization_id, run.project_id, selected.id, providerDeployment.deploymentId,
          run.branch, run.commit_sha, providerDeployment.status || 'queued', providerDeployment.providerUrl || null],
      );
      await client.query(
        'insert into public.audit_events(organization_id, action, target_type, target_id, metadata) values($1,$2,$3,$4,$5::jsonb)',
        [run.organization_id, 'managed_deployment.auto_queued', 'managed_deployment', inserted.rows[0].id,
          JSON.stringify({ provider: selected.id, branch: run.branch, commitSha: run.commit_sha, pipelineRunId: run.run_id })],
      );
      return inserted.rows[0];
    });
    await markQueue(query, item.id, 'succeeded', null, item.attempt_count);
    return { status: 'succeeded', deploymentId: saved.id, provider: selected.id };
  } catch (error) {
    const safeMessage = redactSecrets(String(error?.message || 'Managed deployment failed'));
    await markQueue(query, item.id, 'failed', safeMessage, item.attempt_count);
    return { status: 'failed', error: safeMessage };
  }
}

export async function processManagedHostingQueue({ query, transaction, fetchImpl = fetch, logger = console }, limit = 5) {
  let processed = 0;
  for (let count = 0; count < Math.max(1, Math.min(20, Number(limit) || 5)); count += 1) {
    const claimed = await query(
      `with candidate as (
         select q.id
         from public.managed_hosting_automation_queue q
         where q.status in ('queued','failed')
           and q.attempt_count < 6
           and q.available_at <= now()
           and (q.locked_at is null or q.locked_at < now() - interval '10 minutes')
           and not exists (
             select 1 from public.managed_hosting_automation_queue running
             where running.project_id = q.project_id and running.status = 'running'
           )
         order by q.created_at
         for update skip locked
         limit 1
       )
       update public.managed_hosting_automation_queue q
       set status = 'running', attempt_count = attempt_count + 1, locked_at = now(), updated_at = now()
       from candidate where q.id = candidate.id
       returning q.*`,
    );
    if (!claimed.rowCount) break;
    const outcome = await processQueueItem(claimed.rows[0], { query, transaction, fetchImpl });
    if (outcome.status === 'failed') logger.error?.('Managed deployment automation attempt failed', { queueId: claimed.rows[0].id, error: outcome.error });
    processed += 1;
  }
  return { processed };
}

export function startManagedHostingAutomation(dependencies) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await processManagedHostingQueue(dependencies, 5);
    } catch (error) {
      dependencies.logger?.error?.('Managed deployment automation queue poll failed', { message: error?.message });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 15000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
