# GitHub-hosted ephemeral build runners

Kestrel can execute one queued build at a time on a short-lived GitHub-hosted Ubuntu runner. No dedicated Linux server, self-hosted runner, worker VM, or paid compute fallback is required.

## Required configuration

Configure the following values only after the control-plane deployment is ready:

### Vercel environment variables (Production)

- `KESTREL_EXECUTION_MODE=github-hosted`
- `KESTREL_EPHEMERAL_RUNNER_SECRET`: a randomly generated secret with at least 32 characters. Use the same value in the GitHub Actions repository secret below.

### GitHub repository settings

In `Pstacks-dev/Kestrel`:

- Actions variable `KESTREL_API_URL`: `https://kestrel-ci-cd.vercel.app`
- Actions secret `KESTREL_EPHEMERAL_RUNNER_SECRET`: the exact same random secret configured in Vercel.

The workflow is `.github/workflows/ephemeral-runners.yml`. It checks the queue every five minutes and can also be started manually from the Actions tab. It uses only GitHub-hosted `ubuntu-latest` standard runners, one runner at a time, and provisions a single-use worker credential only when a queued job has no healthy persistent worker.

## Security and cost controls

- The workflow has read-only repository permissions and does not persist checkout credentials.
- The bootstrap secret is sent only to the Kestrel control plane over HTTPS; it is not passed to customer build commands.
- Worker credentials are random, hashed in the database, expire after 55 minutes, and are revoked when the workflow retires the worker.
- The runner executes at most one pipeline job. The customer command runs inside the pinned, unprivileged Docker job image.
- Docker container egress is hardened before provisioning. The job container cannot access host-local, private, loopback, link-local, or metadata address ranges.
- Workflow concurrency is limited to one runner. No self-hosted, paid, or auto-billing fallback is configured.
- If GitHub Actions usage limits or free-tier availability prevent a run, the job remains queued for a later attempt. Kestrel must not silently switch to paid compute.

GitHub's hosted-runner availability and free-use rules are controlled by GitHub and can change. This design does not promise unlimited build minutes or immediate starts. Public repository standard runner usage is subject to GitHub's current policies.

## Database migration

Apply `db/migrations/041_ephemeral_github_runners.sql` using the existing `npm run migrate` command before enabling this execution mode. Keep the migration record in `public.kestrel_schema_migrations` as managed by the migration script.
