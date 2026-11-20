# Hosting Provider Integrations

Kestrel includes credential verification and deployment API adapters for ten targets: Render, Railway, Fly.io, Google Cloud Run, AWS App Runner, Azure Container Apps, DigitalOcean App Platform, Heroku, Vercel and Netlify.

## Credential formats
Most providers accept an API token string. Cloud Run and Azure use a JSON credential object with an OAuth access token and resource identifiers. AWS App Runner uses an AWS access key/secret pair, region and App Runner ECR access role ARN. Railway/Fly/Render/DO deployment calls need account/project/workspace fields.

Credentials are encrypted at rest and never returned to clients. Use least-privileged provider tokens and revoke them if exposed.

## Deployment flow
The deployment API requires a succeeded Kestrel pipeline run and a pinned commit SHA. Container image deployments require a SHA-256 digest. The API uses the validated repository/commit and stores provider resource ID, provider URL and deployment status. A provider-accepted request is not reported as live without a verified health/status check.

Some providers need prerequisites beyond a token: linked Git source/project, Cloud Run project and region, App Runner ECR access role, Azure Container Apps environment, Railway project/environment, Fly organization, Render workspace, or Heroku source archive.

## Live testing
CI uses mocked provider API responses to validate request contracts. A real deployment requires workspace-owned provider accounts, valid credentials, required resources and a validated Kestrel pipeline. No provider credentials are used in automated CI.
