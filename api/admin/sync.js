// POST /api/admin/sync - import (or re-import) documents from the Drive folder.
// Processes a small batch per request; the admin page calls it repeatedly
// until nothing remains. Administrators only.
//
// Body (all optional): { retryFailed, force, removeMissing, skipFileIds[] }
import { route, HttpError } from '../../lib/http.js';
import { requireAdmin } from '../../lib/auth-middleware.js';
import { DriveError, getConfiguredFolderId, listFolderFiles } from '../../lib/google-drive.js';
import { ChunkingError, getChunkSettings } from '../../lib/chunker.js';
import { extractAndChunk } from '../../lib/ingestion.js';
import { StoreError } from '../../lib/document-store.js';
import * as store from '../../lib/document-store.js';
import { runSyncBatch } from '../../lib/sync.js';

const BATCH_SIZE = 3;

function timeBudgetMs() {
  const raw = Number.parseInt(process.env.SYNC_TIME_BUDGET_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 1000 && raw <= 50_000 ? raw : 7000;
}

export default route({
  async POST(request) {
    await requireAdmin(request);

    let body = {};
    try {
      const text = await request.text();
      if (text.trim() !== '') body = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Request body must be valid JSON');
    }
    const skipFileIds = Array.isArray(body.skipFileIds)
      ? body.skipFileIds.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(id)).slice(0, 1000)
      : [];

    try {
      const folderId = getConfiguredFolderId();
      return await runSyncBatch(
        {
          listFiles: () => listFolderFiles(folderId),
          extract: extractAndChunk,
          store,
        },
        {
          batchSize: BATCH_SIZE,
          timeBudgetMs: timeBudgetMs(),
          settings: getChunkSettings(),
          force: body.force === true,
          retryFailed: body.retryFailed === true,
          removeMissing: body.removeMissing === true,
          skipFileIds,
        },
      );
    } catch (err) {
      if (err instanceof DriveError) throw new HttpError(err.status, err.message);
      if (err instanceof ChunkingError || err instanceof StoreError) throw new HttpError(500, err.message);
      throw err;
    }
  },
});