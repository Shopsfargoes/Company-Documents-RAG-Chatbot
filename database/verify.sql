-- Run these AFTER schema.sql (Supabase SQL Editor). Expected results are in the comments.

-- 1. Which schema holds pgvector?  Expect: schema = extensions  (the schema assumes this)
select e.extname, n.nspname as schema, e.extversion
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'vector';

-- 2. RLS enabled on every table?  Expect: rls_enabled = true for all 6 rows
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

-- 3. Policies.  Expect 7 rows: profiles (2), documents, document_permissions,
--    document_chunks, conversations, messages (1 each)
select tablename, policyname, cmd, roles
from pg_policies where schemaname = 'public'
order by tablename, policyname;

-- 4. Table privileges.  Expect: NO rows for anon; authenticated = SELECT (plus
--    INSERT, DELETE on conversations only); service_role = full CRUD
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
group by table_name, grantee
order by table_name, grantee;

-- 5. Column-level UPDATE privileges.  Expect exactly: authenticated can update
--    profiles.full_name and conversations.title, nothing else
select table_name, grantee, column_name
from information_schema.column_privileges
where table_schema = 'public' and grantee in ('anon', 'authenticated')
  and privilege_type = 'UPDATE'
order by table_name, column_name;

-- 6. Function EXECUTE matrix.  Expect: anon = false on every row;
--    authenticated/service_role = true for the first four, false for handle_new_user
select f.sig,
       has_function_privilege('anon', f.sig, 'execute')          as anon,
       has_function_privilege('authenticated', f.sig, 'execute') as authenticated,
       has_function_privilege('service_role', f.sig, 'execute')  as service_role
from (values
    ('public.is_admin()'),
    ('public.current_user_role()'),
    ('public.can_read_document(uuid)'),
    ('public.match_document_chunks(extensions.vector, text, integer, uuid, double precision)'),
    ('public.handle_new_user()')
) as f(sig);
