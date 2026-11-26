import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const BACKUP_MAGIC = Buffer.from('KSTRBK01');
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function parseBackupEncryptionKey(value) {
  const raw = String(value || '').trim();
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('KESTREL_BACKUP_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hex characters or base64');
  }
  return key;
}

export function parsePostgresConnection(value, label = 'database') {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`A valid ${label} PostgreSQL URL is required`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1)) {
    throw new Error(`The ${label} URL must be a PostgreSQL URL with host, username and database name`);
  }
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    sslmode: url.searchParams.get('sslmode') || 'require',
  };
}

export function assertDistinctRestoreDatabase(sourceUrl, restoreUrl) {
  const source = parsePostgresConnection(sourceUrl, 'source database');
  const restore = parsePostgresConnection(restoreUrl, 'restore database');
  if (source.host === restore.host && source.port === restore.port && source.database === restore.database) {
    throw new Error('Restore target must be a different database from the production source');
  }
  return restore;
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function encryptBackupStream(input, outputPath, key, iv = crypto.randomBytes(IV_BYTES)) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Backup encryption requires a 32-byte key');
  if (!Buffer.isBuffer(iv) || iv.length !== IV_BYTES) throw new Error('Backup encryption requires a 12-byte IV');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  try {
    output.write(BACKUP_MAGIC);
    output.write(iv);
    await pipeline(input, cipher, output);
    await appendFile(outputPath, cipher.getAuthTag());
    return { iv, authTag: cipher.getAuthTag() };
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function decryptBackupFile(inputPath, outputPath, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Backup decryption requires a 32-byte key');
  const info = await stat(inputPath);
  const minimum = BACKUP_MAGIC.length + IV_BYTES + TAG_BYTES;
  if (info.size <= minimum) throw new Error('Encrypted backup is truncated');
  const handle = await open(inputPath, 'r');
  let header;
  let tag;
  try {
    header = Buffer.alloc(BACKUP_MAGIC.length + IV_BYTES);
    tag = Buffer.alloc(TAG_BYTES);
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error('Encrypted backup format is not recognized');
  }
  const iv = header.subarray(BACKUP_MAGIC.length);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(inputPath, { start: header.length, end: info.size - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }),
    );
    return { sizeBytes: (await stat(outputPath)).size };
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => {});
    throw new Error(`Backup authentication or decryption failed: ${error.message}`);
  }
}

function postgresEnv(connection) {
  return {
    ...process.env,
    PGPASSWORD: connection.password,
    PGSSLMODE: connection.sslmode,
    PGCONNECT_TIMEOUT: '15',
  };
}

function postgresArgs(connection) {
  return [
    '--host', connection.host,
    '--port', String(connection.port),
    '--username', connection.username,
    '--dbname', connection.database,
  ];
}

async function runPgDump(databaseUrl, encryptedPath, key, pgDumpBin = 'pg_dump') {
  const connection = parsePostgresConnection(databaseUrl, 'source database');
  const args = [
    '--format=custom', '--no-owner', '--no-acl', '--compress=6',
    ...postgresArgs(connection),
  ];
  const child = spawn(pgDumpBin, args, { shell: false, env: postgresEnv(connection), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-12000); });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  try {
    const encrypted = await encryptBackupStream(child.stdout, encryptedPath, key);
    const code = await exit;
    if (code !== 0) throw new Error(`pg_dump exited with code ${code}: ${stderr}`);
    return encrypted;
  } catch (error) {
    child.kill('SIGTERM');
    await exit.catch(() => {});
    throw error;
  }
}

function storageObjectUrl(storageUrl, bucket, objectKey) {
  const base = String(storageUrl || '').replace(/\/$/, '');
  if (!/^https:\/\//i.test(base)) throw new Error('KESTREL_BACKUP_STORAGE_URL must be an HTTPS Supabase project URL');
  const encodedPath = String(objectKey).split('/').map(encodeURIComponent).join('/');
  return `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
}

function storageHeaders(serviceKey, extra = {}) {
  if (!serviceKey) throw new Error('KESTREL_BACKUP_STORAGE_SERVICE_ROLE_KEY is required');
  return {
    authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    ...extra,
  };
}

async function uploadEncryptedBackup({ storageUrl, serviceKey, bucket, objectKey, filePath, fetchImpl = fetch }) {
  const response = await fetchImpl(storageObjectUrl(storageUrl, bucket, objectKey), {
    method: 'POST',
    headers: storageHeaders(serviceKey, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-upsert': 'false',
    }),
    body: createReadStream(filePath),
    duplex: 'half',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`Backup upload failed: ${response.status} ${(await response.text()).slice(0, 1000)}`);
}

export async function downloadEncryptedBackup({ storageUrl, serviceKey, bucket, objectKey, filePath, fetchImpl = fetch }) {
  const response = await fetchImpl(storageObjectUrl(storageUrl, bucket, objectKey), {
    method: 'GET',
    headers: storageHeaders(serviceKey),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok || !response.body) throw new Error(`Backup download failed: ${response.status} ${(await response.text()).slice(0, 1000)}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
  return { sizeBytes: (await stat(filePath)).size, sha256: await sha256File(filePath) };
}

export async function pruneExpiredDatabaseBackups({
  storageUrl,
  serviceKey,
  bucket,
  retentionDays = 90,
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  const days = Number(retentionDays);
  if (!Number.isInteger(days) || days < 7 || days > 3650) {
    throw new Error('KESTREL_BACKUP_RETENTION_DAYS must be an integer between 7 and 3650');
  }
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const base = String(storageUrl || '').replace(/\/$/, '');
  if (!/^https:\/\//i.test(base)) throw new Error('KESTREL_BACKUP_STORAGE_URL must be an HTTPS Supabase project URL');
  const headers = storageHeaders(serviceKey, { 'content-type': 'application/json' });
  let offset = 0;
  const expired = [];
  while (true) {
    const response = await fetchImpl(`${base}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: 'POST', headers,
      body: JSON.stringify({ prefix: 'backups/', limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Backup retention listing failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
    const objects = await response.json();
    if (!Array.isArray(objects)) throw new Error('Backup retention listing returned an invalid response');
    expired.push(...objects
      .filter((item) => /^kestrel-[0-9TZ-]+\.kstr$/.test(String(item.name || '').split('/').pop()))
      .filter((item) => {
        const created = Date.parse(item.created_at || item.updated_at || '');
        return Number.isFinite(created) && created < cutoff;
      })
      .map((item) => String(item.name).startsWith('backups/') ? String(item.name) : `backups/${item.name}`));
    if (objects.length < 100) break;
    offset += objects.length;
  }
  let removed = 0;
  for (let index = 0; index < expired.length; index += 100) {
    const batch = expired.slice(index, index + 100);
    const deletion = await fetchImpl(`${base}/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: 'DELETE', headers,
      body: JSON.stringify({ prefixes: batch }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!deletion.ok) throw new Error(`Backup retention deletion failed: ${deletion.status} ${(await deletion.text()).slice(0, 500)}`);
    removed += batch.length;
  }
  return { removed, retentionDays: days };
}

export async function createEncryptedDatabaseBackup({
  databaseUrl = process.env.SUPABASE_DB_URL,
  storageUrl = process.env.KESTREL_BACKUP_STORAGE_URL,
  serviceKey = process.env.KESTREL_BACKUP_STORAGE_SERVICE_ROLE_KEY,
  bucket = process.env.KESTREL_BACKUP_BUCKET || 'kestrel-backups',
  encryptionKey = process.env.KESTREL_BACKUP_ENCRYPTION_KEY,
  pgDumpBin = process.env.PG_DUMP_BIN || 'pg_dump',
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  if (!databaseUrl) throw new Error('SUPABASE_DB_URL is required');
  if (!storageUrl || !serviceKey) throw new Error('Configure a separate backup Supabase project using KESTREL_BACKUP_STORAGE_URL and KESTREL_BACKUP_STORAGE_SERVICE_ROLE_KEY');
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(bucket)) throw new Error('KESTREL_BACKUP_BUCKET contains an invalid bucket name');
  const key = parseBackupEncryptionKey(encryptionKey);
  const objectKey = `backups/kestrel-${now.toISOString().replace(/[:.]/g, '-')}.kstr`;
  storageObjectUrl(storageUrl, bucket, objectKey);
  storageHeaders(serviceKey);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kestrel-db-backup-'));
  const encryptedPath = path.join(directory, 'database.kstr');
  try {
    await runPgDump(databaseUrl, encryptedPath, key, pgDumpBin);
    const sizeBytes = (await stat(encryptedPath)).size;
    const sha256 = await sha256File(encryptedPath);
    await uploadEncryptedBackup({ storageUrl, serviceKey, bucket, objectKey, filePath: encryptedPath, fetchImpl });
    const verificationPath = path.join(directory, 'uploaded.kstr');
    const downloaded = await downloadEncryptedBackup({ storageUrl, serviceKey, bucket, objectKey, filePath: verificationPath, fetchImpl });
    if (downloaded.sha256 !== sha256 || downloaded.sizeBytes !== sizeBytes) {
      throw new Error('Uploaded backup failed read-after-write checksum verification');
    }
    return { objectKey, bucket, sizeBytes, sha256, createdAt: now.toISOString() };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function verifyEncryptedDatabaseBackup({
  objectKey,
  expectedSha256 = process.env.KESTREL_BACKUP_EXPECTED_SHA256,
  storageUrl = process.env.KESTREL_BACKUP_STORAGE_URL,
  serviceKey = process.env.KESTREL_BACKUP_STORAGE_SERVICE_ROLE_KEY,
  bucket = process.env.KESTREL_BACKUP_BUCKET || 'kestrel-backups',
  encryptionKey = process.env.KESTREL_BACKUP_ENCRYPTION_KEY,
  sourceDatabaseUrl = process.env.SUPABASE_DB_URL,
  restoreDatabaseUrl = process.env.KESTREL_RESTORE_DATABASE_URL,
  restoreConfirmation = process.env.KESTREL_RESTORE_CONFIRM,
  retentionDays = Number(process.env.KESTREL_BACKUP_RETENTION_DAYS || 90),
  pgRestoreBin = process.env.PG_RESTORE_BIN || 'pg_restore',
  fetchImpl = fetch,
} = {}) {
  if (!objectKey || !/^backups\/[A-Za-z0-9._-]+\.kstr$/.test(objectKey)) {
    throw new Error('Provide a valid KESTREL_BACKUP_OBJECT_KEY under the backups/ prefix');
  }
  const key = parseBackupEncryptionKey(encryptionKey);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kestrel-db-restore-check-'));
  const encryptedPath = path.join(directory, 'download.kstr');
  const dumpPath = path.join(directory, 'database.dump');
  try {
    const downloaded = await downloadEncryptedBackup({ storageUrl, serviceKey, bucket, objectKey, filePath: encryptedPath, fetchImpl });
    if (expectedSha256 && downloaded.sha256 !== expectedSha256) throw new Error('Downloaded backup SHA-256 does not match the backup job output');
    const decrypted = await decryptBackupFile(encryptedPath, dumpPath, key);
    const list = await runPgRestoreList(pgRestoreBin, dumpPath);
    if (!list.entries) throw new Error('pg_restore returned no entries for the downloaded backup archive');
    let restoreVerification = null;
    if (restoreDatabaseUrl) {
      if (restoreConfirmation !== 'RESTORE_TO_STAGING_DATABASE') {
        throw new Error('Set KESTREL_RESTORE_CONFIRM=RESTORE_TO_STAGING_DATABASE to run the destructive staging restore drill');
      }
      const connection = assertDistinctRestoreDatabase(sourceDatabaseUrl, restoreDatabaseUrl);
      await runPgRestore(pgRestoreBin, dumpPath, connection);
      restoreVerification = await verifyRestoredSchema(restoreDatabaseUrl);
    }
    const retention = await pruneExpiredDatabaseBackups({ storageUrl, serviceKey, bucket, retentionDays, fetchImpl });
    return { objectKey, sha256: downloaded.sha256, encryptedSizeBytes: downloaded.sizeBytes, dumpSizeBytes: decrypted.sizeBytes, archiveEntries: list.entries, restoreVerification, retention };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function runPgRestoreList(pgRestoreBin, dumpPath) {
  return runUtility(pgRestoreBin, ['--list', dumpPath], {});
}

async function runPgRestore(pgRestoreBin, dumpPath, connection) {
  return runUtility(pgRestoreBin, [
    '--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error',
    ...postgresArgs(connection), dumpPath,
  ], postgresEnv(connection));
}

async function runUtility(command, args, env) {
  const child = spawn(command, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-12000); });
  const stdout = [];
  child.stdout.on('data', (chunk) => { if (stdout.length < 20) stdout.push(chunk.toString().slice(0, 1000)); });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`${command} failed with code ${code}: ${stderr}`);
  return { entries: stdout.join('').split(/\r?\n/).filter(Boolean).length };
}

async function verifyRestoredSchema(connectionString) {
  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const tables = new Set(result.rows.map((row) => row.table_name));
    const required = ['projects', 'organizations', 'jobs', 'managed_hosting_deployments'];
    const missing = required.filter((table) => !tables.has(table));
    if (missing.length) throw new Error(`Restored database is missing required tables: ${missing.join(', ')}`);
    const integrity = await client.query('select count(*)::bigint as project_count from public.projects');
    return { tableCount: tables.size, projectCount: Number(integrity.rows[0].project_count) };
  } finally {
    await client.end();
  }
}
