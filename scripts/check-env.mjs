import 'dotenv/config';

const isProduction = process.env.NODE_ENV === 'production';
const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_DB_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];
const errors = [];
const warnings = [];

// Node version check (v20+ recommended)
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 20) {
  errors.push(`Node.js version >= 20 is required (currently ${process.version})`);
}

for (const key of required) {
  const v = process.env[key] || '';
  if (!v || /YOUR_PROJECT|\[PASSWORD\]|replace-with|your-supabase/i.test(v)) {
    errors.push(`${key} is missing or contains placeholder values`);
  }
}

// Validate URLs
for (const urlKey of ['SUPABASE_URL', 'VITE_SUPABASE_URL']) {
  const v = process.env[urlKey];
  if (v) {
    try {
      new URL(v);
    } catch {
      errors.push(`${urlKey} must be a valid HTTP(S) URL`);
    }
  }
}

// Security checks for worker tokens and encryption keys
if (isProduction) {
  if (process.env.KESTREL_WORKER_TOKEN && process.env.KESTREL_WORKER_TOKEN.length < 32) {
    errors.push('KESTREL_WORKER_TOKEN must be at least 32 characters in production');
  }
  if (!process.env.KESTREL_ENCRYPTION_KEY) {
    warnings.push('KESTREL_ENCRYPTION_KEY is unset; deriving from SUPABASE_ANON_KEY');
  }
  if (process.env.DB_SSL === 'disable') {
    errors.push('DB_SSL cannot be disabled in production');
  }
}

if (warnings.length) {
  console.warn('⚠️  Preflight warnings:');
  for (const w of warnings) {
    console.warn(`   - ${w}`);
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
