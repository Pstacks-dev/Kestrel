import { appendFile } from 'node:fs/promises';
import { createEncryptedDatabaseBackup } from '../server/lib/database-backup.mjs';

try {
  const result = await createEncryptedDatabaseBackup();
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `object_key=${result.objectKey}\nsha256=${result.sha256}\n`);
  }
} catch (error) {
  console.error('[database-backup] Backup failed:', error.message);
  process.exitCode = 1;
}
