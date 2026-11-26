import { isIP } from 'node:net';
import { decryptSecret, redactSecrets } from './security.mjs';
import { getManagedProviderDeployment } from './hosting-managed-adapters.mjs';

const MAX_HEALTH_ATTEMPTS = 5;
const PROVIDER_HOST_SUFFIXES = {
  render: ['onrender.com'],
  railway: ['up.railway.app', 'railway.app'],
  flyio: ['fly.dev'],
  'google-cloud-run': ['run.app'],
  'aws-ecs-express': ['amazonaws.com'],
  'digitalocean-app-platform': ['ondigitalocean.app'],
  heroku: ['herokuapp.com', 'herokudns.com'],
  vercel: ['vercel.app'],
  netlify: ['netlify.app'],
  'cloudflare-pages': ['pages.dev'],
};

export function normalizeProviderDeploymentStatus(value) {
  const status = String(value || '').trim().toLowerCase().replace(/[ -]+/g, '_');
  if (['live', 'ready', 'succeeded', 'success', 'active', 'completed'].includes(status)) return 'live';
  if (['failed', 'error', 'canceled', 'cancelled'].includes(status)) return 'failed';
  if (['queued', 'pending', 'created', 'accepted'].includes(status)) return 'queued';
  if (['deploying', 'building', 'in_progress', 'running', 'updating'].includes(status)) return 'deploying';
  return 'unknown';
}

export function isSafeProviderHealthUrl(providerId, value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false;
    if (isIP(hostname)) return false;
    const suffixes = PROVIDER_HOST_SUFFIXES[providerId] || [];
    return suffixes.some((suffix) => hostname === suffix || hostname.endsWith('.' + suffix));
  } catch {
    return false;
  }
}

export async function probeProviderReadiness(providerId, providerUrl, { fetchImpl = fetch } = {}) {
  if (!isSafeProviderHealthUrl(providerId, providerUrl)) {
    return { healthy: false, error: 'Provider did not return a supported HTTPS health-check URL' };
  }
  try {
    const response = await fetchImpl(providerUrl, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'Kestrel-Deployment-Readiness/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status >= 200 && response.status < 300) return { healthy: true, statusCode: response.status };
    if (response.status === 405 || response.status === 501) {
      const fallback = await fetchImpl(providerUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { Range: 'bytes=0-0', 'User-Agent': 'Kestrel-Deployment-Readiness/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (fallback.status >= 200 && fallback.status < 300) return { healthy: true, statusCode: fallback.status };
      return { healthy: false, statusCode: fallback.status, error: `Health endpoint returned HTTP ${fallback.status}` };
    }
    return { healthy: false, statusCode: response.status, error: `Health endpoint returned HTTP ${response.status}` };
  } catch (error) {
    return { healthy: false, error: String(error?.message || 'Health check request failed').slice(0, 240) };
  }
}

export async function reconcileManagedDeploymentReadiness({ query, fetchImpl = fetch, logger = console }, limit = 10) {
  // Claim rows in one statement. SKIP LOCKED prevents overlapping cron workers from
  // selecting the same deployment; the timestamp is also used as a fencing token.
  const pending = await query(
    `with candidates as (
       select d.id
       from public.managed_hosting_deployments d
       where d.status in ('queued','deploying','unknown','live')
         and d.health_status in ('pending','checking')
         and d.health_attempt_count < $1
         and (d.health_claimed_at is null or d.health_claimed_at < now() - interval '2 minutes')
         and (d.health_checked_at is null or d.health_checked_at < now() - interval '30 seconds')
       order by d.created_at asc
       for update skip locked
       limit $2
     ), claimed as (
       update public.managed_hosting_deployments d
       set health_status = 'checking', health_claimed_at = now(), updated_at = now()
       from candidates
       where d.id = candidates.id
       returning d.*
     )
     select claimed.*, r.provider_project_id, r.provider_service_id, r.provider_environment_id,
            c.credentials_ciphertext, c.credentials_iv, c.credentials_auth_tag
     from claimed
     join public.managed_hosting_resources r on r.id = claimed.resource_id
     join public.hosting_provider_connections c
       on c.organization_id = claimed.organization_id and c.provider_id = claimed.provider_id and c.status = 'verified'`,
    [MAX_HEALTH_ATTEMPTS, Math.max(1, Math.min(25, Number(limit) || 10))],
  );

  let healthy = 0;
  let unhealthy = 0;
  let pendingCount = 0;
  for (const row of pending.rows) {
    const secrets = [];
    try {
      const credentials = JSON.parse(decryptSecret(row.credentials_ciphertext, row.credentials_iv, row.credentials_auth_tag));
      secrets.push(...Object.values(credentials).filter((value) => typeof value === 'string' && value.length > 3));
      const current = await getManagedProviderDeployment(
        row.provider_id, credentials, row, row.provider_deployment_id, { fetchImpl },
      );
      const status = normalizeProviderDeploymentStatus(current.status);
      let healthStatus = 'pending';
      let healthError = null;
      let checkedAt = false;
      let attemptCount = Number(row.health_attempt_count || 0);
      if (status === 'failed') {
        healthStatus = 'unhealthy';
        healthError = 'Provider reported deployment failure';
        checkedAt = true;
      } else if (status === 'live') {
        const probe = await probeProviderReadiness(row.provider_id, current.providerUrl || row.provider_url, { fetchImpl });
        attemptCount += 1;
        checkedAt = true;
        healthStatus = probe.healthy ? 'healthy' : attemptCount >= MAX_HEALTH_ATTEMPTS ? 'unhealthy' : 'checking';
        healthError = probe.healthy ? null : probe.error;
      } else {
        healthStatus = 'checking';
      }
      await query(
        `update public.managed_hosting_deployments
         set status = case when $4 = 'unhealthy' then 'failed' else $2 end,
             provider_url = coalesce($3, provider_url),
             health_status = $4, health_checked_at = case when $5 then now() else health_checked_at end,
             health_attempt_count = $6, health_claimed_at = null,
             error_message = case when $4 in ('healthy','unhealthy') then $8 else error_message end,
             updated_at = now()
         where id = $1 and health_claimed_at = $9`,
        [row.id, status, current.providerUrl || null, healthStatus, checkedAt, attemptCount,
          healthStatus === 'unhealthy', healthError, row.health_claimed_at],
      );
      if (healthStatus === 'healthy') healthy += 1;
      else if (healthStatus === 'unhealthy') unhealthy += 1;
      else pendingCount += 1;
    } catch (error) {
      const safeError = redactSecrets(String(error?.message || 'Readiness reconciliation failed'), secrets).slice(0, 240);
      logger.warn?.('Managed deployment readiness check failed', { deploymentId: row.id, provider: row.provider_id, error: safeError });
      await query(
        `update public.managed_hosting_deployments
         set status = case when health_attempt_count + 1 >= $2 then 'failed' else status end,
             health_status = case when health_attempt_count + 1 >= $2 then 'unhealthy' else 'checking' end,
             health_attempt_count = health_attempt_count + 1, health_checked_at = now(),
             health_claimed_at = null, error_message = $3, updated_at = now()
         where id = $1 and health_claimed_at = $4`,
        [row.id, MAX_HEALTH_ATTEMPTS, safeError, row.health_claimed_at],
      );
      pendingCount += 1;
    }
  }
  return { checked: pending.rowCount, healthy, unhealthy, pending: pendingCount };
}
