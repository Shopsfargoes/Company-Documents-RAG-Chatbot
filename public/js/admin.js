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

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

// ---- default visibility setting ------------------------------------------------------
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

// ---- imported documents ------------------------------------------------------------------
async function changeVisibility(doc, select) {
  select.disabled = true;
  try {
    const res = await apiFetch('/api/admin/documents', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: doc.id, visibility: select.value }),
    });
    if (!res.ok) {
      const body = await readJson(res);
      showNotice('sync-notice', body.error || 'Could not change the visibility.', 'bad');
      await loadDocuments();
    }
  } finally {
    select.disabled = false;
  }
}

function renderDocuments(documents) {
  const tbody = $('docs-body');
  tbody.replaceChildren();
  for (const doc of documents) {
    const row = document.createElement('tr');

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${doc.status}`;
    badge.textContent = doc.status;
    statusCell.append(badge);
    if (doc.errorMessage) {
      const error = document.createElement('div');
      error.className = 'muted small-text';
      error.textContent = doc.errorMessage;
      statusCell.append(error);
    }

    const visibilityCell = document.createElement('td');
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Visibility of ${doc.title}`);
    for (const [value, label] of [['restricted', 'Restricted'], ['company', 'Company']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = doc.visibility;
    select.addEventListener('change', () => changeVisibility(doc, select));
    visibilityCell.append(select);

    row.append(
      cell(doc.title),
      statusCell,
      visibilityCell,
      cell(String(doc.chunkCount)),
      cell(doc.updatedAt ? new Date(doc.updatedAt).toLocaleString() : ''),
    );
    tbody.append(row);
  }
  $('docs-table').hidden = documents.length === 0;
}

async function loadDocuments() {
  const res = await apiFetch('/api/admin/documents');
  const body = await readJson(res);
  if (!res.ok) {
    showNotice('sync-notice', body.error || 'Could not load the documents.', 'bad');
    return;
  }
  renderDocuments(body.documents);
}

let syncing = false;

function setSyncButtons(disabled) {
  for (const id of ['sync', 'retry-failed', 'remove-missing']) $(id).disabled = disabled;
}

function showMissing(missing) {
  const button = $('remove-missing');
  button.hidden = missing.length === 0;
  button.textContent = `Remove ${missing.length} document(s) no longer in Drive`;
  button.dataset.count = String(missing.length);
}

// Calls the sync endpoint repeatedly (a few files per call) until nothing remains.
async function runSync({ retryFailed = false, removeMissing = false } = {}) {
  if (syncing) return;
  syncing = true;
  setSyncButtons(true);

  const attempted = [];
  let imported = 0;
  let failed = 0;
  let skippedUnsupported = 0;
  let truncated = false;
  let missing = [];
  let removed = 0;

  try {
    for (let round = 0; round < 100; round += 1) {
      showNotice(
        'sync-notice',
        round === 0 ? 'Importing\u2026' : `Importing\u2026 ${imported} done${failed ? `, ${failed} failed` : ''}`,
      );
      const res = await apiFetch('/api/admin/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retryFailed, removeMissing, skipFileIds: attempted }),
      });
      const body = await readJson(res);
      if (!res.ok) {
        showNotice('sync-notice', body.error || `Import failed (${res.status}).`, 'bad');
        return;
      }

      for (const item of body.processed) {
        attempted.push(item.fileId);
        if (item.status === 'chunked') imported += 1;
        else if (item.status === 'failed') failed += 1;
      }
      skippedUnsupported = body.skippedUnsupported;
      truncated = body.truncated;
      missing = body.missing;
      removed += body.removed;

      if (body.remaining === 0 || body.processed.length === 0) break;
    }

    const parts = [];
    if (imported === 0 && failed === 0) parts.push('Everything is up to date.');
    else parts.push(`${imported} imported, ${failed} failed.`);
    if (removed) parts.push(`${removed} removed.`);
    if (skippedUnsupported) parts.push(`${skippedUnsupported} unsupported file(s) skipped.`);
    if (truncated) parts.push('The Drive folder has more than 500 files; only the first 500 were checked.');
    showNotice('sync-notice', parts.join(' '), failed > 0 ? 'bad' : 'ok');
  } catch (err) {
    console.error(err);
    showNotice('sync-notice', 'Something went wrong. Please try again.', 'bad');
  } finally {
    syncing = false;
    setSyncButtons(false);
    showMissing(missing);
    await loadDocuments().catch(() => {});
  }
}

// ---- Drive file list --------------------------------------------------------------------
function renderFiles(files) {
  const tbody = $('files-body');
  tbody.replaceChildren();
  for (const file of files) {
    const row = document.createElement('tr');

    const previewCell = document.createElement('td');
    if (file.supported) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary small';
      button.textContent = 'Preview';
      button.addEventListener('click', () => previewFile(file, button));
      previewCell.append(button);
    }

    row.append(
      cell(file.path),
      cell(file.kind),
      cell(file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : ''),
      cell(file.supported ? 'Can import' : 'Not supported'),
      previewCell,
    );
    tbody.append(row);
  }
  $('files-table').hidden = files.length === 0;
}

async function testDrive() {
  const button = $('test-drive');
  button.disabled = true;
  $('drive-notice').hidden = true;
  $('preview').hidden = true;
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

// ---- chunk preview ---------------------------------------------------------------------
function renderChunks(samples) {
  const container = $('preview-chunks');
  container.replaceChildren();
  for (const sample of samples) {
    const meta = sample.metadata;
    const parts = [`Chunk ${sample.chunkIndex}`, `~${sample.tokenCount} tokens`];
    if (meta.section) parts.push(`Section: ${meta.section}`);
    if (meta.page !== null) {
      parts.push(meta.pageEnd !== meta.page ? `Pages ${meta.page}-${meta.pageEnd}` : `Page ${meta.page}`);
    }

    const article = document.createElement('article');
    article.className = 'chunk';
    const caption = document.createElement('div');
    caption.className = 'muted';
    caption.textContent = parts.join(' \u00b7 ');
    const text = document.createElement('pre');
    text.textContent = sample.content;
    article.append(caption, text);
    container.append(article);
  }
}

async function previewFile(file, button) {
  button.disabled = true;
  const section = $('preview');
  section.hidden = false;
  $('preview-notice').hidden = true;
  $('preview-summary').textContent = '';
  $('preview-chunks').replaceChildren();
  showNotice('preview-notice', `Reading ${file.name}\u2026`);
  section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const res = await apiFetch(`/api/admin/preview?fileId=${encodeURIComponent(file.id)}`);
    const body = await readJson(res);
    if (!res.ok) {
      showNotice('preview-notice', body.error || `Request failed (${res.status}).`, 'bad');
      return;
    }
    $('preview-notice').hidden = true;
    const pages = body.pageCount ? `${body.pageCount} page(s), ` : '';
    $('preview-summary').textContent =
      `${body.file.name}: ${pages}${body.characters.toLocaleString()} characters, ` +
      `${body.chunkCount} chunk(s) (target ${body.settings.targetChars} characters, ` +
      `overlap ${body.settings.overlapChars}). Showing the first ${body.samples.length}.`;
    renderChunks(body.samples);
  } catch (err) {
    console.error(err);
    showNotice('preview-notice', 'Something went wrong. Please try again.', 'bad');
  } finally {
    button.disabled = false;
  }
}

// ---- start ---------------------------------------------------------------------------------
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
  await Promise.all([loadSettings(), loadDocuments()]);
}

$('save-settings').addEventListener('click', saveSettings);
$('sync').addEventListener('click', () => runSync());
$('retry-failed').addEventListener('click', () => runSync({ retryFailed: true }));
$('remove-missing').addEventListener('click', () => {
  const count = $('remove-missing').dataset.count;
  if (window.confirm(`Remove ${count} document(s) and their chunks? They are no longer in the Drive folder.`)) {
    runSync({ removeMissing: true });
  }
});
$('test-drive').addEventListener('click', testDrive);
$('logout').addEventListener('click', async () => {
  await signOut().catch(() => {});
  redirectToLogin();
});

main().catch((err) => {
  console.error(err);
  $('loading').textContent = 'Could not load the page. Please reload or sign in again.';
});