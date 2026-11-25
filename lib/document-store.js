// Database access for imported documents (backend only, service role).
// Error messages are written to be safe to show to an administrator.
import { getAdminClient } from './supabase.js';

export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreError';
  }
}

function fail(message, error) {
  console.error(message, error?.code ?? '', error?.message ?? '');
  throw new StoreError(message);
}

export async function getDefaultVisibility() {
  const { data, error } = await getAdminClient()
    .from('app_settings')
    .select('value')
    .eq('key', 'default_document_visibility')
    .maybeSingle();
  if (error) fail('Could not read the default visibility setting', error);
  return data?.value === 'company' ? 'company' : 'restricted';
}

export async function loadAllDocuments() {
  const { data, error } = await getAdminClient()
    .from('documents')
    .select('id, drive_file_id, title, status, content_hash, updated_at')
    .limit(5000);
  if (error) fail('Could not load the list of imported documents', error);
  return data;
}

// Returns { id } or null when another request created the same document first.
export async function insertDocument(fields) {
  const { data, error } = await getAdminClient().from('documents').insert(fields).select('id').single();
  if (error) {
    if (error.code === '23505') return null;
    fail('Could not create the document record', error);
  }
  return data;
}

export async function updateDocument(id, fields) {
  const { error } = await getAdminClient().from('documents').update(fields).eq('id', id);
  if (error) fail('Could not update the document record', error);
}

export async function replaceChunks(documentId, contentHash, chunks) {
  const payload = chunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    tokenCount: chunk.tokenCount,
    metadata: chunk.metadata,
  }));
  const { data, error } = await getAdminClient().rpc('replace_document_chunks', {
    p_document_id: documentId,
    p_content_hash: contentHash,
    p_chunks: payload,
  });
  if (error) {
    fail('Could not save the chunks (has database/004_ingestion_functions.sql been run?)', error);
  }
  return data;
}

export async function markFailed(id, contentHash, message) {
  await updateDocument(id, {
    status: 'failed',
    error_message: message,
    content_hash: contentHash,
    last_synced_at: new Date().toISOString(),
  });
}

export async function deleteDocuments(ids) {
  if (ids.length === 0) return;
  const { error } = await getAdminClient().from('documents').delete().in('id', ids);
  if (error) fail('Could not remove documents that are no longer in Drive', error);
}

export async function listDocumentsForAdmin() {
  const { data, error } = await getAdminClient()
    .from('documents')
    .select('id, title, status, visibility, error_message, updated_at, last_synced_at, web_view_link, document_chunks(count)')
    .order('title')
    .limit(1000);
  if (error) fail('Could not load the documents', error);
  return data.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    visibility: row.visibility,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at,
    webViewLink: row.web_view_link,
    chunkCount: row.document_chunks?.[0]?.count ?? 0,
  }));
}

// Returns true if a document was updated, false if the id does not exist.
export async function setDocumentVisibility(id, visibility) {
  const { data, error } = await getAdminClient()
    .from('documents')
    .update({ visibility })
    .eq('id', id)
    .select('id');
  if (error) fail('Could not change the document visibility', error);
  return data.length > 0;
}