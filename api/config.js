// GET /api/config - public settings the browser needs to talk to Supabase Auth.
// Only the project URL and the PUBLISHABLE key are returned. As a safety net it
// refuses to respond at all if a secret key was pasted into the wrong variable.
import { route, HttpError } from '../lib/http.js';
import { getSupabaseUrl, getPublishableKey } from '../lib/supabase.js';

function looksLikeSecretKey(key) {
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      return payload.role === 'service_role';
    } catch {
      return false;
    }
  }
  return false;
}

export default route({
  GET() {
    const publishableKey = getPublishableKey();
    if (looksLikeSecretKey(publishableKey)) {
      console.error('SUPABASE_PUBLISHABLE_KEY holds a SECRET key - refusing to serve it');
      throw new HttpError(500, 'Server configuration error');
    }
    return {
      supabaseUrl: getSupabaseUrl(),
      supabasePublishableKey: publishableKey,
    };
  },
});