# Database backup and recovery

Kestrel's production backup workflow creates a daily encrypted PostgreSQL custom
archive, stores it in a separate Supabase Storage project, downloads it again to
verify the uploaded bytes, and checks that PostgreSQL can read the archive.
When a staging restore URL is configured, the workflow also performs a real
restore and checks critical Kestrel tables.

## Required GitHub configuration

Create a **private** bucket named `kestrel-backups` (or set the
`KESTREL_BACKUP_BUCKET` repository variable) in a separate Supabase project.
Do not store production database backups in the same Supabase project as the
production database.

Configure these GitHub Actions secrets:

| Secret | Purpose |
| --- | --- |
| `SUPABASE_DB_URL` | Production PostgreSQL connection string, server-side only |
| `KESTREL_BACKUP_STORAGE_URL` | URL of the separate backup Supabase project |
| `KESTREL_BACKUP_STORAGE_SERVICE_ROLE_KEY` | Service-role key for the backup project only |
| `KESTREL_BACKUP_ENCRYPTION_KEY` | Random 32-byte AES key, encoded as 64 hex characters or base64 |
| `KESTREL_RESTORE_DATABASE_URL` | Optional isolated staging database used for restore drills |

Generate an encryption key with:

```sh
openssl rand -hex 32
```

Never commit the key, service-role key, or database URLs. Keep a secure offline
copy of each backup encryption key version; losing the key makes encrypted
backups unrecoverable. Do not rotate the key until the previous key is safely
escrowed and the restore procedure has been tested with it.

## Schedule and verification

The `.github/workflows/database-backup.yml` workflow runs daily at 02:30 UTC
and can also be started manually from GitHub Actions. It:

1. Runs `pg_dump` in PostgreSQL custom format with ownership and ACLs excluded.
2. Encrypts the stream with AES-256-GCM before it is written to disk.
3. Uploads the encrypted object to the separate private backup bucket.
4. Downloads the object and compares its SHA-256 digest and byte size with the
   uploaded file.
5. Decrypts the downloaded archive and runs `pg_restore --list` to validate
   archive structure and the GCM authentication tag.
6. If `KESTREL_RESTORE_DATABASE_URL` is configured, restores the archive into
   that separate staging database and checks for the `projects`,
   `organizations`, `jobs`, and `managed_hosting_deployments` tables.

The restore script refuses to restore to the same host, port and database as
`SUPABASE_DB_URL`. The workflow sets an explicit staging-only confirmation
before running the destructive `pg_restore --clean` operation.

## Manual backup and restore

Run a backup locally after configuring the required environment variables:

```sh
npm run backup:db
```

Verify a stored backup by object key:

```sh
KESTREL_BACKUP_OBJECT_KEY=backups/kestrel-<timestamp>.kstr npm run backup:verify
```

To run a restore drill, configure `KESTREL_RESTORE_DATABASE_URL` to an isolated
staging database and set:

```sh
KESTREL_RESTORE_CONFIRM=RESTORE_TO_STAGING_DATABASE npm run backup:verify
```

The restore command replaces objects in the target database. Never point it at
production. After a restore, verify application login, project access, worker
registration, pipeline history, deployment history and storage references in
the staging environment.

## Retention and disaster recovery

Keep the backup bucket private and in a separate project/account from the
production database. Configure a bucket retention/lifecycle policy that keeps
at least 30 daily backups and several month-end copies. Keep Supabase's own
point-in-time recovery (PITR) enabled where the production plan supports it;
encrypted offsite dumps complement PITR and are not a replacement for it.

A backup is considered operationally verified only when the daily upload,
read-after-write checksum, authenticated decryption, and archive-list check
succeed. A full recovery drill additionally requires the staging restore step
to succeed. Monitor the GitHub Actions workflow and alert on any failed or
missed daily run.
