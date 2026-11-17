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

// Universal Auth Client for standalone operation without third-party services
const localAuthClient = {
  auth: {
    async signUp({ email, password, options }: any) {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          fullName: options?.data?.full_name,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { data: null, error: new Error(data.error || 'Sign up failed') };
      }
      if (data.session) {
        localStorage.setItem('kestrel_session', JSON.stringify(data.session));
        localStorage.setItem('kestrel_user', JSON.stringify(data.user));
      }
      return { data, error: null };
    },

    async signInWithPassword({ email, password }: any) {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { data: null, error: new Error(data.error || 'Login failed') };
      }
      if (data.session) {
        localStorage.setItem('kestrel_session', JSON.stringify(data.session));
        localStorage.setItem('kestrel_user', JSON.stringify(data.user));
      }
      return { data, error: null };
    },

    async getSession() {
      const stored = localStorage.getItem('kestrel_session');
      if (!stored) return { data: { session: null }, error: null };
      try {
        const session = JSON.parse(stored);
        return { data: { session }, error: null };
      } catch {
        return { data: { session: null }, error: null };
      }
    },

    async signOut() {
      localStorage.removeItem('kestrel_session');
      localStorage.removeItem('kestrel_user');
      return { error: null };
    },
  },
};

/**
 * Returns either the Supabase client or Kestrel's built-in standalone auth client.
 * Never throws due to missing external Supabase credentials.
 */
export function requireSupabase() {
  if (supabase) return supabase;
  return localAuthClient as any;
}
