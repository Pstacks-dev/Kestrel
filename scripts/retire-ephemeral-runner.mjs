const api = String(process.env.KESTREL_API_URL || '').replace(/\/+$/, '');
const secret = process.env.KESTREL_EPHEMERAL_RUNNER_SECRET || '';
const workerId = process.env.KESTREL_WORKER_ID || '';
if (!api || !/^https:\/\//i.test(api) || !secret || secret.length < 32 || !/^wrk_[A-Za-z0-9_-]{20,40}$/.test(workerId)) {
  console.log('No ephemeral worker credentials available for retirement.');
  process.exit(0);
}
const response = await fetch(api + '/api/runners/retire', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
  body: JSON.stringify({ workerId }),
  signal: AbortSignal.timeout(15000),
});
if (!response.ok && response.status !== 404) throw new Error('Kestrel ephemeral worker retirement failed: HTTP ' + response.status);
console.log('Ephemeral worker retired and its credential revoked.');
