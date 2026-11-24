# GitHub App setup for Kestrel

Kestrel uses a GitHub App rather than customer personal access tokens. Create an app with **Contents: Read-only** and **Metadata: Read-only** repository permissions. Subscribe to `push` and `installation` events when webhook automation is enabled.

Configure these server-only environment variables:

- `GITHUB_APP_ID`: numeric App ID.
- `GITHUB_APP_SLUG`: URL slug used to construct the installation URL.
- `GITHUB_APP_PRIVATE_KEY`: PEM private key. Store it in the deployment secret manager; a single-line PEM with escaped `\\n` is accepted.

Set the app's user authorization callback to `https://YOUR_KESTREL_HOST/api/git/app/callback` once the callback route is deployed. Never put the private key in a `VITE_` variable, browser storage, worker image, or customer project environment.

The installation-token client mints short-lived tokens using an App JWT. Tokens should be limited to the selected repository and `contents: read`, passed only to the worker handling that checkout, and discarded after use. Do not log or persist installation tokens.

Apply migration `028_github_app_installations.sql` before enabling workspace installation linking. The API callback and worker token handoff are separate integration steps; configuring these variables alone does not yet enable private imports.
