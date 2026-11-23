-- ==========================================================================
-- COMPANY DOCUMENTS RAG CHATBOT - DATABASE SCHEMA (v2, reviewed)
-- Target: a fresh Supabase project. Run once in the Supabase SQL Editor.
-- The whole script is one transaction: if any statement fails, nothing is
-- applied, so you can fix the problem and run it again.
--
-- Changes from the v1 starter schema (see the review notes in chat):
--   * Explicit GRANTs (Supabase no longer auto-exposes new public tables)
--   * Browser-facing roles are read-mostly; all privileged writes go through
--     the backend (service role) after explicit authorization checks
--   * Profile role cannot be changed by users (column grant + policy)
--   * Authorization lives in one function, can_read_document(), used by the
--     RLS policies AND by match_document_chunks()
--   * match_document_chunks() fails closed when called without a user session
--   * Only 'indexed' documents are readable by non-admins
--   * FK fix (documents.owner_id), NOT NULL timestamps, size/shape checks,
--     missing indexes, updated_at handling, ingestion bookkeeping columns
-- ==========================================================================

begin;

-- 1. pgvector ---------------------------------------------------------------
create extension if not exists vector with schema extensions;

-- 2. Tables -----------------------------------------------------------------
create table public.profiles (
    id         uuid primary key references auth.users(id) on delete cascade,
    full_name  text check (full_name is null or char_length(full_name) <= 200),
    email      text,
    role       text not null default 'employee'
               check (role in ('admin', 'manager', 'employee')),
    created_at timestamptz not null default now()
);

create table public.documents (
    id               uuid primary key default gen_random_uuid(),
    title            text not null check (char_length(title) between 1 and 500),
    drive_file_id    text not null unique,
    mime_type        text,
    description      text,
    web_view_link    text,
    owner_id         uuid references public.profiles(id) on delete set null,
    visibility       text not null default 'company'
                     check (visibility in ('company', 'restricted')),
    status           text not null default 'pending'
                     check (status in ('pending', 'processing', 'indexed', 'failed')),
    error_message    text,
    content_hash     text,
    file_size_bytes  bigint check (file_size_bytes is null or file_size_bytes >= 0),
    file_modified_at timestamptz,
    last_synced_at   timestamptz,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table public.document_permissions (
    id          uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.documents(id) on delete cascade,
    user_id     uuid not null references public.profiles(id) on delete cascade,
    created_at  timestamptz not null default now(),
    unique (document_id, user_id)
);

create table public.document_chunks (
    id              uuid primary key default gen_random_uuid(),
    document_id     uuid not null references public.documents(id) on delete cascade,
    chunk_index     integer not null check (chunk_index >= 0),
    content         text not null,
    embedding       extensions.vector(768),
    embedding_model text not null default 'gemini-embedding-2',
    token_count     integer,
    metadata        jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(metadata) = 'object'),
    created_at      timestamptz not null default now(),
    unique (document_id, chunk_index)   -- also serves as the document_id index
);

create table public.conversations (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references public.profiles(id) on delete cascade,
    title      text not null default 'New conversation'
               check (char_length(title) between 1 and 200),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.messages (
    id              uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    role            text not null check (role in ('user', 'assistant')),
    content         text not null check (char_length(content) between 1 and 50000),
    sources         jsonb not null default '[]'::jsonb
                    check (jsonb_typeof(sources) = 'array'),
    ai_provider     text,
    model           text,
    created_at      timestamptz not null default now()
);

-- 3. Indexes ----------------------------------------------------------------
create index document_chunks_embedding_idx
    on public.document_chunks using hnsw (embedding extensions.vector_cosine_ops);

create index documents_status_idx          on public.documents (status);
create index documents_owner_id_idx        on public.documents (owner_id);
create index document_permissions_user_idx on public.document_permissions (user_id);
create index conversations_user_updated_idx
    on public.conversations (user_id, updated_at desc);
create index messages_conversation_created_idx
    on public.messages (conversation_id, created_at);

-- 4. Helper functions -------------------------------------------------------
-- All SECURITY DEFINER functions pin search_path to '' and use qualified names.

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.profiles
        where id = (select auth.uid()) and role = 'admin'
    );
$$;

create or replace function public.current_user_role()
returns text
language sql stable security definer set search_path = ''
as $$
    select role from public.profiles where id = (select auth.uid());
$$;

-- The single source of truth for "may the current user read this document?".
-- Admins: any document. Everyone else: only INDEXED documents that are
-- company-visible, owned by them, or explicitly shared with them.
-- With no signed-in user (auth.uid() is NULL) the answer is always false.
create or replace function public.can_read_document(p_document_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1
        from public.documents d
        where d.id = p_document_id
          and (select auth.uid()) is not null   -- fail closed: no user, no access
          and (
              (select public.is_admin())
              or (
                  d.status = 'indexed'
                  and (
                      d.visibility = 'company'
                      or d.owner_id = (select auth.uid())
                      or exists (
                          select 1 from public.document_permissions dp
                          where dp.document_id = d.id
                            and dp.user_id = (select auth.uid())
                      )
                  )
              )
          )
    );
$$;

-- 5. Triggers ---------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    -- role is never taken from user-supplied metadata; it always defaults to
    -- 'employee'. Admins are promoted manually (see setup instructions).
    insert into public.profiles (id, email, full_name)
    values (new.id, new.email, left(new.raw_user_meta_data ->> 'full_name', 200))
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- Backfill profiles for any users that already exist (safe to re-run).
insert into public.profiles (id, email, full_name)
select u.id, u.email, left(u.raw_user_meta_data ->> 'full_name', 200)
from auth.users u
on conflict (id) do nothing;

create or replace function public.set_updated_at()
returns trigger
language plpgsql set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger documents_set_updated_at
    before update on public.documents
    for each row execute function public.set_updated_at();

create or replace function public.touch_conversation()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    update public.conversations set updated_at = now()
    where id = new.conversation_id;
    return new;
end;
$$;

create trigger messages_touch_conversation
    after insert on public.messages
    for each row execute function public.touch_conversation();

-- 6. Row Level Security -----------------------------------------------------
alter table public.profiles             enable row level security;
alter table public.documents            enable row level security;
alter table public.document_permissions enable row level security;
alter table public.document_chunks      enable row level security;
alter table public.conversations        enable row level security;
alter table public.messages             enable row level security;

-- profiles
create policy "Users view own profile, admins view all"
on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select public.is_admin()));

-- NOTE: the role check uses a SECURITY DEFINER helper instead of a subquery on
-- public.profiles, because a policy on a table that queries the same table can
-- fail with "infinite recursion detected in policy". The column-level grant
-- below (only full_name is updatable) is the primary protection.
create policy "Users update own profile"
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (
    id = (select auth.uid())
    and role = (select public.current_user_role())
);

-- documents / permissions / chunks: read-only for browser roles.
-- Writes happen only in the backend with the service role.
create policy "Read accessible documents"
on public.documents for select to authenticated
using (public.can_read_document(id));

create policy "Read own permissions, admins read all"
on public.document_permissions for select to authenticated
using (user_id = (select auth.uid()) or (select public.is_admin()));

create policy "Read chunks of accessible documents"
on public.document_chunks for select to authenticated
using (public.can_read_document(document_id));

-- conversations / messages
create policy "Users manage own conversations"
on public.conversations for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "Users read messages of own conversations"
on public.messages for select to authenticated
using (
    exists (
        select 1 from public.conversations c
        where c.id = messages.conversation_id
          and c.user_id = (select auth.uid())
    )
);

-- 7. Vector search ----------------------------------------------------------
-- SECURITY INVOKER + RLS + an explicit can_read_document() check.
-- Call it with a client authenticated as the end user. If it is called with
-- the service-role key (no user session) auth.uid() is NULL, so it returns
-- NOTHING instead of leaking every chunk.
create or replace function public.match_document_chunks(
    query_embedding     extensions.vector(768),
    p_embedding_model   text,
    match_count         integer default 5,
    filter_document_id  uuid default null,
    min_similarity      double precision default 0.0
)
returns table (
    chunk_id       uuid,
    document_id    uuid,
    chunk_index    integer,
    content        text,
    metadata       jsonb,
    similarity     double precision,
    document_title text,
    drive_file_id  text
)
language sql stable security invoker set search_path = ''
as $$
    select
        dc.id,
        dc.document_id,
        dc.chunk_index,
        dc.content,
        dc.metadata,
        1 - (dc.embedding operator(extensions.<=>) query_embedding),
        d.title,
        d.drive_file_id
    from public.document_chunks dc
    join public.documents d on d.id = dc.document_id
    where dc.embedding is not null
      and dc.embedding_model = p_embedding_model
      and d.status = 'indexed'
      and (filter_document_id is null or dc.document_id = filter_document_id)
      and public.can_read_document(d.id)
      and 1 - (dc.embedding operator(extensions.<=>) query_embedding) >= min_similarity
    order by dc.embedding operator(extensions.<=>) query_embedding
    limit least(greatest(match_count, 1), 20);
$$;

-- 8. Privileges (explicit, least privilege) ---------------------------------
-- Start from zero for the browser-facing roles, then grant only what is needed.
revoke all on table
    public.profiles, public.documents, public.document_permissions,
    public.document_chunks, public.conversations, public.messages
from anon, authenticated;

-- anon (not signed in): no table access at all.

-- authenticated (signed-in users, RLS-filtered)
grant select on public.profiles             to authenticated;
grant update (full_name) on public.profiles to authenticated;  -- NOT role/email
grant select on public.documents            to authenticated;
grant select on public.document_permissions to authenticated;
grant select on public.document_chunks      to authenticated;
grant select, insert, delete on public.conversations to authenticated;
grant update (title) on public.conversations         to authenticated;
grant select on public.messages             to authenticated;  -- no insert: server writes messages

-- service_role (backend only; bypasses RLS, so every endpoint must check
-- the caller itself before using it)
grant select, insert, update, delete on
    public.profiles, public.documents, public.document_permissions,
    public.document_chunks, public.conversations, public.messages
to service_role;

-- Functions: PUBLIC has EXECUTE by default in Postgres; remove it.
revoke execute on function public.handle_new_user()     from public, anon, authenticated;
revoke execute on function public.set_updated_at()      from public, anon, authenticated;
revoke execute on function public.touch_conversation()  from public, anon, authenticated;

revoke execute on function public.is_admin()                from public, anon;
revoke execute on function public.current_user_role()       from public, anon;
revoke execute on function public.can_read_document(uuid)   from public, anon;
revoke execute on function public.match_document_chunks(
    extensions.vector, text, integer, uuid, double precision) from public, anon;

grant execute on function public.is_admin()              to authenticated, service_role;
grant execute on function public.current_user_role()     to authenticated, service_role;
grant execute on function public.can_read_document(uuid) to authenticated, service_role;
grant execute on function public.match_document_chunks(
    extensions.vector, text, integer, uuid, double precision)
    to authenticated, service_role;

commit;