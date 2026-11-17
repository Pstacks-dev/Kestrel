import 'dotenv/config';

const isProduction = process.env.NODE_ENV === 'production';
const errors = [];
const warnings = [];
const has = (name) => Boolean(String(process.env[name] || '').trim());

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 20) errors.push(`Node.js >= 20 is required (currently ${process.version})`);

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  errors.push('SUPABASE_DB_URL (or DATABASE_URL) is required');
} else {
  try {
    const parsed = new URL(dbUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) errors.push('Database URL must use postgres:// or postgresql://');
    if (!parsed.hostname || !parsed.username || !parsed.password || !parsed.pathname || parsed.pathname === '/') {
      errors.push('Database URL must include host, username, password, and database name');
    }
    if (isProduction && parsed.searchParams.get('sslmode') === 'disable') errors.push('Production database connections must not disable TLS');
  } catch {
    errors.push('Database URL is malformed');
  }
}

if (!has('SUPABASE_URL') || !has('SUPABASE_ANON_KEY')) {
  warnings.push('Supabase Auth API credentials are not configured; verify that standalone authentication is intentionally enabled.');
}
if (isProduction) {
  for (const name of ['SUPABASE_URL','SUPABASE_ANON_KEY','KESTREL_ENCRYPTION_KEY','SMTP_HOST','SMTP_USER','SMTP_PASS','SMTP_FROM_EMAIL']) {
    if (!has(name)) errors.push(`${name} is required in production`);
  }
  if ((process.env.KESTREL_ENCRYPTION_KEY || '').length < 32) errors.push('KESTREL_ENCRYPTION_KEY must contain at least 32 characters');
  if (!has('CRON_SECRET') || (process.env.CRON_SECRET || '').length < 32) errors.push('CRON_SECRET must contain at least 32 characters in production');
  if (Number(process.env.SMTP_PORT || 465) !== 465) errors.push('SMTP_PORT must be 465 (implicit TLS) for Kestrel email delivery');
  if (process.env.DB_SSL === 'disable') errors.push('DB_SSL=disable is forbidden in production');
  if (process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false') errors.push('DB_SSL_REJECT_UNAUTHORIZED=false is forbidden in production');
  if (has('KESTREL_WORKER_TOKEN')) errors.push('Do not configure a shared KESTREL_WORKER_TOKEN on the control plane; provision individual worker credentials through the admin API');
}
if (has('KESTREL_WORKER_EXECUTOR') && isProduction && process.env.KESTREL_WORKER_EXECUTOR !== 'docker') {
  errors.push('Production worker executor must be docker');
}

if (warnings.length) {
  console.log('Configuration warnings:');
  for (const warning of warnings) console.log(` - ${warning}`);
}
if (errors.length) {
  console.error('Preflight failed:');
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}
console.log('Kestrel environment preflight passed.');
