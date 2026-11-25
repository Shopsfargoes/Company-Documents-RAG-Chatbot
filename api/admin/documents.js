// GET   /api/admin/documents                      list imported documents
// PATCH /api/admin/documents  { id, visibility }  change one document's visibility
// Administrators only.
import { route, HttpError } from '../../lib/http.js';
import { requireAdmin } from '../../lib/auth-middleware.js';
import { StoreError, listDocumentsForAdmin, setDocumentVisibility } from '../../lib/document-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISIBILITIES = new Set(['company', 'restricted']);

async function withStoreErrors(work) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof StoreError) throw new HttpError(500, err.message);
    throw err;
  }
}

export default route({
  async GET(request) {
    await requireAdmin(request);
    return withStoreErrors(async () => ({ documents: await listDocumentsForAdmin() }));
  },

  async PATCH(request) {
    await requireAdmin(request);

    let body;
    try {
      body = await request.json();
    } catch {
      throw new HttpError(400, 'Request body must be valid JSON');
    }
    if (typeof body?.id !== 'string' || !UUID.test(body.id)) {
      throw new HttpError(400, 'A valid document id is required');
    }
    if (!VISIBILITIES.has(body?.visibility)) {
      throw new HttpError(400, "visibility must be 'company' or 'restricted'");
    }

    return withStoreErrors(async () => {
      const updated = await setDocumentVisibility(body.id, body.visibility);
      if (!updated) throw new HttpError(404, 'Document not found');
      return { id: body.id, visibility: body.visibility };
    });
  },
});