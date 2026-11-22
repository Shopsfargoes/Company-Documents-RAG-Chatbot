// GET /api/health - confirms the function runs and the database is reachable.
// Deliberately returns no configuration details. Remove or protect before
// production hardening (Milestone 7).
import { getAdminClient } from '../lib/supabase.js';

const JSON_HEADERS = { 'Cache-Control': 'no-store' };

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return Response.json(
        { ok: false, error: 'Method not allowed' },
        { status: 405, headers: { ...JSON_HEADERS, Allow: 'GET' } },
      );
    }

    try {
      const { error } = await getAdminClient()
        .from('documents')
        .select('id', { count: 'exact', head: true });
      if (error) throw error;
      return Response.json({ ok: true, database: 'reachable' }, { headers: JSON_HEADERS });
    } catch (err) {
      console.error('health check failed:', err?.message ?? err);
      return Response.json(
        { ok: false, database: 'unreachable' },
        { status: 503, headers: JSON_HEADERS },
      );
    }
  },
};
