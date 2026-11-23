// GET /api/auth/me - who am I? Requires a valid session.
import { route } from '../../lib/http.js';
import { authenticate } from '../../lib/auth-middleware.js';

export default route({
  async GET(request) {
    const { profile } = await authenticate(request);
    return {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      role: profile.role,
    };
  },
});