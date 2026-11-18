import pg from 'pg';
import { SUPABASE_ROOT_CA_BUNDLE } from './supabase-ca.mjs';
const { Pool } = pg;

let poolInstance = null;

export function getPool() {
  if (poolInstance) return poolInstance;
  const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('SUPABASE_DB_URL is required. Use the Supabase Postgres connection string (server-side only).');
  }

  poolInstance = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX || (process.env.VERCEL ? 1 : 5)),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    ssl:
      process.env.DB_SSL === 'disable'
        ? false
        : {
            ca: process.env.SUPABASE_DB_CA_CERT?.replace(/\\n/g, '\n') || SUPABASE_ROOT_CA_BUNDLE,
            rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
          },
  });

  poolInstance.on('error', (err) => console.error('Unexpected PostgreSQL pool error', err));
  return poolInstance;
}

// Proxied pool export so calls to pool.query or pool.connect initialize lazily
export const pool = new Proxy({}, {
  get(_target, prop) {
    const p = getPool();
    const val = p[prop];
    return typeof val === 'function' ? val.bind(p) : val;
  }
});

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function transaction(fn) {
  const c = await getPool().connect();
  try {
    await c.query('begin');
    const result = await fn(c);
    await c.query('commit');
    return result;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
