// GET /api/admin/preview?fileId=<Drive file ID>
// Downloads one file from the configured Drive folder, parses it, splits it
// into chunks and returns a SUMMARY plus the first few chunks. Writes nothing
// to the database. Administrators only.
import { route, HttpError } from '../../lib/http.js';
import { requireAdmin } from '../../lib/auth-middleware.js';
import { DriveError, getConfiguredFolderId, listFolderFiles } from '../../lib/google-drive.js';
import { ParseError } from '../../lib/document-parser.js';
import { ChunkingError } from '../../lib/chunker.js';
import { extractAndChunk } from '../../lib/ingestion.js';

const SAMPLE_COUNT = 3;
const SAMPLE_MAX_CHARS = 800;

export default route({
  async GET(request) {
    await requireAdmin(request);

    const fileId = new URL(request.url).searchParams.get('fileId') ?? '';
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
      throw new HttpError(400, 'A valid fileId is required');
    }

    try {
      // Only files inside the configured folder can be previewed.
      const { files } = await listFolderFiles(getConfiguredFolderId());
      const file = files.find((candidate) => candidate.id === fileId);
      if (!file) throw new HttpError(404, 'That file is not in the configured Drive folder');
      if (!file.supported) throw new HttpError(422, 'This file type is not supported yet');

      const result = await extractAndChunk(file);
      return {
        file: { id: file.id, name: file.name, path: file.path, kind: file.kind },
        pageCount: result.pageCount,
        characters: result.characters,
        chunkCount: result.chunks.length,
        settings: result.settings,
        samples: result.chunks.slice(0, SAMPLE_COUNT).map((chunk) => ({
          chunkIndex: chunk.chunkIndex,
          tokenCount: chunk.tokenCount,
          metadata: chunk.metadata,
          content: chunk.content.slice(0, SAMPLE_MAX_CHARS),
        })),
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof DriveError) throw new HttpError(err.status, err.message);
      if (err instanceof ParseError || err instanceof ChunkingError) {
        throw new HttpError(422, err.message);
      }
      throw err;
    }
  },
});