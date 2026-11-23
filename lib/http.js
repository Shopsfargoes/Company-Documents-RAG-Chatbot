// Small helpers shared by every API route.

export class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.name = 'HttpError';
      this.status = status;
    }
  }
  
  const BASE_HEADERS = { 'Cache-Control': 'no-store' };
  
  export function json(data, status = 200, extraHeaders = {}) {
    return Response.json(data, {
      status,
      headers: { ...BASE_HEADERS, ...extraHeaders },
    });
  }
  
  // route({ GET: handler, POST: handler }) builds a Vercel function.
  // A handler may return a plain object (sent as JSON) or a Response.
  // Thrown HttpErrors become clean JSON errors; anything else becomes a
  // generic 500 so internal details never reach the browser.
  export function route(handlers) {
    return {
      async fetch(request) {
        const handler = handlers[request.method];
        if (!handler) {
          return json({ error: 'Method not allowed' }, 405, {
            Allow: Object.keys(handlers).join(', '),
          });
        }
        try {
          const result = await handler(request);
          return result instanceof Response ? result : json(result);
        } catch (err) {
          if (err instanceof HttpError) {
            return json({ error: err.message }, err.status);
          }
          console.error('Unhandled API error:', err?.message ?? err);
          return json({ error: 'Internal server error' }, 500);
        }
      },
    };
  }