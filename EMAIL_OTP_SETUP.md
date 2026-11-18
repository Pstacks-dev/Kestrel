# Kestrel email OTP setup

Kestrel now generates and verifies its own email verification codes. Supabase Auth's email OTP/template system is not used for new signups. Supabase PostgreSQL remains the database.

## SMTP configuration

Kestrel currently sends email through SMTP over implicit TLS on port 465. For Gmail:

- SMTP host: `smtp.gmail.com`
- SMTP port: `465`
- SMTP username: the complete Gmail sender address
- SMTP password: a Google App Password (not the normal Google account password)
- Sender email: the same Gmail address
- Sender name: `Kestrel`

Add these values to the server environment (local `.env` or Vercel Project → Settings → Environment Variables):

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your-sender@gmail.com
SMTP_PASS=your-google-app-password
SMTP_FROM_EMAIL=your-sender@gmail.com
SMTP_FROM_NAME=Kestrel
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
```

Keep `SMTP_PASS` server-side. Never add it to a `VITE_*` variable, commit it, or paste it into chat. Kestrel also needs the legacy Supabase `service_role` key as `SUPABASE_SERVICE_ROLE_KEY` so the backend can create accounts and mark them verified through Supabase's server-only Auth Admin API. Never expose this key in the browser or commit it. If an App Password was previously exposed, revoke it in Google Account → Security → App passwords and create a replacement.

## Database migration

After setting `SUPABASE_DB_URL` to the Supabase transaction-pooler connection string, run:

```bash
npm run migrate
```

This applies `004_kestrel_email_otp.sql`, which creates a private pending-signup table and preserves existing accounts. New users are created as unconfirmed Supabase Auth users; Kestrel only confirms them after a valid code is submitted.

## Signup behavior

1. The user submits their name, email and password.
2. Kestrel creates an unconfirmed account through Supabase's server-only Auth Admin API and stores an HMAC of a cryptographically generated six-digit code. It never stores the plaintext code or a second copy of the password.
3. Kestrel sends a branded verification email.
4. The code expires after five minutes. Five incorrect attempts invalidate the pending signup.
5. Resending is limited to once per 60 seconds and five resends per pending signup.
6. After successful verification, Kestrel marks the Supabase Auth account as email-confirmed. The user then signs in and receives a normal Supabase access/refresh-token session.

## API endpoints

- `POST /api/auth/signup`
- `POST /api/auth/verify-otp`
- `POST /api/auth/resend-otp`
- `POST /api/auth/login`

## Production deployment checklist

1. Configure all six SMTP variables in Vercel for Production and Preview.
2. Configure `SUPABASE_SERVICE_ROLE_KEY` using the legacy service_role secret from Supabase Project Settings → API Keys. Keep it server-side only.
3. Ensure `KESTREL_ENCRYPTION_KEY` is set to a stable secret of at least 32 characters; it also protects OTP hashes.
4. Ensure `SUPABASE_DB_URL` points to the correct Supabase PostgreSQL database.
5. Run `npm run migrate` once from a trusted environment connected to that database.
6. Redeploy the Vercel project after changing environment variables.
7. Test a new signup using an inbox you can access, then test an incorrect code, an expired code, resend cooldown, successful verification, and login.

A deployment cannot send OTP email until the SMTP variables are configured and the migration has been applied.
