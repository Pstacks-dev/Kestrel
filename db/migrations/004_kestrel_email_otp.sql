-- Kestrel-managed email verification codes.
-- Pending credentials are stored only until the email address is verified.
alter table auth.users
  add column if not exists email_confirmed_at timestamptz;

-- Preserve accounts created before Kestrel-managed OTP verification was introduced.
update auth.users
set email_confirmed_at = coalesce(email_confirmed_at, created_at, now())
where email_confirmed_at is null;

create table if not exists public.kestrel_pending_signups (
  email text primary key,
  password_hash text not null,
  full_name text not null,
  otp_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts between 0 and 5),
  resend_count integer not null default 0 check (resend_count between 0 and 5),
  last_sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_kestrel_pending_signups_expiry
  on public.kestrel_pending_signups(expires_at);

alter table public.kestrel_pending_signups enable row level security;
revoke all on public.kestrel_pending_signups from anon, authenticated;
