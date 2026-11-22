# Company Documents RAG Chatbot

Vercel (static frontend + Node.js functions) · Supabase (Auth, Postgres, pgvector) · Gemini + OpenRouter · Google Drive.

## Local setup
1. `npm install @supabase/supabase-js`
2. Copy `.env.example` to `.env.local` and fill in the Supabase values.
3. Apply `database/schema.sql` in the Supabase SQL Editor, then run `database/verify.sql`.
4. `npm run test:connection`
5. `npx vercel dev` and open http://localhost:3000

Secrets live only in `.env.local` / Vercel environment variables. Never commit them.
