# Kestrel: connect Supabase and deploy to Vercel

This repository uses Kestrel-managed email OTP and JWT sessions for account registration and sign-in, with Supabase PostgreSQL for durable application state. Supabase Auth email delivery is not used for new Kestrel signups. The database connection string is server-only.

## 1. Supabase project values

In Supabase Dashboard, open the project and copy:

- Project URL: Project Settings → API (or Project URL in the API settings page)
- Publishable key: Project Settings → API Keys → Publishable key. The legacy `anon` key also works with this code.
- PostgreSQL connection string: Dashboard → Connect → Transaction pooler. Use the URI connection string, normally port `6543`.

For the database URI, replace the password placeholder with the database password you created for this project. URL-encode special characters in the password. Do not paste this URI into the browser, a Git repository, a screenshot, or a VITE-prefixed variable.

## 2. Configure local development

From the repository root:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Set these values in `.env`:

```dotenv
NODE_ENV=development
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_LEGACY_SERVICE_ROLE_KEY
SUPABASE_DB_URL=postgresql://postgres.YOUR_PROJECT_REF:URL_ENCODED_PASSWORD@YOUR_POOLER_HOST:6543/postgres
DB_POOL_MAX=5
DB_SSL_REJECT_UNAUTHORIZED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your-sender@gmail.com
SMTP_PASS=your-google-app-password
SMTP_FROM_EMAIL=your-sender@gmail.com
SMTP_FROM_NAME=Kestrel
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY
VITE_API_BASE_URL=/api
```

`SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the SMTP credentials are server-only. Never prefix them with `VITE_` or expose them to the browser.

Install and apply the schema:

```bash
npm install
npm run preflight
npm run migrate
npm test
npm run check
```

The migration creates Kestrel's tables and row-level security policies. It is safe to rerun; already-recorded migrations are skipped. Review the SQL migration before applying it to a database containing existing application data.

Start the API and frontend in separate terminals:

```bash
npm run start:api
```

```bash
npm run dev
```

Open `http://localhost:3000`. Register through Kestrel's signup page. Kestrel creates a six-digit code, sends it through the configured SMTP account, and verifies it on the control plane. Apply migration `004_kestrel_email_otp.sql` before testing signup. Configure the SMTP variables in `.env` as described in `EMAIL_OTP_SETUP.md`.

## 3. Provision the first platform administrator

After registering and confirming your account, open Supabase Dashboard → Authentication → Users and copy your user's UUID. In SQL Editor, run this statement with your UUID:

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
  || '{"platform_role":"platform_admin"}'::jsonb
where id = 'YOUR_AUTH_USER_UUID';
```

Sign out and sign in again so the refreshed access token contains the updated app metadata. The admin route is not linked from public navigation, and its API checks `app_metadata.platform_role` on every request. Hiding `/admin` is not the security boundary.

## 4. Deploy the web app and API to Vercel

1. Push this repository to a Git provider you control.
2. In Vercel, choose Add New → Project and import the repository.
3. Keep the Vite framework preset. Build command: `npm run build`. Output directory: `dist`.
4. Add the environment variables below to the Production, Preview, and Development environments as appropriate.
5. Deploy. Redeploy after changing environment variables.

Required Vercel environment variables:

| Variable | Value | Exposure |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL | Public browser config |
| `VITE_SUPABASE_ANON_KEY` | Publishable key or legacy anon key | Public browser config; protect data with RLS |
| `SUPABASE_URL` | Same project URL | Server only |
| `SUPABASE_ANON_KEY` | Same publishable/anon key | Server only |
| `SUPABASE_DB_URL` | Transaction pooler URI, port 6543 | Server-only secret |
| `DB_POOL_MAX` | `1` | Server config |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | Server config |
| `NODE_ENV` | `production` | Server config |

Do not add `SUPABASE_DB_URL`, a database password, service-role key, GitHub private key, or webhook secret as a `VITE_` variable. Do not commit `.env`.

The Vercel function is an on-demand HTTP adapter. It does not start the worker agent or the background lease-recovery loop. The worker must run on a separate persistent Linux host with Docker installed. Deploying only to Vercel gives you the website/API, not a working distributed build fleet.

## 5. Supabase database connection mode

Use the shared Transaction pooler for Vercel serverless functions. Supabase's transaction pooler is intended for short-lived/serverless connections and does not support prepared statements. This project uses node-postgres without named prepared statements and caps the Vercel process pool at one connection. For a persistent worker/control-plane host, use the connection mode recommended by Supabase for that host and its network (direct connection where IPv6 is available, or session pooler where appropriate).

## 6. Verify the deployment

After deploying:

- Open `https://YOUR_VERCEL_DOMAIN/api/health`. Expect JSON with `ok: true` and `database: connected`.
- Register a test user and sign in.
- Confirm a workspace is created and appears in the workspace UI.
- Register a public HTTPS Git repository and confirm it appears in Projects.
- Do not trigger untrusted commands until the worker host, sandbox image, network policy and secret-handling controls have been reviewed.

If `/api/health` returns 503, inspect Vercel → Project → Logs. Check the transaction pooler host, username format, port, URL-encoded database password, SSL setting and Supabase project status.

## 7. Current execution boundary

Vercel hosts the landing page, browser application and short-lived HTTP API. It is not the build runtime. A separate persistent Linux worker host is required for polling, Docker execution, heartbeats and lease recovery. Do not expose the Docker socket to the public internet. Run build containers as non-root, with resource limits, no host mounts except a dedicated disposable workspace, and a deliberate network egress policy.

This setup guide does not claim the platform is production-certified. GitHub App installation/webhook processing, encrypted secret injection, artifact upload/download flows, deployment orchestration, stronger isolation for hostile multi-tenant code, and end-to-end security/load testing still require implementation and verification before public production use.

## 8. Kestrel email verification with six-digit OTP and Gmail SMTP

The signup screen uses Supabase Auth's email OTP flow:
- `signUp()` creates the account and requests email verification.
- `verifyOtp({ email, token, type: 'signup' })` verifies the six-digit code.
- `resend({ type: 'signup', email })` requests another code.

Supabase Auth remains the identity provider. Gmail is only the SMTP delivery service; it does not authenticate users or store passwords.

### Configure Gmail as the SMTP sender

Use a Google App Password generated specifically for Kestrel. If an App Password has ever been pasted into a chat, ticket, source file, or screenshot, revoke it in Google Account → Security → App passwords and generate a replacement. Enter the replacement only in Supabase's password field; never commit it or add it to a `VITE_` variable.

In Supabase Dashboard:
1. Open Authentication → SMTP Settings (sometimes shown under Project Settings → Authentication → SMTP).
2. Enable custom SMTP.
3. Set sender email to the Gmail account used for Kestrel and sender name to `Kestrel`.
4. Set host to `smtp.gmail.com`, port to `465` (SSL), username to the full Gmail address, and password to the newly generated App Password.
5. Save the settings and use Supabase's email test if available.

Gmail has sending limits and is suitable for an early test deployment, not a high-volume transactional email service. For larger production volumes, use a transactional provider with a verified Kestrel domain.

### Configure the signup email to contain a code

In Supabase Dashboard → Authentication → Email Templates → Confirm signup:
- Use the numeric OTP placeholder `{{ .Token }}` in the email body.
- Do not make the confirmation link the only way to complete signup.
- Save the template.

Example plain-text body:

```text
Welcome to Kestrel.

Your email verification code is: {{ .Token }}

Enter this six-digit code on the Kestrel signup page to activate your account.
If you did not create a Kestrel account, you can ignore this email.
```

Keep the confirmation template associated with the Confirm signup event. The Kestrel client verifies the code as a signup OTP; do not change the client to magic-link verification.

### Test the complete flow

1. Deploy the latest Kestrel branch containing the OTP signup UI.
2. Use a new email address that has never registered in this Supabase project.
3. Sign up with a password of at least eight characters.
4. Confirm the email arrives from the configured Kestrel sender and contains a six-digit code.
5. Enter the code in Kestrel. A successful verification should create an authenticated session and open the workspace.
6. Sign out and sign back in using the same email and password.
7. Test resend and confirm that only the latest valid code is accepted according to Supabase's OTP rules.

If signup returns an error, check Supabase Auth logs and SMTP delivery logs. If the email contains a URL rather than a code, re-check the Confirm signup template. If verification succeeds but the app does not open the workspace, inspect the browser console and the `/api/health` endpoint; email verification and the Kestrel database connection are separate systems.
