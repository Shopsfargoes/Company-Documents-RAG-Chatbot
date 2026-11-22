// Milestone 1 connection + privilege test.
// Run:  npm run test:connection
// Prints PASS/FAIL per check and exits non-zero if anything failed.
// It never prints key values.
import {
  getAdminClient,
  getAnonClient,
  getUserClient,
  getSupabaseUrl,
  getPublishableKey,
  getSecretKey,
} from '../lib/supabase.js';

const outcomes = [];
function record(ok, name, detail = '') {
  outcomes.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -  ' + detail : ''}`);
}

function finish() {
  const failed = outcomes.filter((ok) => !ok).length;
  console.log('');
  if (failed === 0) {
    console.log(`All ${outcomes.length} checks passed.`);
  } else {
    console.log(`${failed} of ${outcomes.length} checks FAILED.`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

function keyKind(key) {
  if (key.startsWith('sb_publishable_')) return 'publishable';
  if (key.startsWith('sb_secret_')) return 'secret';
  if (key.split('.').length === 3) return 'legacy-jwt';
  return 'unknown';
}

// ---- 1. environment ---------------------------------------------------------
let url;
let publishableKey;
let secretKey;
try {
  url = getSupabaseUrl();
  publishableKey = getPublishableKey();
  secretKey = getSecretKey();
  record(true, 'Required Supabase environment variables are set');
} catch (err) {
  record(false, 'Required Supabase environment variables are set', err.message);
  finish();
}

try {
  const parsed = new URL(url);
  const okProtocol =
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname));
  record(
    okProtocol && parsed.pathname === '/',
    'SUPABASE_URL looks like a project URL',
    parsed.pathname === '/' ? '' : 'remove any path such as /rest/v1',
  );
} catch {
  record(false, 'SUPABASE_URL looks like a project URL', 'not a valid URL');
}

const pubKind = keyKind(publishableKey);
const secKind = keyKind(secretKey);
record(
  pubKind === 'publishable' || pubKind === 'legacy-jwt',
  'Publishable key slot holds a publishable/anon key',
  pubKind === 'secret' ? 'DANGER: a SECRET key is in SUPABASE_PUBLISHABLE_KEY' : `type: ${pubKind}`,
);
record(
  secKind === 'secret' || secKind === 'legacy-jwt',
  'Secret key slot holds a secret/service_role key',
  `type: ${secKind}`,
);

// ---- 2. backend (service role) can reach every table --------------------------
const admin = getAdminClient();
const tables = [
  'profiles',
  'documents',
  'document_permissions',
  'document_chunks',
  'conversations',
  'messages',
];
for (const table of tables) {
  const { error, count } = await admin
    .from(table)
    .select('id', { count: 'exact' })
    .limit(1);
  record(
    !error,
    `service role can read public.${table}`,
    error ? `${error.code ?? ''} ${error.message}`.trim() : `${count} row(s)`,
  );
}

// ---- 3. anonymous callers are locked out --------------------------------------
const anon = getAnonClient();
for (const table of ['profiles', 'documents', 'document_chunks', 'conversations', 'messages']) {
  const { data, error } = await anon.from(table).select('id').limit(1);
  const denied = error?.code === '42501';
  record(
    denied,
    `anon is denied on public.${table}`,
    denied ? '' : error ? `unexpected error ${error.code}: ${error.message}` : `anon got ${data.length} row(s) - grants too broad!`,
  );
}

const probeVector = Array(768).fill(0.1);
const rpcArgs = {
  query_embedding: probeVector,
  p_embedding_model: 'gemini-embedding-2',
  match_count: 5,
};

{
  const { error } = await anon.rpc('match_document_chunks', rpcArgs);
  record(
    error?.code === '42501',
    'anon cannot call match_document_chunks',
    error ? error.code : 'call succeeded - EXECUTE not revoked!',
  );
}

// ---- 4. retrieval fails closed without a user session -------------------------
{
  const { data, error } = await admin.rpc('match_document_chunks', rpcArgs);
  record(
    !error && Array.isArray(data) && data.length === 0,
    'service-role call to match_document_chunks returns nothing (fails closed)',
    error ? `${error.code}: ${error.message}` : `${data.length} row(s)`,
  );
}

// ---- 5. a forged/invalid user token is rejected -------------------------------
{
  const forged = getUserClient('not-a-real-token');
  const { error } = await forged.from('documents').select('id').limit(1);
  record(Boolean(error), 'invalid user token is rejected', error ? `${error.code}` : 'request was accepted!');
}

finish();
