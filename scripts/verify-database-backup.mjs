import { verifyEncryptedDatabaseBackup } from '../server/lib/database-backup.mjs';

try {
  const objectKey = process.env.KESTREL_BACKUP_OBJECT_KEY || process.argv[2];
  const result = await verifyEncryptedDatabaseBackup({ objectKey });
  console.log(JSON.stringify(result));
  if (!process.env.KESTREL_RESTORE_DATABASE_URL) {
    console.warn('[database-backup] Archive integrity was verified; no staging restore was run because KESTREL_RESTORE_DATABASE_URL is not configured.');
  }
} catch (error) {
  console.error('[database-backup] Verification failed:', error.message);
  process.exitCode = 1;
}
