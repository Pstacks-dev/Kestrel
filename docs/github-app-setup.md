# GitHub App setup for Kestrel

Kestrel uses a GitHub App rather than customer personal access tokens. Create an app with **Contents: Read-only** and **Metadata: Read-only** repository permissions. Subscribe to `push`, `pull_request`, and `installation` events. Set the App webhook URL to `https://YOUR_KESTREL_HOST/api/webhooks/github` and configure the same webhook secret as server-only `GITHUB_APP_WEBHOOK_SECRET`.

Configure these server-only environment variables:

- `GITHUB_APP_ID`: numeric App ID.
- `GITHUB_APP_SLUG`: URL slug used to construct the installation URL.
- `GITHUB_APP_PRIVATE_KEY`: PEM private key. Store it in the deployment secret manager; a single-line PEM with escaped `\\n` is accepted.
- `GITHUB_APP_WEBHOOK_SECRET`: HMAC secret configured in the GitHub App webhook settings.
- `GITHUB_APP_STATE_SECRET`: a separate random secret of at least 32 characters used to sign the ten-minute installation callback state.

Set the app's user authorization callback to `https://YOUR_KESTREL_HOST/api/git/app/callback` once the callback route is deployed. Never put the private key in a `VITE_` variable, browser storage, worker image, or customer project environment.

In Kestrel, a workspace owner/admin/developer starts the installation from the workspace integration screen using `POST /api/git/app/install`. GitHub returns to `GET /api/git/app/callback`; Kestrel verifies signed, expiring state and rechecks workspace membership before linking the installation. The linked accounts are listed at `GET /api/workspaces/:orgId/github/installations`.

Private repository import uses `POST /api/git/import` with the normal repository URL plus the linked `installationId`. The installation must have access to that repository. Kestrel mints a short-lived installation token scoped to that single repository. For managed OCI builds, the control plane sends the token only in the authenticated worker claim response; the worker supplies it to Git through an ephemeral process environment Git configuration header, never a URL or command-line argument. It is redacted from worker logs and discarded after checkout. Do not log or persist installation tokens.

Apply migration `028_github_app_installations.sql` before enabling workspace installation linking. Set the GitHub App setup URL to `https://YOUR_KESTREL_HOST/api/git/app/callback`. Apply migration 028 before linking an installation. Private managed OCI image builds are supported by the worker token handoff; standard worker jobs and managed OCI workers both use ephemeral repository-scoped credentials. GitHub App push/pull-request deliveries are verified against the App webhook secret and installation ID; installation suspend/delete events disable linked installations. Apply migration 028 and configure the App webhook before enabling automation.
