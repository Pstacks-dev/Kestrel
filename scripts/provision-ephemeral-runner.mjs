import fs from 'node:fs/promises';

const api = String(process.env.KESTREL_API_URL || '').replace(/\/+$/, '');
const secret = process.env.KESTREL_EPHEMERAL_RUNNER_SECRET || '';
if (!api || !/^https:\/\//i.test(api) || !secret || secret.length < 32) {
  throw new Error('KESTREL_API_URL (HTTPS) and KESTREL_EPHEMERAL_RUNNER_SECRET (32+ chars) are required');
}

const response = await fetch(api + '/api/runners/provision', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
  body: JSON.stringify({ hostname: process.env.RUNNER_NAME || 'github-hosted-runner' }),
  signal: AbortSignal.timeout(15000),
});
if (response.status === 204) {
  await fs.appendFile(process.env.GITHUB_OUTPUT, 'has_work=false\n');
  console.log('No queued build requires an ephemeral runner.');
  process.exit(0);
}
if (!response.ok) throw new Error('Kestrel runner provisioning failed: HTTP ' + response.status);
const result = await response.json();
if (!result.ok || !/^wrk_[A-Za-z0-9_-]{20,40}$/.test(result.workerId) || typeof result.token !== 'string' || result.token.length < 32) {
  throw new Error('Kestrel returned an invalid ephemeral worker credential');
}
console.log('::add-mask::' + result.token);
await fs.appendFile(process.env.GITHUB_ENV, [
  'KESTREL_WORKER_ID=' + result.workerId,
  'KESTREL_WORKER_TOKEN=' + result.token,
].join('\n') + '\n');
await fs.appendFile(process.env.GITHUB_OUTPUT, 'has_work=true\n');
console.log('Provisioned one short-lived worker for a queued build.');
