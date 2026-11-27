// Google Drive access - BACKEND ONLY, read-only, no third-party dependencies.
//
// Two ways to authenticate (choose with GOOGLE_AUTH_MODE):
//   service_account  (default) a robot identity; share the Drive folder with
//                    its email address. Credentials never expire.
//   oauth            a normal Google login via a refresh token. Useful when a
//                    Workspace policy blocks service-account keys.
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const REQUEST_TIMEOUT_MS = 20_000;

// Messages in DriveError are written to be safe to show to an administrator
// (they never contain secrets).
export class DriveError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
  }
}

// ---- file types --------------------------------------------------------------
const SUPPORTED_TYPES = new Map([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.google-apps.document', 'gdoc'],
  ['text/plain', 'text'],
  ['text/markdown', 'text'],
]);

export function classifyMimeType(mimeType) {
  const kind = SUPPORTED_TYPES.get(mimeType);
  return kind ? { kind, supported: true } : { kind: 'unsupported', supported: false };
}

// ---- configuration -------------------------------------------------------------
function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DriveError(`Missing environment variable: ${name}`, 500);
  }
  return value.trim();
}

// Accepts a bare folder ID or a full folder URL
// (https://drive.google.com/drive/folders/<ID>?usp=sharing).
export function normalizeFolderId(value) {
  let id = String(value ?? '').trim();
  const fromUrl = /\/folders\/([A-Za-z0-9_-]+)/.exec(id);
  if (fromUrl) id = fromUrl[1];
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) {
    throw new DriveError('GOOGLE_DRIVE_FOLDER_ID is not a valid Drive folder ID or folder URL', 500);
  }
  return id;
}

export function getConfiguredFolderId() {
  return normalizeFolderId(requireEnv('GOOGLE_DRIVE_FOLDER_ID'));
}

export function getAuthMode() {
  const mode = (process.env.GOOGLE_AUTH_MODE || 'service_account').trim().toLowerCase();
  if (mode !== 'service_account' && mode !== 'oauth') {
    throw new DriveError("GOOGLE_AUTH_MODE must be 'service_account' or 'oauth'", 500);
  }
  return mode;
}

// ---- authentication --------------------------------------------------------------
function loadServiceAccount() {
  const raw = requireEnv('GOOGLE_SERVICE_ACCOUNT_JSON');
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new DriveError('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON - paste the whole key file', 500);
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new DriveError('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key', 500);
  }
  return credentials;
}

// Exported so it can be unit-tested without calling Google.
export function signServiceAccountAssertion(credentials, nowSeconds = Math.floor(Date.now() / 1000)) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const claims = encode({
    iss: credentials.client_email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
  const unsigned = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .end()
    .sign(credentials.private_key)
    .toString('base64url');
  return `${unsigned}.${signature}`;
}

let tokenCache = null; // { token, expiresAt }

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt - 60_000 > Date.now()) return tokenCache.token;

  let body;
  if (getAuthMode() === 'service_account') {
    let assertion;
    try {
      assertion = signServiceAccountAssertion(loadServiceAccount());
    } catch (err) {
      if (err instanceof DriveError) throw err;
      throw new DriveError('The service account private key could not be used - re-copy the key file', 500);
    }
    body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
  } else {
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN'),
    });
  }

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new DriveError('Could not reach Google to authenticate (network or timeout)');
  }
  if (!res.ok) {
    const info = await res.json().catch(() => null);
    const code = typeof info?.error === 'string' ? info.error : `HTTP ${res.status}`;
    console.error('Google token request failed:', code);
    throw new DriveError(`Google rejected the credentials (${code}). Check the Google environment variables.`, 502);
  }
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in) * 1000 };
  return tokenCache.token;
}

// ---- Drive REST calls ------------------------------------------------------------
async function driveError(res) {
  const info = await res.json().catch(() => null);
  const reason = info?.error?.errors?.[0]?.reason ?? info?.error?.status ?? '';
  const suffix = reason ? ` (${reason})` : '';
  if (res.status === 404) {
    return new DriveError(`Drive item not found, or it has not been shared with the Google account used by this app${suffix}`, 502);
  }
  if (res.status === 403) {
    return new DriveError(`Google denied access - the Drive API may be disabled, a quota may be exceeded, or access is missing${suffix}`, 502);
  }
  if (res.status === 429) {
    return new DriveError('Google is rate-limiting requests. Wait a minute and try again.', 429);
  }
  return new DriveError(`Google Drive returned HTTP ${res.status}${suffix}`, 502);
}

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
