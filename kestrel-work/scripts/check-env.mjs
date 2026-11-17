import 'dotenv/config';
const required=['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_DB_URL','VITE_SUPABASE_URL','VITE_SUPABASE_ANON_KEY'];
const bad=[];for(const key of required){const v=process.env[key]||'';if(!v||/YOUR_PROJECT|\[PASSWORD\]|replace-with|your-supabase/i.test(v))bad.push(key)}
if(process.env.NODE_ENV==='production'&&process.env.KESTREL_WORKER_TOKEN&&process.env.KESTREL_WORKER_TOKEN.length<32)bad.push('KESTREL_WORKER_TOKEN (minimum 32 characters)');
if(bad.length){console.error('Missing or placeholder environment values:',bad.join(', '));process.exit(1)}
console.log('Kestrel environment preflight passed. This checks configuration only; it does not certify deployment security.');
