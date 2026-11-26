import { decryptSecret } from './security.mjs';
import { rollbackManagedProviderDeployment } from './hosting-managed-adapters.mjs';

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;
const ROLLBACK_LEASE_MINUTES = 5;

async function recordRollbackEvent(query, row, action, metadata) {
  await query(
    `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
     values($1,$2,$3,'managed_deployment',$4,$5::jsonb)`,
    [row.organization_id, row.created_by || null, action, row.id, JSON.stringify(metadata)],
  );
}

async function updateQueue(query, queueId, status, lastError = null, rollbackDeploymentId = null) {
  await query(
    `update public.managed_hosting_rollback_queue
     set status = $2, last_error = $3, rollback_deployment_id = coalesce($4, rollback_deployment_id),
         locked_at = null, updated_at = now()
     where id = $1`,
    [queueId, status, lastError, rollbackDeploymentId],
  );
}

export async function processManagedDeploymentRollbacks({
  query,
  transaction,
  fetchImpl = fetch,
  logger = console,
  rollbackImpl = rollbackManagedProviderDeployment,
} = {}, limit = DEFAULT_LIMIT) {
  if (typeof query !== 'function' || typeof transaction !== 'function') {
    throw new Error('Managed deployment rollback processing requires query and transaction functions');
  }
  const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));

  const expired = await query(
    `update public.managed_hosting_rollback_queue
     set status = 'failed', locked_at = null,
         last_error = 'Rollback worker lease expired; provider outcome is unknown and requires manual reconciliation.',
         updated_at = now()
     where status = 'running'
       and locked_at < now() - ($1::text || ' minutes')::interval
     returning id`,
    [ROLLBACK_LEASE_MINUTES],
  );

  const claimed = await query(
    `with candidates as (
       select id
       from public.managed_hosting_rollback_queue
       where status = 'queued'
       order by created_at
       for update skip locked
       limit $1
     ), claimed as (
       update public.managed_hosting_rollback_queue q
       set status = 'running', attempt_count = attempt_count + 1,
           locked_at = now(), updated_at = now()
       from candidates c
       where q.id = c.id
       returning q.id as queue_id, q.deployment_id
     )
     select c.queue_id, d.*,
            r.provider_project_id, r.provider_service_id, r.provider_environment_id,
            r.metadata as resource_metadata,
            pc.credentials_ciphertext, pc.credentials_iv, pc.credentials_auth_tag
     from claimed c
     join public.managed_hosting_deployments d on d.id = c.deployment_id
     join public.managed_hosting_resources r on r.id = d.resource_id
     left join public.hosting_provider_connections pc
       on pc.organization_id = d.organization_id
      and pc.provider_id = d.provider_id
      and pc.status = 'verified'
     order by d.created_at`,
    [safeLimit],
  );

  const stats = {
    claimed: claimed.rowCount || claimed.rows?.length || 0,
    rolledBack: 0,
    skipped: 0,
    failed: 0,
    expiredLeases: expired.rowCount || 0,
  };

  for (const row of claimed.rows || []) {
    let rollback = null;
    try {
      if (!row.credentials_ciphertext || !row.credentials_iv || !row.credentials_auth_tag) {
        await updateQueue(query, row.queue_id, 'failed', 'No verified provider credentials are available for automatic rollback.');
        await recordRollbackEvent(query, row, 'managed_deployment.auto_rollback_failed', {
          provider: row.provider_id, reason: 'provider_credentials_unavailable',
        });
        stats.failed += 1;
        continue;
      }

      const previousResult = await query(
        `select id, provider_deployment_id, branch, commit_sha, provider_url
         from public.managed_hosting_deployments
         where resource_id = $1 and id <> $2
           and status = 'live' and health_status = 'healthy'
           and provider_deployment_id is not null
           and created_at < $3
         order by created_at desc
         limit 1`,
        [row.resource_id, row.id, row.created_at],
      );
      const previous = previousResult.rows?.[0];
      if (!previous) {
        await updateQueue(query, row.queue_id, 'skipped', 'No previous healthy deployment exists; automatic rollback was not attempted.');
        await recordRollbackEvent(query, row, 'managed_deployment.auto_rollback_skipped', {
          provider: row.provider_id, reason: 'no_previous_healthy_deployment',
        });
        stats.skipped += 1;
        continue;
      }

      const credentials = JSON.parse(decryptSecret(
        row.credentials_ciphertext,
        row.credentials_iv,
        row.credentials_auth_tag,
      ));
      rollback = await rollbackImpl(
        row.provider_id,
        credentials,
        row,
        previous.provider_deployment_id,
        { fetchImpl },
      );
      if (!rollback?.deploymentId) throw new Error('Provider did not return a rollback deployment identifier');

      const saved = await transaction(async (client) => {
        const inserted = await client.query(
          `insert into public.managed_hosting_deployments
             (resource_id, organization_id, project_id, provider_id, provider_deployment_id,
              branch, commit_sha, status, provider_url, rollback_of, created_by,
              heroku_dyno_size, heroku_dyno_quantity, estimated_monthly_cost_usd,
              cost_approved_by, cost_approved_at, pricing_catalog_version)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           returning *`,
          [
            row.resource_id, row.organization_id, row.project_id, row.provider_id,
            rollback.deploymentId, previous.branch, previous.commit_sha,
            rollback.status || 'deploying', rollback.providerUrl || row.provider_url,
            row.id, row.created_by || null,
            row.heroku_dyno_size || null, row.heroku_dyno_quantity || null,
            row.estimated_monthly_cost_usd || null, row.cost_approved_by || null,
            row.cost_approved_at || null, row.pricing_catalog_version || null,
          ],
        );
        await client.query(
          `update public.managed_hosting_rollback_queue
           set status = 'succeeded', rollback_deployment_id = $2,
               last_error = null, locked_at = null, updated_at = now()
           where id = $1`,
          [row.queue_id, inserted.rows[0].id],
        );
        await client.query(
          `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
           values($1,$2,'managed_deployment.auto_rollback_succeeded','managed_deployment',$3,$4::jsonb)`,
          [row.organization_id, row.created_by || null, inserted.rows[0].id, JSON.stringify({
            provider: row.provider_id,
            failedDeploymentId: row.id,
            previousDeploymentId: previous.id,
            rollbackDeploymentId: inserted.rows[0].id,
          })],
        );
        return inserted.rows[0];
      });

      stats.rolledBack += 1;
      logger.info?.('Managed deployment automatically rolled back', {
        deploymentId: row.id, rollbackDeploymentId: saved.id, provider: row.provider_id,
      });
    } catch (error) {
      const code = error?.status ? `http_${error.status}` : error?.code || 'provider_rollback_error';
      const lastError = rollback?.deploymentId
        ? `Provider rollback ${rollback.deploymentId} may have completed but history persistence failed; manual reconciliation is required.`
        : `Automatic provider rollback failed (${String(code).slice(0, 80)}); manual reconciliation is required.`;
      try {
        await updateQueue(query, row.queue_id, 'failed', lastError);
        await recordRollbackEvent(query, row, 'managed_deployment.auto_rollback_failed', {
          provider: row.provider_id, errorCode: code,
          providerRollbackId: rollback?.deploymentId || null,
          manualReconciliationRequired: true,
        });
      } catch (recordError) {
        logger.error?.('Could not persist automatic rollback failure state', {
          queueId: row.queue_id, deploymentId: row.id, code: recordError?.code || 'DATABASE_ERROR',
        });
      }
      logger.warn?.('Managed deployment automatic rollback failed', {
        queueId: row.queue_id, deploymentId: row.id, provider: row.provider_id, errorCode: code,
      });
      stats.failed += 1;
    }
  }

  return stats;
}
