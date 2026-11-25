// Download -> parse -> chunk for one Drive file. Writes nothing to the
// database (Milestone 3c adds the sync that stores the results).
import { DriveError, downloadFileBytes, exportGoogleDocAsDocx } from './google-drive.js';
import { ParseError, parseDocument } from './document-parser.js';
import { chunkBlocks, getChunkSettings } from './chunker.js';

export function getMaxFileBytes() {
  const raw = process.env.MAX_FILE_SIZE_MB;
  if (raw === undefined || raw.trim() === '') return 15 * 1024 * 1024;
  const megabytes = Number.parseFloat(raw);
  if (!Number.isFinite(megabytes) || megabytes < 1 || megabytes > 50) {
    throw new DriveError('MAX_FILE_SIZE_MB must be a number between 1 and 50', 500);
  }
  return Math.round(megabytes * 1024 * 1024);
}

// file: one entry from listFolderFiles()
export async function extractAndChunk(file) {
  if (!file.supported) throw new ParseError(`Unsupported file type: ${file.mimeType}`);
  const settings = getChunkSettings();
  const maxBytes = getMaxFileBytes();
  if (file.size !== null && file.size > maxBytes) {
    throw new DriveError(`The file is larger than the ${Math.round(maxBytes / 1048576)} MB import limit`, 413);
  }

  let kind = file.kind;
  let bytes;
  if (file.kind === 'gdoc') {
    bytes = await exportGoogleDocAsDocx(file.id, maxBytes);
    kind = 'docx';
  } else {
    bytes = await downloadFileBytes(file.id, maxBytes);
  }

  const parsed = await parseDocument(kind, bytes);
  const chunks = chunkBlocks(parsed.blocks, {
    title: file.name,
    driveFileId: file.id,
    ...settings,
  });
  const characters = parsed.blocks.reduce((total, block) => total + block.text.length, 0);

  return { pageCount: parsed.pageCount, characters, chunks, settings };
}