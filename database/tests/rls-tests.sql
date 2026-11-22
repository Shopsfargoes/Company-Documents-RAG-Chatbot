-- ==========================================================================
-- RLS / AUTHORIZATION TESTS  (run in the Supabase SQL Editor)
--
-- PREREQUISITE: create two users in Dashboard > Authentication > Users
-- ("Add user", tick "Auto Confirm User"):
--     alice@test.local   (stays an ordinary employee)
--     bob@test.local     (is promoted to admin INSIDE this test only)
--
-- HOW IT WORKS: the whole script is ONE statement (a DO block), so Postgres
-- either aborts it (a test failed) or reaches the final RAISE EXCEPTION.
-- Either way everything is rolled back - no test data is ever left behind.
--
-- HOW TO READ THE RESULT:
--   * ERROR: ... ALL RLS TESTS PASSED ...   -> SUCCESS (the "error" is the
--                                              deliberate rollback signal)
--   * ERROR: ... Assertion failed / T<n> ...-> a test failed; read the message
-- ==========================================================================

do $test$
declare
    v_alice       uuid;
    v_bob         uuid;
    v_company     constant uuid := '00000000-0000-0000-0000-0000000000a1';
    v_restricted  constant uuid := '00000000-0000-0000-0000-0000000000a2';
    v_pending     constant uuid := '00000000-0000-0000-0000-0000000000a3';
    v_q           extensions.vector(768)
                  := array_fill(0.1::real, array[768])::extensions.vector(768);
    n             integer;
    t             text;
    v_conv        uuid;
begin
    ------------------------------------------------------------------ setup
    select id into v_alice from public.profiles where email = 'alice@test.local';
    select id into v_bob   from public.profiles where email = 'bob@test.local';
    assert v_alice is not null, 'SETUP: user alice@test.local does not exist yet';
    assert v_bob   is not null, 'SETUP: user bob@test.local does not exist yet';

    update public.profiles set role = 'admin' where id = v_bob;   -- rolled back later

    insert into public.documents (id, title, drive_file_id, visibility, status) values
        (v_company,    'TEST Company Handbook',   'test-company',    'company',    'indexed'),
        (v_restricted, 'TEST Restricted Salaries','test-restricted', 'restricted', 'indexed'),
        (v_pending,    'TEST Pending Draft',      'test-pending',    'company',    'pending');

    insert into public.document_chunks
        (document_id, chunk_index, content, embedding, embedding_model)
    select d.id, 0, 'TEST chunk of ' || d.title, v_q, 'gemini-embedding-2'
    from public.documents d
    where d.drive_file_id like 'test-%';

    ------------------------------------------------- ALICE (plain employee)
    perform set_config('request.jwt.claims',
        json_build_object('sub', v_alice::text, 'role', 'authenticated')::text, true);
    set local role authenticated;

    select count(*) into n from public.documents where drive_file_id like 'test-%';
    assert n = 1, format('T1: alice should see exactly 1 test document, saw %s', n);

    select count(*) into n from public.document_chunks where content like 'TEST chunk of%';
    assert n = 1, format('T2: alice should see exactly 1 test chunk, saw %s', n);

    select count(*), min(m.document_title) into n, t
    from public.match_document_chunks(v_q, 'gemini-embedding-2', 20, null, 0.0) m
    where m.drive_file_id like 'test-%';
    assert n = 1 and t = 'TEST Company Handbook',
        format('T3: alice search should return only the company handbook, got %s row(s): %s', n, t);

    -- T4: privilege escalation must be impossible
    begin
        update public.profiles set role = 'admin' where id = v_alice;
        raise exception 'T4 FAILED: alice was able to change her own role';
    exception when insufficient_privilege then
        null;  -- expected
    end;

    -- T5: she may still edit her own display name
    update public.profiles set full_name = 'Alice Test' where id = v_alice;
    assert found, 'T5: alice should be able to update her own full_name';

    -- T6: no direct writes to documents / chunks / permissions
    begin
        insert into public.documents (title, drive_file_id) values ('Forged', 'forged-1');
        raise exception 'T6a FAILED: alice inserted a document';
    exception when insufficient_privilege then
        null;
    end;
    begin
        insert into public.document_permissions (document_id, user_id) values (v_restricted, v_alice);
        raise exception 'T6b FAILED: alice granted herself access to a restricted document';
    exception when insufficient_privilege then
        null;
    end;

    -- T7: conversations are hers only
    insert into public.conversations (user_id, title) values (v_alice, 'Alice chat')
    returning id into v_conv;
    begin
        insert into public.conversations (user_id, title) values (v_bob, 'Forged chat');
        raise exception 'T7 FAILED: alice created a conversation owned by someone else';
    exception when insufficient_privilege then
        null;
    end;

    -- T8: browser users cannot write messages (prevents forged assistant answers/sources)
    begin
        insert into public.messages (conversation_id, role, content)
        values (v_conv, 'assistant', 'forged answer');
        raise exception 'T8 FAILED: alice inserted a message directly';
    exception when insufficient_privilege then
        null;
    end;

    ---------------------------------------- a server-side write (as postgres)
    reset role;
    insert into public.messages (conversation_id, role, content)
    values (v_conv, 'user', 'hello from the backend');

    set local role authenticated;
    select count(*) into n from public.messages where conversation_id = v_conv;
    assert n = 1, format('T10: alice should read her own message, saw %s', n);

    ----------------------------------------------------------- BOB (admin)
    reset role;
    perform set_config('request.jwt.claims',
        json_build_object('sub', v_bob::text, 'role', 'authenticated')::text, true);
    set local role authenticated;

    select count(*) into n from public.documents where drive_file_id like 'test-%';
    assert n = 3, format('T11: admin should see all 3 test documents, saw %s', n);

    select count(*) into n
    from public.match_document_chunks(v_q, 'gemini-embedding-2', 20, null, 0.0) m
    where m.drive_file_id like 'test-%';
    assert n = 2, format('T12: admin search should return 2 chunks (indexed only), got %s', n);

    select count(*) into n from public.messages where conversation_id = v_conv;
    assert n = 0, format('T13: admin must NOT read other users'' chats, saw %s', n);

    ------------------------------- ALICE again, after an explicit permission
    reset role;
    insert into public.document_permissions (document_id, user_id)
    values (v_restricted, v_alice);

    perform set_config('request.jwt.claims',
        json_build_object('sub', v_alice::text, 'role', 'authenticated')::text, true);
    set local role authenticated;

    select count(*) into n from public.documents where drive_file_id like 'test-%';
    assert n = 2, format('T14: after being granted access alice should see 2 test documents, saw %s', n);

    select count(*) into n
    from public.match_document_chunks(v_q, 'gemini-embedding-2', 20, null, 0.0) m
    where m.drive_file_id like 'test-%';
    assert n = 2, format('T15: after being granted access alice search should return 2, got %s', n);

    --------------------------------------------------- ANON (not signed in)
    reset role;
    perform set_config('request.jwt.claims', '', true);
    set local role anon;

    begin
        perform count(*) from public.documents;
        raise exception 'T16a FAILED: anon could query documents';
    exception when insufficient_privilege then
        null;
    end;
    begin
        perform count(*) from public.match_document_chunks(v_q, 'gemini-embedding-2', 20, null, 0.0);
        raise exception 'T16b FAILED: anon could call match_document_chunks';
    exception when insufficient_privilege then
        null;
    end;

    ------------------------------------- SERVICE ROLE must FAIL CLOSED here
    reset role;
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    set local role service_role;

    select count(*) into n from public.documents where drive_file_id like 'test-%';
    assert n = 3, format('T17: service role should see all 3 documents directly, saw %s', n);

    select count(*) into n
    from public.match_document_chunks(v_q, 'gemini-embedding-2', 20, null, 0.0) m
    where m.drive_file_id like 'test-%';
    assert n = 0,
        format('T18 FAILED: match_document_chunks returned %s chunk(s) with no user session (must fail closed)', n);

    reset role;
    raise exception 'ALL RLS TESTS PASSED. This message is the deliberate rollback signal - nothing was saved.';
end
$test$;
