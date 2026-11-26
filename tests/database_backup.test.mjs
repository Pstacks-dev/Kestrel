import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  assertDistinctRestoreDatabase,
  decryptBackupFile,
  encryptBackupStream,
  parseBackupEncryptionKey,
  parsePostgresConnection,
  pruneExpiredDatabaseBackups,
} from '../server/lib/database-backup.mjs';

test('parses 32-byte backup encryption keys from hex and base64', () => {
  const key = crypto.randomBytes(32);
  assert.deepEqual(parseBackupEncryptionKey(key.toString('hex')), key);
  assert.deepEqual(parseBackupEncryptionKey(key.toString('base64')), key);
  assert.throws(() => parseBackupEncryptionKey('short'), /32-byte key/);
});

test('encrypts and authenticates a database archive with AES-256-GCM', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kestrel-backup-test-'));
  const source = path.join(directory, 'source.dump');
  const encrypted = path.join(directory, 'backup.kstr');
  const restored = path.join(directory, 'restored.dump');
  const key = crypto.randomBytes(32);
  const bytes = crypto.randomBytes(256 * 1024);
  try {
    await writeFile(source, bytes);
    await encryptBackupStream(createReadStream(source), encrypted, key);
    const result = await decryptBackupFile(encrypted, restored, key);
    assert.equal(result.sizeBytes, bytes.length);
    assert.deepEqual(await readFile(restored), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects tampered ciphertext and incorrect backup encryption keys', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kestrel-backup-tamper-'));
  const source = path.join(directory, 'source.dump');
  const encrypted = path.join(directory, 'backup.kstr');
  const tampered = path.join(directory, 'tampered.kstr');
  const restored = path.join(directory, 'restored.dump');
  const restoredTampered = path.join(directory, 'restored-tampered.dump');
  const key = crypto.randomBytes(32);
  try {
    await writeFile(source, 'important database contents');
    await encryptBackupStream(createReadStream(source), encrypted, key);
    await assert.rejects(decryptBackupFile(encrypted, restored, crypto.randomBytes(32)), /authentication or decryption failed/);
    const bytes = await readFile(encrypted);
    bytes[bytes.length - 17] ^= 0x01;
    await writeFile(tampered, bytes);
    await assert.rejects(decryptBackupFile(tampered, restoredTampered, key), /authentication or decryption failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parses Supabase PostgreSQL connection URLs without exposing credentials', () => {
  const connection = parsePostgresConnection('postgresql://backup-user:secret%40value@db.example.test:6543/kestrel?sslmode=verify-full');
  assert.deepEqual(connection, {
    host: 'db.example.test', port: 6543, username: 'backup-user',
    password: 'secret@value', database: 'kestrel', sslmode: 'verify-full',
  });
  assert.throws(() => parsePostgresConnection('https://example.test'), /PostgreSQL URL/);
});

test('refuses to restore a production backup over the source database', () => {
  const source = 'postgresql://postgres:secret@db.example.test:5432/postgres?sslmode=require';
  assert.throws(() => assertDistinctRestoreDatabase(source, source), /different database/);
  assert.doesNotThrow(() => assertDistinctRestoreDatabase(
    source, 'postgresql://postgres:secret@staging.example.test:5432/kestrel_restore?sslmode=require',
  ));
});


test('retains recent encrypted backups and prunes only expired Kestrel archives', async () => {
  const calls = [];
  const now = new Date('2026-11-26T00:00:00.000Z');
  const result = await pruneExpiredDatabaseBackups({
    storageUrl: 'https://backup-project.supabase.co',
    serviceKey: 'service-role',
    bucket: 'kestrel-backups',
    retentionDays: 30,
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'POST') {
        return new Response(JSON.stringify([
          { name: 'kestrel-old.kstr', created_at: '2026-10-01T00:00:00.000Z' },
          { name: 'kestrel-new.kstr', created_at: '2026-11-20T00:00:00.000Z' },
          { name: 'manual-export.dump', created_at: '2026-09-01T00:00:00.000Z' },
        ]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    },
  });
  assert.deepEqual(result, { removed: 1, retentionDays: 30 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1].options.body), { prefixes: ['backups/kestrel-old.kstr'] });
});

test('rejects unsafe backup retention windows', async () => {
  await assert.rejects(pruneExpiredDatabaseBackups({
    storageUrl: 'https://backup-project.supabase.co', serviceKey: 'service-role',
    bucket: 'kestrel-backups', retentionDays: 1,
  }), /between 7 and 3650/);
});
