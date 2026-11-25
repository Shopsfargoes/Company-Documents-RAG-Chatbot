// The Drive -> database import logic. Pure logic: the file listing, the
// extraction and the database are passed in, so it can be tested without
// Google or Supabase.
import { DriveError } from './google-drive.js';
import { ParseError } from './document-parser.js';
import { ChunkingError } from './chunker.js';
import { StoreError } from './document-store.js';

const STUCK_PROCESSING_MS = 5 * 60 * 1000;
const MAX_ERROR_LENGTH = 500;

// Identifies one version of a file AND the chunk settings used for it, so a
// changed file or changed CHUNK_SIZE_CHARS both trigger a re-import.
export function fingerprint(file, settings) {
  const version = file.md5Checksum ?? `modified:${file.modifiedTime ?? 'unknown'}`;
  return `${version}|chunk:${settings.targetChars}:${settings.overlapChars}`;
}

// -> 'process' | 'skip'
export function decideAction(file, existing, { settings, force = false, retryFailed = false, nowMs }) {
  if (!existing) return 'process';
  if (force) return 'process';
  const hash = fingerprint(file, settings);
  switch (existing.status) {
    case 'pending':
      return 'process';
    case 'processing': {
      const age = nowMs - new Date(existing.updated_at).getTime();
      return age > STUCK_PROCESSING_MS ? 'process' : 'skip'; // skip if another request is on it
    }
    case 'failed':
      return retryFailed || existing.content_hash !== hash ? 'process' : 'skip';
    default: // 'chunked' | 'indexed'
      return existing.content_hash === hash ? 'skip' : 'process';
  }
}

function safeMessage(err) {
  if (
    err instanceof DriveError ||
    err instanceof ParseError ||
    err instanceof ChunkingError ||
    err instanceof StoreError
  ) {
    return err.message.slice(0, MAX_ERROR_LENGTH);
  }
  console.error('Unexpected error while importing a file:', err?.message ?? err);
  return 'Unexpected error while processing this file (see the server logs)';
}

// deps: { listFiles(), extract(file), store, now() }
// options: { batchSize, timeBudgetMs, force, retryFailed, removeMissing, skipFileIds, settings }
export async function runSyncBatch(deps, options) {
  const { listFiles, extract, store, now = () => Date.now() } = deps;
  const {
    batchSize,
    timeBudgetMs,
    settings,
    force = false,
    retryFailed = false,
    removeMissing = false,
    skipFileIds = [],
  } = options;

  const { files, truncated } = await listFiles();
  const supported = files.filter((file) => file.supported);
  const existingDocs = await store.loadAllDocuments();
  const byDriveId = new Map(existingDocs.map((doc) => [doc.drive_file_id, doc]));
  const alreadyTried = new Set(skipFileIds);

  const queue = supported.filter(
    (file) =>
      !alreadyTried.has(file.id) &&
      decideAction(file, byDriveId.get(file.id), { settings, force, retryFailed, nowMs: now() }) === 'process',
  );
  // New files first, then re-imports of changed or failed ones.
  queue.sort((a, b) => Number(byDriveId.has(a.id)) - Number(byDriveId.has(b.id)));

  const started = now();
  const processed = [];
  let defaultVisibility = null;

  for (const file of queue) {
    if (processed.length >= batchSize) break;
    if (processed.length > 0 && now() - started > timeBudgetMs) break;

    const existing = byDriveId.get(file.id);
    const hash = fingerprint(file, settings);
    let documentId = existing?.id ?? null;

    try {
      const record = {
        title: file.name,
        mime_type: file.mimeType,
        web_view_link: file.webViewLink,
        file_size_bytes: file.size,
        file_modified_at: file.modifiedTime,
        status: 'processing',
        error_message: null,
        last_synced_at: new Date(now()).toISOString(),
      };

      if (existing) {
        await store.updateDocument(existing.id, record); // visibility is never touched here
      } else {
        defaultVisibility ??= await store.getDefaultVisibility();
        const created = await store.insertDocument({
          ...record,
          drive_file_id: file.id,
          visibility: defaultVisibility,
        });
        if (!created) {
          processed.push({ fileId: file.id, name: file.name, status: 'skipped', note: 'Already being imported by another request' });
          continue;
        }
        documentId = created.id;
      }

      const result = await extract(file);
      if (result.chunks.length === 0) throw new ParseError('No text could be extracted from this file');
      const chunkCount = await store.replaceChunks(documentId, hash, result.chunks);
      processed.push({ fileId: file.id, name: file.name, status: 'chunked', chunkCount });
    } catch (err) {
      const message = safeMessage(err);
      if (documentId) {
        await store.markFailed(documentId, hash, message).catch((markError) => {
          console.error('Could not record the failure:', markError?.message ?? markError);
        });
      }
      processed.push({ fileId: file.id, name: file.name, status: 'failed', error: message });
    }
  }

  // Documents that are no longer in Drive. Only judged when the Drive listing
  // is complete, and only deleted when the admin explicitly asks.
  let missing = [];
  let removed = 0;
  if (!truncated) {
    const driveIds = new Set(files.map((file) => file.id));
    missing = existingDocs
      .filter((doc) => !driveIds.has(doc.drive_file_id))
      .map((doc) => ({ id: doc.id, title: doc.title }));
    if (removeMissing && missing.length > 0) {
      await store.deleteDocuments(missing.map((doc) => doc.id));
      removed = missing.length;
      missing = [];
    }
  }

  return {
    processed,
    remaining: queue.length - processed.filter((item) => item.status !== 'skipped').length,
    skippedUnsupported: files.length - supported.length,
    truncated,
    missing,
    removed,
  };
}