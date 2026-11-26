export function isGitHubWebhookSecretReadableRole(role) {
  return ['owner', 'admin', 'developer'].includes(role);
}

export function isSupportedGitHubWebhookEvent(event) {
  return event === 'push' || event === 'pull_request';
}

export function shouldQueuePullRequestAction(action) {
  return ['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action);
}

export function shouldIgnoreGitHubPush(payload) {
  return payload?.deleted === true || /^0{40}$/.test(payload?.after || '');
}

export function isValidGitHubDeliveryId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9-]+$/.test(value);
}

export function isValidGitBranch(value) {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) &&
    !value.includes('..') && !value.endsWith('/') && !value.includes('//');
}

export function isValidGitCommitSha(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{40}$/.test(value);
}

export function isValidGitHubInstallationId(value) {
  // GitHub installation IDs are positive integer identifiers stored as bigint.
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

/**
 * Claim a project webhook delivery inside the same transaction that creates
 * its pipeline run. The unique delivery ID makes provider retries idempotent.
 */
export async function claimGitHubProjectWebhookDelivery(client, {
  projectId,
  deliveryId,
  eventName,
  branch,
  commitSha,
}) {
  if (!projectId || !isValidGitHubDeliveryId(deliveryId) ||
      !isSupportedGitHubWebhookEvent(eventName) ||
      !isValidGitBranch(branch) || !isValidGitCommitSha(commitSha)) {
    throw new TypeError('Invalid GitHub project webhook delivery');
  }
  const accepted = await client.query(
    `insert into public.github_webhook_deliveries(project_id, delivery_id, event_name, branch, commit_sha)
     values($1,$2,$3,$4,$5) on conflict (delivery_id) do nothing returning id`,
    [projectId, deliveryId, eventName, branch, commitSha],
  );
  return accepted.rowCount > 0 ? accepted.rows[0] : null;
}
