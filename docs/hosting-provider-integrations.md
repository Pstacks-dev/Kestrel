# Hosting provider integration roadmap

Kestrel's provider catalog is metadata only. It does **not** reserve names, create provider resources, deploy applications, or imply that a provider account is connected.

## Provider targets

Render, Railway, Fly.io, Google Cloud Run, AWS App Runner, Azure Container Apps, DigitalOcean App Platform, Heroku, Vercel, and Netlify.

The catalog identifies broad app types. Real provider adapters must validate current provider APIs and account/region capability before creating a deployment. Pricing and free-tier availability are not guaranteed.

## Target architecture

- `catalog.mjs`: provider identity, supported app-type hints, and provider domains.
- `adapters/<provider>.mjs`: provider API operations (future).
- `connections`: OAuth or API-key credentials, encrypted at rest, scoped per workspace.
- `deployments`: immutable deployment records, provider deployment ID, status, generated hostname, logs and timestamps.
- Orchestrator: build artifact/image, validate provider compatibility, provision, wait for health, report URL and offer redeploy/rollback where supported.

## Domain/subdomain handling

Kestrel should request a project slug from the user, then submit it to the provider's supported API. The provider may reject it as taken, reserved, invalid, or unsupported. Kestrel must show the actual returned hostname and never fabricate availability or claim a URL is live before deployment verification.

Provider URLs remain on provider domains (e.g. `project.onrender.com`, `project.vercel.app`); Kestrel is the control panel. This catalog does not add Kestrel-owned domains or proxy/redirect traffic.

## Security requirements before adapters ship

- Credentials are never returned to the client after save.
- Encrypt tokens using the existing server secret encryption facility and rotate/revoke support.
- Verify workspace membership and role for every provider connection/deployment action.
- Redact credentials from logs; validate provider callback state and webhook signatures.
- Use idempotency keys and provider resource cleanup on failed/abandoned deploys.
- Treat provider quota, billing, region, and plan requirements as provider-specific; don't promise free hosting.
- Provider-specific smoke tests must run against sandbox accounts before marking an adapter enabled.
