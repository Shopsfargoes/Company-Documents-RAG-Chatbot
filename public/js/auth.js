// Browser-side authentication helpers (shared by every page).
// The Supabase browser library must be loaded first by a <script> tag; it
// defines the global `supabase`.

let clientPromise;

export function getSupabase() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load app configuration');
      const { supabaseUrl, supabasePublishableKey } = await res.json();
      return window.supabase.createClient(supabaseUrl, supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
    })().catch((err) => {
      clientPromise = undefined; // allow a retry on the next call
      throw err;
    });
  }
  return clientPromise;
}

export async function getSession() {
  const client = await getSupabase();
  const { data } = await client.auth.getSession();
  return data.session;
}

export async function signIn(email, password) {
  const client = await getSupabase();
  return client.auth.signInWithPassword({ email, password });
}

export async function signUp({ email, password, fullName }) {
  const client = await getSupabase();
  return client.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: `${window.location.origin}/login.html`,
    },
  });
}

export async function signOut() {
  const client = await getSupabase();
  return client.auth.signOut();
}

export async function sendPasswordReset(email) {
  const client = await getSupabase();
  return client.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password.html`,
  });
}

export async function updatePassword(newPassword) {
  const client = await getSupabase();
  return client.auth.updateUser({ password: newPassword });
}

export function redirectToLogin() {
  window.location.replace('/login.html');
}

// Returns the session, or sends the visitor to the login page and returns null.
// NOTE: this only controls what the page shows. Real protection is the
// server-side check in every /api route.
export async function requireSession() {
  const session = await getSession();
  if (!session) {
    redirectToLogin();
    return null;
  }
  return session;
}

// fetch() that attaches the signed-in user's access token.
export async function apiFetch(path, options = {}) {
  const session = await getSession();
  if (!session) {
    redirectToLogin();
    throw new Error('Not signed in');
  }
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${session.access_token}`);
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    await signOut().catch(() => {});
    redirectToLogin();
    throw new Error('Session expired');
  }
  return res;
}