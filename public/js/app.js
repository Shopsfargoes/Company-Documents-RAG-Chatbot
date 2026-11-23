import { apiFetch, requireSession, signOut, redirectToLogin } from './auth.js';

const $ = (id) => document.getElementById(id);

function setStatus(el, text, ok) {
  el.textContent = text;
  el.className = `status ${ok ? 'ok' : 'bad'}`;
}

async function main() {
  const session = await requireSession();
  if (!session) return;

  const meRes = await apiFetch('/api/auth/me');
  if (!meRes.ok) throw new Error(`/api/auth/me returned ${meRes.status}`);
  const me = await meRes.json();

  $('whoami').textContent = `Signed in as ${me.fullName || me.email} (${me.role})`;
  $('loading').hidden = true;
  $('app').hidden = false;

  // Backend + database check (public endpoint)
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const body = await res.json();
    setStatus($('health'), res.ok && body.ok ? 'Backend and database: reachable' : 'Backend and database: problem', res.ok && body.ok);
  } catch {
    setStatus($('health'), 'Backend and database: problem', false);
  }

  // Milestone 2 self-check: the admin API must accept admins and refuse everyone else.
  const adminRes = await apiFetch('/api/admin/users');
  if (adminRes.ok) {
    const { users } = await adminRes.json();
    setStatus($('admin-check'), `Admin API: allowed (${users.length} account(s) found)`, true);
  } else if (adminRes.status === 403) {
    setStatus($('admin-check'), 'Admin API: refused (403) - correct for non-admin accounts', true);
  } else {
    setStatus($('admin-check'), `Admin API: unexpected response ${adminRes.status}`, false);
  }
}

$('logout').addEventListener('click', async () => {
  await signOut().catch(() => {});
  redirectToLogin();
});

main().catch((err) => {
  console.error(err);
  $('loading').textContent = 'Could not load the page. Please reload or sign in again.';
});