import pg from 'pg';
const { Pool } = pg;
const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('SUPABASE_DB_URL is required. Use the Supabase Postgres connection string (server-side only).');
export const pool = new Pool({ connectionString, max: Number(process.env.DB_POOL_MAX || (process.env.VERCEL ? 1 : 5)), idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000, keepAlive: true, ssl: process.env.DB_SSL === 'disable' ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } });
pool.on('error', err => console.error('Unexpected PostgreSQL pool error', err));
export async function query(text, params) { return pool.query(text, params); }
export async function transaction(fn) { const c=await pool.connect(); try { await c.query('begin'); const result=await fn(c); await c.query('commit'); return result; } catch(e) { await c.query('rollback'); throw e; } finally { c.release(); } }
