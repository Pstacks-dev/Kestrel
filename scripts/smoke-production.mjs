const productionUrl = process.env.KESTREL_PRODUCTION_URL;
if (!productionUrl) {
  console.error('KESTREL_PRODUCTION_URL is required for production smoke checks');
  process.exitCode = 1;
} else {
  try {
    const base = new URL(productionUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
      throw new Error('KESTREL_PRODUCTION_URL must be a clean HTTPS origin without credentials, path, query or fragment');
    }

    const results = [];
    for (const endpoint of ['/api/health', '/api/ready']) {
      const response = await fetch(new URL(endpoint, base), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(Number(process.env.KESTREL_SMOKE_TIMEOUT_MS || 15000)),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`${endpoint} returned a non-JSON response (HTTP ${response.status})`);
      }
      if (!response.ok || payload?.ok !== true) {
        const detail = endpoint === '/api/ready'
          ? `database=${payload?.database || 'unknown'}, schema=${payload?.schema || 'unknown'}, workers=${payload?.workers?.status || 'unknown'}, storage=${payload?.artifactStorage || 'unknown'}`
          : `database=${payload?.database || 'unknown'}`;
        throw new Error(`${endpoint} is unhealthy (HTTP ${response.status}; ${detail})`);
      }
      if (payload.service !== 'kestrel-control-plane') {
        throw new Error(`${endpoint} responded from an unexpected service`);
      }
      results.push({
        endpoint,
        status: response.status,
        database: payload.database,
        schema: payload.schema,
        artifactStorage: payload.artifactStorage,
        workers: payload.workers,
      });
    }
    console.log(JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), results }));
  } catch (error) {
    console.error('[production-smoke] Health verification failed:', error.message);
    process.exitCode = 1;
  }
}
