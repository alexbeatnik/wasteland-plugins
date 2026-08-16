/**
 * Reading what a file says about itself.
 *
 * Written out rather than taken from `music-metadata`, because a plugin is a
 * directory the app imports by path and has no `node_modules` of its own. That
 * sounds like a reason to do without tags, and it was — until a real library
 * turned out to be 740 files flat in one folder, named `009 - Elderly Woman
 * Behind the Counter in a Small Town.mp3`. With no folders there is no artist
 * anywhere except inside the files, so "make a playlist of Pearl Jam" found the
 * one file that happened to carry the band in its name and stopped.
 *
 * The scope is deliberately narrow: the four fields a listener searches by, out
 * of ID3v2 and Vorbis comments, which between them cover MP3, FLAC, Ogg Vorbis
 * and Opus — every format here that keeps its metadata in the open. Anything
 * else reads as nothing and the caller falls back to the file name — which is
 * what it did before tags existed here, so an unsupported format loses nothing.
 */
import { open } from 'node:fs/promises';

/**
 * How far into a file to look for tags.
 *
 * ID3v2 declares its own length and is read exactly; this bounds the *search*
 * for a FLAC or Ogg comment block, neither of which makes that promise. 256 KB
 * is past any reasonable comment block and short of reading artwork off 740
 * files.
 */
const MAX_TAG_BYTES = 256 * 1024;

/**
 * The terminator inside a text frame.
 *
 * Built rather than written, because both spellings of it in source are a trap:
 * a literal NUL is invisible to whoever edits the file next, and an escape is
 * something a formatter may helpfully turn back into a literal.
 */
const NUL = String.fromCharCode(0);

/** ID3v2 sizes are stored seven bits to the byte, so a size cannot look like a frame sync. */
function syncsafe(buffer, offset) {
  return (
    ((buffer[offset] & 0x7f) << 21) |
    ((buffer[offset + 1] & 0x7f) << 14) |
    ((buffer[offset + 2] & 0x7f) << 7) |
    (buffer[offset + 3] & 0x7f)
  );
}

/**
 * One ID3 text frame.
 *
 * The first byte names the encoding, and all four possibilities turn up in the
 * wild: a 2003 ripper writes Latin-1, iTunes writes UTF-16 with a BOM, and
 * anything modern writes UTF-8. Guessing wrong does not fail — it produces
 * Cyrillic as mojibake, or a string with a NUL between every letter.
 */
function decodeText(body) {
  if (body.length < 1) return '';
  const encoding = body[0];
  const bytes = body.subarray(1);

  let text;
  if (encoding === 0) {
    text = bytes.toString('latin1');
  } else if (encoding === 1) {
    // "UTF-16 with a byte order mark" is both endiannesses, and taggers differ.
    // Reading a big-endian string as little-endian yields CJK where a band name
    // should be, which is not a failure anything downstream would notice.
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      text = Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
    } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = bytes.subarray(2).toString('utf16le');
    } else {
      text = bytes.toString('utf16le');
    }
  } else if (encoding === 2) {
    // Big-endian without a mark. `swap16` needs its own copy: it works in
    // place, and the buffer here is a view into the caller's tag.
    text = Buffer.from(bytes).swap16().toString('utf16le');
  } else {
    text = bytes.toString('utf8');
  }

  // Text frames are NUL-terminated, and v2.4 allows several values separated by
  // NUL. The first is the one to show. Written as an escape rather than as a
  // literal, because a raw NUL in a source file is invisible to whoever edits
  // it next.
  return text.split(NUL)[0].trim();
}

/**
 * Parse an ID3v2 tag out of the head of a file.
 *
 * Handles v2.2 (three-character frame ids, three-byte sizes) as well as v2.3
 * and v2.4, because old rips are exactly the files with no folder structure to
 * fall back on. Returns `{}` for anything it cannot read: a tag that is broken
 * in a way not worth guessing about is no worse than no tag at all.
 */
export function parseId3(buffer) {
  if (buffer.length < 10 || buffer.toString('latin1', 0, 3) !== 'ID3') return {};

  const major = buffer[3];
  const flags = buffer[5];
  const size = syncsafe(buffer, 6);
  let offset = 10;
  const end = Math.min(10 + size, buffer.length);

  // An extended header sits between the header and the frames and declares its
  // own length; skipping it wrong turns every frame id into noise.
  if (flags & 0x40) {
    if (major >= 4) offset += syncsafe(buffer, offset);
    else offset += 4 + buffer.readUInt32BE(offset);
  }

  const short = major === 2;
  const idLength = short ? 3 : 4;
  const headerLength = short ? 6 : 10;
  const wanted = short
    ? { TT2: 'title', TP1: 'artist', TAL: 'album', TRK: 'track' }
    : { TIT2: 'title', TPE1: 'artist', TPE2: 'albumArtist', TALB: 'album', TRCK: 'track' };

  const found = {};
  while (offset + headerLength <= end) {
    const id = buffer.toString('latin1', offset, offset + idLength);
    // Padding is zero bytes, and it is how a tag normally ends.
    if (!/^[A-Z0-9]+$/.test(id)) break;

    const frameSize = short
      ? (buffer[offset + 3] << 16) | (buffer[offset + 4] << 8) | buffer[offset + 5]
      : major >= 4
        ? syncsafe(buffer, offset + 4)
        : buffer.readUInt32BE(offset + 4);

    const bodyAt = offset + headerLength;
    if (frameSize <= 0 || bodyAt + frameSize > end) break;

    const field = wanted[id];
    if (field) found[field] = decodeText(buffer.subarray(bodyAt, bodyAt + frameSize));
    offset = bodyAt + frameSize;
  }
  return found;
}

/** `5`, `5/12` and `05` all mean the fifth track. */
export function trackNumber(value) {
  const first = String(value ?? '').split('/')[0];
  const parsed = Number.parseInt(first, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Vorbis comments — `ARTIST=…` lines, as FLAC and Ogg store them.
 *
 * `buffer` is the comment block's payload: a vendor string, a count, then that
 * many length-prefixed `KEY=value` strings, all little-endian.
 */
export function parseVorbisComment(buffer) {
  if (buffer.length < 8) return {};
  let offset = 0;
  const vendorLength = buffer.readUInt32LE(offset);
  offset += 4 + vendorLength;
  if (offset + 4 > buffer.length) return {};

  const count = buffer.readUInt32LE(offset);
  offset += 4;

  const keys = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', TRACKNUMBER: 'track', ALBUMARTIST: 'albumArtist' };
  const found = {};
  for (let i = 0; i < count && offset + 4 <= buffer.length; i += 1) {
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    if (offset + length > buffer.length) break;
    const entry = buffer.toString('utf8', offset, offset + length);
    offset += length;

    const split = entry.indexOf('=');
    if (split <= 0) continue;
    const field = keys[entry.slice(0, split).toUpperCase()];
    if (field && !found[field]) found[field] = entry.slice(split + 1).trim();
  }
  return found;
}

/**
 * The comment payload inside a header packet, or `null` if it is not one.
 *
 * Vorbis marks its headers with a type byte and the codec name after it; Opus
 * uses a bare magic string and no type byte at all. Past the wrapper the two
 * are the same list.
 *
 * Ogg FLAC — which `.oga` is occasionally — is not among them. Its comment
 * packet is a raw FLAC metadata block, and the only thing to recognise it by is
 * a leading byte of 4, which is a byte any audio packet may start with. Reading
 * it would mean inventing an artist out of compressed audio now and again, and
 * that is worse than the file name it falls back to.
 */
function commentsIn(packet) {
  if (packet.length > 7 && packet[0] === 3 && packet.toString('latin1', 1, 7) === 'vorbis') {
    return parseVorbisComment(packet.subarray(7));
  }
  if (packet.length > 8 && packet.toString('latin1', 0, 8) === 'OpusTags') {
    return parseVorbisComment(packet.subarray(8));
  }
  return null;
}

/**
 * Vorbis comments out of an Ogg stream — `.ogg`, `.oga` and `.opus`.
 *
 * The comments are the second packet of the stream, and the reason this is more
 * than four lines is that a packet is not a page. Ogg cuts packets into
 * 255-byte segments and spills them over page boundaries, so a comment block
 * with any length to it — and one naming an album artist already has — arrives
 * in pieces that have to be stitched back together before a single field can be
 * read. Parsing page by page instead finds the first half of a vendor string
 * and nothing else.
 *
 * A run of segments ends its packet at the first one shorter than 255 bytes,
 * which is why a packet whose length is a whole multiple of 255 is terminated
 * by a segment of zero.
 */
export function parseOgg(buffer) {
  if (buffer.length < 27 || buffer.toString('latin1', 0, 4) !== 'OggS') return {};

  let offset = 0;
  /** Segments of a packet that ran off the end of the page before this one. */
  let carried = [];

  while (offset + 27 <= buffer.length && buffer.toString('latin1', offset, offset + 4) === 'OggS') {
    const segments = buffer[offset + 26];
    const table = offset + 27;
    const body = table + segments;
    if (body > buffer.length) break;

    let pageBytes = 0;
    for (let i = 0; i < segments; i += 1) pageBytes += buffer[table + i];

    let start = body;
    let run = 0;
    for (let i = 0; i < segments; i += 1) {
      const lacing = buffer[table + i];
      run += lacing;
      if (lacing === 255) continue;
      // Only the head of the file was read, so the last page in it is usually
      // cut in half. A packet running past that end is one nothing can finish.
      if (start + run > buffer.length) return {};

      carried.push(buffer.subarray(start, start + run));
      const comments = commentsIn(carried.length === 1 ? carried[0] : Buffer.concat(carried));
      if (comments) return comments;

      carried = [];
      start += run;
      run = 0;
    }

    // Still open at the end of the page: the rest of it is on the next one.
    if (run > 0) {
      if (start + run > buffer.length) return {};
      carried.push(buffer.subarray(start, start + run));
    }
    // A page carrying nothing still advances by its own 27-byte header, or this
    // would not terminate.
    offset = body + pageBytes;
  }
  return {};
}

/** Find the Vorbis comment block inside a FLAC header and parse it. */
export function parseFlac(buffer) {
  if (buffer.length < 8 || buffer.toString('latin1', 0, 4) !== 'fLaC') return {};
  let offset = 4;

  while (offset + 4 <= buffer.length) {
    const header = buffer[offset];
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
    const bodyAt = offset + 4;

    if (type === 4) {
      if (bodyAt + length > buffer.length) return {};
      return parseVorbisComment(buffer.subarray(bodyAt, bodyAt + length));
    }
    if (last) break;
    offset = bodyAt + length;
  }
  return {};
}

/**
 * What one file says about itself, or `{}`.
 *
 * Reads the head of the file only. For ID3 that is exact — the tag declares its
 * own length — and for FLAC and Ogg it is bounded, because a comment block does
 * not.
 * Never throws: a locked file, a truncated download or a format nobody here
 * knows is a track with no tags, not a failed scan.
 */
export async function readTags(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const head = Buffer.alloc(10);
    const { bytesRead } = await handle.read(head, 0, 10, 0);
    if (bytesRead < 10) return {};

    if (head.toString('latin1', 0, 3) === 'ID3') {
      // Read exactly the tag: its size is in the header, and reading more off
      // 740 files is time spent on audio nobody is going to parse.
      const size = syncsafe(head, 6);
      const buffer = Buffer.alloc(Math.min(10 + size, MAX_TAG_BYTES));
      await handle.read(buffer, 0, buffer.length, 0);
      return parseId3(buffer);
    }

    if (head.toString('latin1', 0, 4) === 'fLaC') {
      const buffer = Buffer.alloc(MAX_TAG_BYTES);
      const read = await handle.read(buffer, 0, MAX_TAG_BYTES, 0);
      return parseFlac(buffer.subarray(0, read.bytesRead));
    }

    if (head.toString('latin1', 0, 4) === 'OggS') {
      const buffer = Buffer.alloc(MAX_TAG_BYTES);
      const read = await handle.read(buffer, 0, MAX_TAG_BYTES, 0);
      return parseOgg(buffer.subarray(0, read.bytesRead));
    }

    // MP4 and its relatives keep their metadata in atoms this does not walk.
    // The file name is still there, and it is what every track had before.
    return {};
  } catch {
    return {};
  } finally {
    await handle?.close().catch(() => {});
  }
}
