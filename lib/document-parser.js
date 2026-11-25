// Turns downloaded file bytes into plain-text "blocks".
//
// A block is { text, page, isHeading }:
//   text       one paragraph (or heading) with whitespace normalised
//   page       page number where known (PDF), otherwise null
//   isHeading  true for headings, so the chunker can keep sections together
//
// Supported: DOCX (parsed here, no dependencies), plain text / Markdown,
// and PDF (uses the 'unpdf' package, loaded only when a PDF is parsed).
// Google Docs are exported to DOCX by the caller and then parsed as DOCX.
import { inflateRawSync } from 'node:zlib';

// Messages are written to be safe to show to an administrator.
export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // zip-bomb guard
const MAX_PDF_PAGES = 300;
const MIN_PDF_CHARS = 20;

function normalizeWhitespace(text) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v\r\n]+/g, ' ')
    .trim();
}

// ---- plain text / Markdown ---------------------------------------------------------
export function parseTextFile(bytes) {
  const text = new TextDecoder('utf-8')
    .decode(bytes)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  if (text.includes('\u0000')) {
    throw new ParseError('This file looks like binary data, not plain text');
  }

  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ text: normalizeWhitespace(paragraph.join(' ')), page: null, isHeading: false });
      paragraph = [];
    }
  };

  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ text: normalizeWhitespace(heading[1]), page: null, isHeading: true });
    } else if (line.trim() === '') {
      flush();
    } else if (/^\s*([-*\u2022]|\d+[.)])\s+/.test(line)) {
      flush(); // each list item starts a new paragraph
      paragraph.push(line.trim());
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();

  if (blocks.length === 0) throw new ParseError('The file contains no text');
  return { blocks, pageCount: null };
}

// ---- DOCX --------------------------------------------------------------------------
// A .docx file is a ZIP archive; the text lives in word/document.xml.
function readZipEntry(input, wantedName) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 22) throw new ParseError('This does not look like a valid .docx file');

  // Find the "end of central directory" record (scan backwards).
  const searchStart = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= searchStart; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ParseError('This does not look like a valid .docx file');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || entryCount === 0xffff) {
    throw new ParseError('This archive uses a ZIP64 layout, which is not supported');
  }

  for (let n = 0; n < entryCount; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new ParseError('The .docx file is corrupt');
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== wantedName) continue;

    if (uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
      throw new ParseError('The document is too large to process');
    }
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ParseError('The .docx file is corrupt');
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
    throw new ParseError('The .docx file uses an unsupported compression method');
  }
  return null;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return XML_ENTITIES[entity];
  });
}

const PARAGRAPH_PATTERN = /<w:p(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:p>)/g;
const ROW_OR_PARAGRAPH_PATTERN =
  /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>|<w:p(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:p>)/g;
const TEXT_TOKEN_PATTERN =
  /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br(?:\s[^>]*)?\/>|<w:cr\s*\/>/g;

function readParagraph(fragment) {
  const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(fragment)?.[1] ?? '';
  const isHeading = /^(heading\s*\d*|title|subtitle)$/i.test(style);
  const isListItem = !isHeading && /<w:numPr>/.test(fragment);

  let text = '';
  for (const token of fragment.matchAll(TEXT_TOKEN_PATTERN)) {
    text += token[1] !== undefined ? decodeXml(token[1]) : ' '; // tab / line break -> space
  }
  text = normalizeWhitespace(text);
  if (isListItem && text) text = `- ${text}`;
  return { text, isHeading };
}

export function parseDocx(bytes) {
  let xml;
  try {
    const entry = readZipEntry(bytes, 'word/document.xml');
    if (!entry) {
      throw new ParseError('This .docx file has no main document (is it a real Word file?)');
    }
    xml = entry.toString('utf8');
  } catch (err) {
    if (err instanceof ParseError) throw err;
    throw new ParseError('The .docx file is corrupt or is not a real Word document');
  }

  const blocks = [];
  for (const match of xml.matchAll(ROW_OR_PARAGRAPH_PATTERN)) {
    const fragment = match[0];
    if (fragment.startsWith('<w:tr')) {
      // A table row becomes one block: "cell | cell | cell".
      const cells = [...fragment.matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)]
        .map((cell) =>
          [...cell[0].matchAll(PARAGRAPH_PATTERN)]
            .map((paragraph) => readParagraph(paragraph[0]).text)
            .filter(Boolean)
            .join(' '),
        )
        .filter(Boolean);
      if (cells.length > 0) blocks.push({ text: cells.join(' | '), page: null, isHeading: false });
    } else {
      const { text, isHeading } = readParagraph(fragment);
      if (text) blocks.push({ text, page: null, isHeading });
    }
  }

  if (blocks.length === 0) throw new ParseError('No text was found in this document');
  return { blocks, pageCount: null };
}

// ---- PDF -----------------------------------------------------------------------------
function cleanPdfText(text) {
  return normalizeWhitespace(text.replace(/-\n(?=[a-z])/g, '')); // re-join hyphenated words
}

export async function parsePdf(bytes) {
  let unpdf;
  try {
    unpdf = await import('unpdf');
  } catch {
    throw new ParseError('PDF support is not installed on the server (the "unpdf" package is missing)');
  }

  let pdf;
  try {
    pdf = await unpdf.getDocumentProxy(new Uint8Array(bytes));
  } catch {
    throw new ParseError('The PDF could not be read (it may be corrupt or password-protected)');
  }

  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new ParseError(`The PDF has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}`);
    }
    const { text } = await unpdf.extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [String(text)];

    const blocks = [];
    pages.forEach((pageText, index) => {
      const cleaned = cleanPdfText(pageText);
      if (cleaned) blocks.push({ text: cleaned, page: index + 1, isHeading: false });
    });
    const characters = blocks.reduce((total, block) => total + block.text.length, 0);
    if (characters < MIN_PDF_CHARS) {
      throw new ParseError(
        'No readable text was found. This PDF may be a scanned image (OCR is not supported yet).',
      );
    }
    return { blocks, pageCount: pages.length };
  } catch (err) {
    if (err instanceof ParseError) throw err;
    throw new ParseError('Text could not be extracted from this PDF');
  } finally {
    try {
      await pdf.destroy();
    } catch {
      // ignore cleanup problems
    }
  }
}

// ---- entry point ---------------------------------------------------------------------
// kind: 'pdf' | 'docx' | 'text'  (Google Docs arrive here as 'docx')
export async function parseDocument(kind, bytes) {
  switch (kind) {
    case 'docx':
      return parseDocx(bytes);
    case 'pdf':
      return parsePdf(bytes);
    case 'text':
      return parseTextFile(bytes);
    default:
      throw new ParseError(`Unsupported file type: ${kind}`);
  }
}