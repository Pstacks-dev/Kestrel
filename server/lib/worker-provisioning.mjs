export function validateWorkerProvisioning(input = {}) {
  const name = String(input.name ?? 'Kestrel Worker').trim();
  const region = String(input.region ?? 'unknown').trim() || 'unknown';
  const maxConcurrency = Number(input.maxConcurrency ?? 1);
  const runtime = String(input.runtime ?? 'rust').toLowerCase();
  if (name.length < 2 || name.length > 80 || region.length > 80 ||
      !Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8 ||
      !['node', 'rust'].includes(runtime)) {
    return { ok: false, error: 'Worker name (2-80), region (max 80), concurrency (1-8), and runtime (node or rust) are required' };
  }
  return { ok: true, name, region, maxConcurrency, runtime };
}
