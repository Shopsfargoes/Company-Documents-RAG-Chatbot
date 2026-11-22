// Supabase client factory. SERVER-SIDE ONLY - never import this from public/.
//
// Three clients, three trust levels:
//   getAnonClient()      publishable key, no user  -> same power as an
//                        unauthenticated browser (RLS applies)
//   getUserClient(jwt)   publishable key + the caller's access token -> acts
//                        AS that user (RLS applies). Use this for retrieval.
//   getAdminClient()     secret key -> service_role, BYPASSES RLS. Use only
//                        after your own explicit authorization check.
import { createClient } from '@supabase/supabase-js';

// Serverless functions have no session storage and no browser URL to parse.
const BASE_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
};

function readEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  throw new Error(`Missing environment variable: ${names[0]}`);
}

export function getSupabaseUrl() {
  return readEnv(['SUPABASE_URL']);
}

// Legacy names are accepted as fallbacks (Supabase is retiring anon/service_role).
export function getPublishableKey() {
  return readEnv(['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY']);
}

export function getSecretKey() {
  return readEnv(['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
}

export function getAnonClient() {
  return createClient(getSupabaseUrl(), getPublishableKey(), BASE_OPTIONS);
}

export function getUserClient(accessToken) {
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw new Error('getUserClient requires a non-empty access token');
  }
  return createClient(getSupabaseUrl(), getPublishableKey(), {
    ...BASE_OPTIONS,
    global: { headers: { Authorization: `Bearer ${accessToken.trim()}` } },
  });
}

let adminClient;
export function getAdminClient() {
  if (!adminClient) {
    adminClient = createClient(getSupabaseUrl(), getSecretKey(), BASE_OPTIONS);
  }
  return adminClient;
}
