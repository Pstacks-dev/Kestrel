-- Kestrel-managed email verification codes.
-- Supabase Auth owns auth.users; Kestrel never alters that schema directly.
-- Pending signup records contain only the Auth user ID and a keyed OTP digest.
create table if not exists public.kestrel_pending_signups (
  email text primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
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
