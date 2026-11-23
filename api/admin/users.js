// GET /api/admin/users - list accounts. Administrators only.
import { route, HttpError } from '../../lib/http.js';
import { requireAdmin } from '../../lib/auth-middleware.js';
import { getAdminClient } from '../../lib/supabase.js';

export default route({
  async GET(request) {
    await requireAdmin(request);

    const { data, error } = await getAdminClient()
      .from('profiles')
      .select('id, email, full_name, role, created_at')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      console.error('Listing users failed:', error.message);
      throw new HttpError(500, 'Could not load users');
    }
    return { users: data };
  },
});