// Sends an authenticated GET and returns the (successful) Response.
// Retries once with a fresh token if Google says the token went stale.
async function driveRequest(path, params = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getAccessToken();
    let res;
    try {
      res = await fetch(`${DRIVE_API}${path}?${new URLSearchParams(params)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new DriveError('Could not reach Google Drive (network or timeout)');
    }
    if (res.status === 401 && attempt === 0) {
      tokenCache = null; // token went stale; fetch a new one and retry once
      continue;
    }
    if (!res.ok) throw await driveError(res);
    return res;
  }
  throw new DriveError('Google Drive rejected the access token');
}

async function driveGet(path, params = {}) {
  const res = await driveRequest(path, params);
  return res.json();
}

function assertFileId(fileId) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(String(fileId))) {
    throw new DriveError('Invalid Drive file ID', 400);
  }
}

function tooLargeError(maxBytes) {
  const megabytes = Math.round(maxBytes / (1024 * 1024));
  return new DriveError(`The file is larger than the ${megabytes} MB import limit`, 413);
}

// Reads a response body, refusing anything bigger than maxBytes.
async function readBytes(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLargeError(maxBytes);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw tooLargeError(maxBytes);
  return bytes;
}

// Downloads a normal file (PDF, DOCX, text). Not for Google Docs: use
// exportGoogleDocAsDocx for those.
export async function downloadFileBytes(fileId, maxBytes) {
  assertFileId(fileId);
  const res = await driveRequest(`/files/${fileId}`, { alt: 'media', supportsAllDrives: 'true' });
  return readBytes(res, maxBytes);
}

// Exports a Google Doc as a Word file so headings and tables survive.
export async function exportGoogleDocAsDocx(fileId, maxBytes) {
  assertFileId(fileId);
  const res = await driveRequest(`/files/${fileId}/export`, {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  return readBytes(res, maxBytes);
}

// Lists the files inside a folder (and its sub-folders, up to maxDepth levels).
export async function listFolderFiles(rootFolderId, { maxDepth = 3, maxFiles = 500 } = {}) {
  const rootId = normalizeFolderId(rootFolderId);
  const files = [];
  let truncated = false;
  const queue = [{ id: rootId, depth: 0, path: '' }];

  while (queue.length > 0 && !truncated) {
    const { id, depth, path } = queue.shift();
    let pageToken;
    do {
      const data = await driveGet('/files', {
        q: `'${id}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, md5Checksum, webViewLink)',
        pageSize: '100',
        orderBy: 'name',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        ...(pageToken ? { pageToken } : {}),
      });

      for (const file of data.files ?? []) {
        if (file.mimeType === FOLDER_MIME) {
          if (depth < maxDepth) queue.push({ id: file.id, depth: depth + 1, path: `${path}${file.name}/` });
          continue;
        }
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        const { kind, supported } = classifyMimeType(file.mimeType);
        files.push({
          id: file.id,
          name: file.name,
          path: `${path}${file.name}`,
          mimeType: file.mimeType,
          kind,
          supported,
          modifiedTime: file.modifiedTime ?? null,
          size: file.size ? Number(file.size) : null,
          md5Checksum: file.md5Checksum ?? null,
          webViewLink: file.webViewLink ?? null,
        });
      }
      pageToken = truncated ? undefined : data.nextPageToken;
    } while (pageToken);
  }
  return { files, truncated };
}