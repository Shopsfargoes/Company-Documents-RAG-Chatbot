// Server-side authentication and authorization.
// The browser can claim anything; this file decides who a caller really is.
import { getAdminClient } from './supabase.js';
import { HttpError } from './http.js';

export function getBearerToken(request) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    throw new HttpError(401, 'Missing or malformed Authorization header');
  }
  const token = match[1].trim();
  if (token.length < 20 || token.length > 4096) {
    throw new HttpError(401, 'Invalid or expired session');
  }
  return token;
}

// Validates the caller's access token with Supabase Auth, then loads their
// profile (including role) from the database. The role is NEVER read from
// anything the browser sends.
export async function authenticate(request) {
  const accessToken = getBearerToken(request);
  const admin = getAdminClient();

  const { data, error } = await admin.auth.getUser(accessToken);
  if (error || !data?.user) {
    throw new HttpError(401, 'Invalid or expired session');
  }
  const user = data.user;
  if (!user.email_confirmed_at) {
    throw new HttpError(403, 'Email address not confirmed');
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id, email, full_name, role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) {
    console.error('Profile lookup failed:', profileError.message);
    throw new HttpError(500, 'Could not load profile');
  }
  if (!profile) {
    throw new HttpError(403, 'No profile exists for this account');
  }

  return { user, profile, accessToken };
}

export async function requireAdmin(request) {
  const context = await authenticate(request);
  if (context.profile.role !== 'admin') {
    throw new HttpError(403, 'Administrator access required');
  }
  return context;
}