# Hosting Provider Integrations

Kestrel's provider catalog has API adapters for Render, Railway, Fly.io, Google Cloud Run, AWS App Runner, Azure Container Apps, DigitalOcean App Platform, Heroku, Vercel and Netlify.

## Credential fields
Most providers accept a provider API token as a string. Cloud Run and Azure use JSON configuration with an OAuth access token and project/resource identifiers. AWS App Runner needs AWS access keys, region, and an ECR access role ARN. Railway needs project and environment IDs; Fly.io needs an organization slug; Render needs an owner/workspace ID; DigitalOcean needs registry information; Vercel needs a project ID; Netlify can use a site ID.

Credentials are encrypted at rest and never returned to clients. Use least-privileged credentials. OAuth access tokens for Google Cloud and Azure are currently supplied by the user and are not refreshed by Kestrel.

## Deployment workflow
The deploy endpoint requires a successful Kestrel pipeline run with a commit SHA and workspace admin permission. It creates a provider deployment record, then submits the provider API call. Container image references must be SHA-256 digests. Railway/Vercel receive a pinned commit SHA; Heroku requires an HTTPS archive URL containing the validated commit SHA; Netlify direct deployment requires the built files and uploads them individually.

## Provider-specific limitations
- **Render:** container-image deployment only, with a workspace/owner ID.
- **Railway:** source repo/service creation, commit-pinned deployment, and generated public domain; project/environment IDs required.
- **Fly.io:** creates app, allocates shared IPv4/IPv6, and creates machine from immutable image; org slug required.
- **Cloud Run:** image-based; Google project and region required.
- **AWS App Runner:** ECR image; access role ARN and signed AWS credentials required.
- **Azure Container Apps:** image; existing Container Apps environment and subscription/resource group required.
- **DigitalOcean:** image must already exist in the configured registry, tagged using the validated commit SHA; repository/tag fields required.
- **Heroku:** source archive build; archive URL must include the run commit SHA. Container image release isn't implemented.
- **Vercel:** linked GitHub source and Vercel project; uses commit SHA.
- **Netlify:** requires files from a build artifact (not an empty site build). Kestrel UI currently does not yet select/extract artifact files automatically; direct API payload can provide files.

Provider-accepted deployments start in deploying status. Refresh calls query each provider's status API. A provider is marked live only when that API reports a ready/running state. Provider status polling, log streaming and rollback are not implemented yet.

## Test scope
CI includes mocked API contract tests for all ten credential verifications, deployment submissions and status refreshes. These do not prove a real provider deployment. Live testing requires user-connected accounts, valid credentials and the required provider-side projects/roles/images.
