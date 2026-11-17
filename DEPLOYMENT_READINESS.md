# Deployment readiness

This repository is not considered production-ready until the checks below are completed against the deployed environment.

## Public website and indexing

- The Vercel project domain is currently configured as `https://kestrel-kappa-sepia.vercel.app`.
- `/robots.txt` and `/sitemap.xml` are published as static files.
- The HTML document contains a canonical URL and Open Graph/Twitter metadata.
- Verify the domain in Google Search Console, then submit `https://kestrel-kappa-sepia.vercel.app/sitemap.xml`.
- Google Search Console verification is an account-owner action. Do not publish a guessed verification token.

## Control plane secrets

Set the following in Vercel Production, Preview and Development environments where applicable:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_DB_URL` — server-side only, using the Supabase transaction pooler.
- `KESTREL_ENCRYPTION_KEY` — a newly generated, stable, high-entropy secret. Back it up securely. Changing it makes existing encrypted project secrets unreadable.
- `CRON_SECRET` — a separate high-entropy secret used for authenticated recovery calls.
- `DB_POOL_MAX=1`
- `DB_SSL_REJECT_UNAUTHORIZED=true`

The database password previously shared in chat must be rotated before any production deployment. Never commit it or paste it into chat.

## Database

Run `npm run migrate` once from a trusted environment with the production database URL. Confirm that all three migrations are recorded in `kestrel_schema_migrations`.

## Worker infrastructure

Vercel serverless functions do not host persistent Docker workers. Provision a dedicated Linux host with Docker Engine and an isolated worker account. Configure a unique worker ID and one-time token from the Kestrel admin interface. Use a digest-pinned runtime image and a controlled egress proxy for dependency downloads.

## Recovery scheduling

Vercel Hobby only permits daily cron execution. The configured daily recovery invocation is a failsafe, not a substitute for timely lease recovery. Run the standalone control plane with its recovery loop or use an external scheduler capable of calling `GET /api/cron/recovery` every minute. Do not advertise the system as highly available until this is in place.

## Release gate

A release is blocked until GitHub Actions passes tests, type-checking and build; migrations succeed; signup/login and tenant isolation are verified; a real GitHub webhook produces a run; a Docker worker claims and completes it; logs and artifacts are downloadable; and recovery is tested by terminating a worker during a job.
