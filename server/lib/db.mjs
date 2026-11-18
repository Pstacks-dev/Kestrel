import pg from 'pg';
const { Pool } = pg;

let poolInstance = null;

export function getPool() {
  if (poolInstance) return poolInstance;
  const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('SUPABASE_DB_URL is required. Use the Supabase Postgres connection string (server-side only).');
  }

  // Supply Supabase's CA PEM through SUPABASE_DB_SSL_CA to verify the server.
  // The fallback keeps TLS encryption enabled but skips certificate validation;
  // use it only while a pooler certificate chain cannot be verified.
  const sslCa = process.env.SUPABASE_DB_SSL_CA?.replace(/\\n/g, '\n');
  const ssl =
    process.env.DB_SSL === 'disable'
      ? false
      : {
          rejectUnauthorized: sslCa ? true : process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
          ...(sslCa ? { ca: sslCa } : {}),
        };

  poolInstance = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX || (process.env.VERCEL ? 1 : 5)),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    ssl,
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
