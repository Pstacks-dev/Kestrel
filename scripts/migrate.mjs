import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../server/lib/db.mjs';
const c=await pool.connect();
try{await c.query('create table if not exists public.kestrel_schema_migrations(name text primary key, applied_at timestamptz not null default now())');await c.query('alter table public.kestrel_schema_migrations enable row level security');const dir=path.resolve('db/migrations');for(const f of (await fs.readdir(dir)).filter(x=>x.endsWith('.sql')).sort()){const seen=await c.query('select 1 from public.kestrel_schema_migrations where name=$1',[f]);if(seen.rowCount){console.log(`Skipping ${f} (already applied)`);continue;}console.log(`Applying ${f}`);await c.query('begin');try{await c.query(await fs.readFile(path.join(dir,f),'utf8'));await c.query('insert into public.kestrel_schema_migrations(name) values($1)',[f]);await c.query('commit')}catch(e){await c.query('rollback');throw e}}console.log('Migrations applied.')}finally{c.release();await pool.end()}
