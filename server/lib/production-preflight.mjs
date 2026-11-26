export function validateKestrelEnvironment(env = process.env, nodeVersion = process.versions.node) {
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === 'production';
  const nodeMajor = Number.parseInt(String(nodeVersion).split('.')[0], 10);

  if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
    errors.push(`Node.js version >= 20 is required (currently ${nodeVersion})`);
  }

  const databaseUrl = env.SUPABASE_DB_URL || env.DATABASE_URL;
  if (!databaseUrl || /\\[PASSWORD\\]/i.test(databaseUrl)) {
    errors.push('SUPABASE_DB_URL or DATABASE_URL is missing or contains placeholder values');
  } else {
    try {
      const parsed = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        errors.push('SUPABASE_DB_URL or DATABASE_URL must use the PostgreSQL protocol');
      }
    } catch {
      errors.push('SUPABASE_DB_URL or DATABASE_URL must be a valid PostgreSQL connection URL');
    }
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    warnings.push('Supabase browser authentication is not fully configured; built-in JWT mode may be used.');
  }

  if (production) {
    if (typeof env.KESTREL_ENCRYPTION_KEY !== 'string' || env.KESTREL_ENCRYPTION_KEY.length < 32) {
      errors.push('KESTREL_ENCRYPTION_KEY must be configured with at least 32 characters in production');
    }
    if (typeof env.JWT_SECRET !== 'string' || env.JWT_SECRET.length < 32) {
      errors.push('JWT_SECRET must be configured with at least 32 characters in production');
    }
    const cronSecret = env.KESTREL_CRON_SECRET || env.CRON_SECRET;
    if (typeof cronSecret !== 'string' || cronSecret.length < 32) {
      errors.push('KESTREL_CRON_SECRET or CRON_SECRET must be configured with at least 32 characters in production');
    }

    let storageUrl;
    try { storageUrl = new URL(env.SUPABASE_URL || ''); } catch {}
    if (!storageUrl || storageUrl.protocol !== 'https:') {
      errors.push('SUPABASE_URL must be a valid HTTPS URL in production');
    }
    if (typeof env.SUPABASE_SERVICE_ROLE_KEY !== 'string' || env.SUPABASE_SERVICE_ROLE_KEY.length < 32) {
      errors.push('SUPABASE_SERVICE_ROLE_KEY is required for private project and artifact storage in production');
    }
    if (env.DB_SSL === 'disable') {
      errors.push('DB_SSL=disable is not permitted in production');
    }
    if (env.DB_SSL_REJECT_UNAUTHORIZED === 'false') {
      errors.push('DB_SSL_REJECT_UNAUTHORIZED=false is not permitted in production; configure the trusted CA instead');
    }
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
      warnings.push('GitHub App credentials are incomplete; installation-based repository import and webhooks may be unavailable.');
    }
  }

  return { errors, warnings };
}
