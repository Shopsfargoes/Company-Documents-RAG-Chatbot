// GET/PATCH /api/admin/settings - admin-editable behaviour. Administrators only.
// Currently one setting: whether newly imported documents start visible to all
// employees ('company') or locked until an admin grants access ('restricted').
import { route, HttpError } from '../../lib/http.js';
import { requireAdmin } from '../../lib/auth-middleware.js';
import { getAdminClient } from '../../lib/supabase.js';

const KEY = 'default_document_visibility';
const ALLOWED = new Set(['company', 'restricted']);

export default route({
  async GET(request) {
    await requireAdmin(request);
    const { data, error } = await getAdminClient()
      .from('app_settings')
      .select('value, updated_at')
      .eq('key', KEY)
      .maybeSingle();
    if (error) {
      console.error('Reading settings failed:', error.message);
      throw new HttpError(500, 'Could not load settings');
    }
    return {
      defaultDocumentVisibility: data?.value ?? 'restricted',
      updatedAt: data?.updated_at ?? null,
    };
  },

  async PATCH(request) {
    const { profile } = await requireAdmin(request);

    let body;
    try {
      body = await request.json();
    } catch {
      throw new HttpError(400, 'Request body must be valid JSON');
    }
    const value = body?.defaultDocumentVisibility;
    if (!ALLOWED.has(value)) {
      throw new HttpError(400, "defaultDocumentVisibility must be 'company' or 'restricted'");
    }

    const { error } = await getAdminClient()
      .from('app_settings')
      .upsert(
        { key: KEY, value, updated_by: profile.id, updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      );
    if (error) {
      console.error('Saving settings failed:', error.message);
      throw new HttpError(500, 'Could not save settings');
    }
    return { defaultDocumentVisibility: value };
  },
});