import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const isSupabaseConfigured = Boolean(
  url &&
  key &&
  !url.includes('YOUR_PROJECT') &&
  !key.includes('your-supabase')
);

export const supabase = isSupabaseConfigured
  ? createClient(url!, key!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

// Fail closed when Supabase is not configured. Never silently create local
// accounts or sessions that bypass email verification.
const configurationError = () =>
  new Error('Kestrel authentication is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then redeploy.');

const unavailableAuth = {
  async signUp() {
    return { data: { user: null, session: null }, error: configurationError() };
  },
  async signInWithPassword() {
    return { data: { user: null, session: null }, error: configurationError() };
  },
  async verifyOtp() {
    return { data: { user: null, session: null }, error: configurationError() };
  },
  async resend() {
    return { data: { user: null, session: null }, error: configurationError() };
  },
  async getSession() {
    return { data: { session: null }, error: null };
  },
  async signOut() {
    return { error: null };
  },
};

export function requireSupabase() {
  return supabase || ({ auth: unavailableAuth } as any);
}
