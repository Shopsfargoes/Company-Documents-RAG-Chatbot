// Splits parsed blocks into overlapping chunks suitable for embedding.
//
// - Never merges text across a heading: each section starts a fresh chunk.
// - Prefers to break between paragraphs, then sentences, then words.
// - Overlap is made of whole sentences from the end of the previous chunk
//   (never carried across a heading).
// - Chunk size and overlap are configurable (characters, roughly 4 per token).

export class ChunkingError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ChunkingError';
    }
  }
  
  const MAX_CHUNKS_PER_DOCUMENT = 2000;
  
  function readIntEnv(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new ChunkingError(`${name} must be a whole number between ${min} and ${max}`);
    }
    return value;
  }
  
  export function getChunkSettings() {
    const targetChars = readIntEnv('CHUNK_SIZE_CHARS', 1200, 300, 8000);
    const overlapChars = readIntEnv('CHUNK_OVERLAP_CHARS', 200, 0, 4000);
    if (overlapChars > targetChars / 2) {
      throw new ChunkingError('CHUNK_OVERLAP_CHARS must be at most half of CHUNK_SIZE_CHARS');
    }
    return { targetChars, overlapChars };
  }
  
  function splitSentences(text) {
    return text
      .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
  }
  
  function hardSplit(text, max) {
    const pieces = [];
    let current = '';
    for (const word of text.split(' ')) {
      if (word.length > max) {
        if (current) {
          pieces.push(current);
          current = '';
        }
        for (let i = 0; i < word.length; i += max) pieces.push(word.slice(i, i + max));
      } else if (current && current.length + 1 + word.length > max) {
        pieces.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) pieces.push(current);
    return pieces;
  }
  
  function unitsFromBlock(text, max) {
    if (text.length <= max) return [text];
    return splitSentences(text).flatMap((sentence) =>
      sentence.length <= max ? [sentence] : hardSplit(sentence, max),
    );
  }
  
  function lengthOf(units) {
    return units.reduce((total, unit, index) => total + unit.text.length + (index ? 2 : 0), 0);
  }
  
  function assemble(units) {
    let out = '';
    units.forEach((unit, index) => {
      if (index === 0) out = unit.text;
      else out += (units[index - 1].blockId === unit.blockId ? ' ' : '\n\n') + unit.text;
    });
    return out.trim();
  }
  
  function carryOverlap(units, overlapChars) {
    const carried = [];
    let total = 0;
    for (let i = units.length - 1; i >= 0; i -= 1) {
      const length = units[i].text.length + 2;
      if (total + length > overlapChars) break;
      carried.unshift(units[i]);
      total += length;
    }
    return carried;
  }
  
  // blocks: [{ text, page, isHeading }]
  // returns [{ chunkIndex, content, tokenCount, metadata }]
  export function chunkBlocks(blocks, { title, driveFileId, targetChars, overlapChars }) {
    const raw = [];
    let buffer = [];
    let fresh = 0; // units in the buffer that are new (not carried-over overlap)
    let section = null;
    let blockCounter = 0;
  
    function emit() {
      if (fresh === 0 || buffer.length === 0) return;
      const content = assemble(buffer);
      if (!content) return;
      const pages = buffer.map((unit) => unit.page).filter((page) => page !== null);
      raw.push({
        content,
        section: buffer[buffer.length - 1].section,
        page: pages.length > 0 ? Math.min(...pages) : null,
        pageEnd: pages.length > 0 ? Math.max(...pages) : null,
      });
    }
  
    for (const block of blocks) {
      blockCounter += 1;
  
      if (block.isHeading) {
        // Close the current section unless it only holds earlier headings
        // (consecutive headings stay together with the text that follows).
        if (buffer.some((unit) => !unit.heading)) {
          emit();
          buffer = [];
          fresh = 0;
        }
        section = block.text;
        buffer.push({ text: block.text, page: block.page, section, blockId: blockCounter, heading: true });
        fresh += 1;
        continue;
      }
  
      for (const text of unitsFromBlock(block.text, targetChars)) {
        const unit = { text, page: block.page, section, blockId: blockCounter, heading: false };
        if (buffer.length > 0 && lengthOf([...buffer, unit]) > targetChars) {
          emit();
          buffer = carryOverlap(buffer, overlapChars);
          fresh = 0;
          if (lengthOf([...buffer, unit]) > targetChars) buffer = []; // overlap would not fit
        }
        buffer.push(unit);
        fresh += 1;
      }
    }
    emit();
  
    if (raw.length > MAX_CHUNKS_PER_DOCUMENT) {
      throw new ChunkingError(
        `This document would produce ${raw.length} chunks; the limit is ${MAX_CHUNKS_PER_DOCUMENT}`,
      );
    }
  
    return raw.map((chunk, index) => ({
      chunkIndex: index,
      content: chunk.content,
      tokenCount: Math.ceil(chunk.content.length / 4),
      metadata: {
        documentTitle: title,
        driveFileId,
        section: chunk.section,
        page: chunk.page,
        pageEnd: chunk.pageEnd,
      },
    }));
  }