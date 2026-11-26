import 'dotenv/config';

const isProduction = process.env.NODE_ENV === 'production';
const errors = [];
const warnings = [];

// Node version check (v20+ recommended)
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 20) {
  errors.push(`Node.js version >= 20 is required (currently ${process.version})`);
}

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!dbUrl || /\[PASSWORD\]/i.test(dbUrl)) {
  errors.push('SUPABASE_DB_URL or DATABASE_URL is missing or contains placeholder values');
}

// Check auth provider mode
const hasSupabase = Boolean(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_ANON_KEY &&
  !process.env.SUPABASE_URL.includes('YOUR_PROJECT')
);

if (!hasSupabase) {
  warnings.push('No external Supabase cloud configured; running in standalone self-hosted mode with built-in JWT authentication.');
}

// Security checks for worker tokens and encryption keys
if (isProduction) {
  if (process.env.KESTREL_WORKER_TOKEN && process.env.KESTREL_WORKER_TOKEN.length < 16) {
    errors.push('KESTREL_WORKER_TOKEN must be at least 16 characters in production');
  }
  if (typeof process.env.KESTREL_ENCRYPTION_KEY !== 'string' || process.env.KESTREL_ENCRYPTION_KEY.length < 32) {
    errors.push('KESTREL_ENCRYPTION_KEY must be configured with at least 32 characters in production');
  }
  if (typeof process.env.JWT_SECRET !== 'string' || process.env.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET must be configured with at least 32 characters in production');
  }
  if (process.env.DB_SSL === 'disable') {
    warnings.push('DB_SSL is disabled');
  }
}

if (warnings.length) {
  console.log('ℹ️  Configuration notes:');
  for (const w of warnings) {
    console.log(`   - ${w}`);
  }
}

if (errors.length) {
  console.error('❌ Preflight failed with configuration errors:');
  for (const e of errors) {
    console.error(`   - ${e}`);
  }
  process.exit(1);
}

console.log('✅ Kestrel environment preflight passed successfully.');
