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
