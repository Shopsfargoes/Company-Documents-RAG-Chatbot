// GET /api/admin/drive - read-only connection test: lists the files in the
// configured Drive folder and shows which formats can be imported.
// Administrators only. Writes nothing to the database.
import { route, HttpError } from '../../lib/http.js';
import { requireAdmin } from '../../lib/auth-middleware.js';
import { DriveError, getAuthMode, getConfiguredFolderId, listFolderFiles } from '../../lib/google-drive.js';

export default route({
  async GET(request) {
    await requireAdmin(request);
    try {
      const authMode = getAuthMode();
      const { files, truncated } = await listFolderFiles(getConfiguredFolderId());
      return {
        authMode,
        fileCount: files.length,
        supportedCount: files.filter((file) => file.supported).length,
        truncated,
        files,
      };
    } catch (err) {
      // DriveError messages are written to be safe for administrators.
      if (err instanceof DriveError) throw new HttpError(err.status, err.message);
      throw err;
    }
  },
});