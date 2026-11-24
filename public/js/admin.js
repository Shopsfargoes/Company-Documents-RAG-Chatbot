import { apiFetch, requireSession, signOut, redirectToLogin } from './auth.js';

const $ = (id) => document.getElementById(id);

function showNotice(id, text, kind = 'ok') {
  const el = $(id);
  el.textContent = text;
  el.className = `notice ${kind}`;
  el.hidden = false;
}

async function readJson(res) {
  return res.json().catch(() => ({}));
}

async function loadSettings() {
  const res = await apiFetch('/api/admin/settings');
  const body = await readJson(res);
  if (!res.ok) {
    showNotice('settings-notice', body.error || 'Could not load settings.', 'bad');
    return;
  }
  $('visibility').value = body.defaultDocumentVisibility;
}

async function saveSettings() {
  const button = $('save-settings');
  button.disabled = true;
  try {
    const res = await apiFetch('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultDocumentVisibility: $('visibility').value }),
    });
    const body = await readJson(res);
    if (res.ok) {
      showNotice('settings-notice', 'Saved. This applies to documents imported from now on.');
    } else {
      showNotice('settings-notice', body.error || 'Could not save.', 'bad');
    }
  } finally {
    button.disabled = false;
  }
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function renderFiles(files) {
  const tbody = $('files-body');
  tbody.replaceChildren();
  for (const file of files) {
    const row = document.createElement('tr');
    row.append(
      cell(file.path),
      cell(file.kind),
      cell(file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : ''),
      cell(file.supported ? 'Can import' : 'Not supported'),
    );
    tbody.append(row);
  }
  $('files-table').hidden = files.length === 0;
}

async function testDrive() {
  const button = $('test-drive');
  button.disabled = true;
  $('drive-notice').hidden = true;
  renderFiles([]);
  try {
    const res = await apiFetch('/api/admin/drive');
    const body = await readJson(res);
    if (!res.ok) {
      showNotice('drive-notice', body.error || `Request failed (${res.status}).`, 'bad');
      return;
    }
    const extra = body.truncated ? ' (list cut off at 500 files)' : '';
    showNotice(
      'drive-notice',
      `Connected (${body.authMode}). Found ${body.fileCount} file(s); ${body.supportedCount} can be imported${extra}.`,
    );
    renderFiles(body.files);
  } catch (err) {
    console.error(err);
    showNotice('drive-notice', 'Something went wrong. Please try again.', 'bad');
  } finally {
    button.disabled = false;
  }
}

async function main() {
  const session = await requireSession();
  if (!session) return;

  const meRes = await apiFetch('/api/auth/me');
  const me = await readJson(meRes);
  $('loading').hidden = true;

  if (!meRes.ok || me.role !== 'admin') {
    $('forbidden').hidden = false;
    return;
  }
  $('panel').hidden = false;
  await loadSettings();
}

$('save-settings').addEventListener('click', saveSettings);
$('test-drive').addEventListener('click', testDrive);
$('logout').addEventListener('click', async () => {
  await signOut().catch(() => {});
  redirectToLogin();
});

main().catch((err) => {
  console.error(err);
  $('loading').textContent = 'Could not load the page. Please reload or sign in again.';
});