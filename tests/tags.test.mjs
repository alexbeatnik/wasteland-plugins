/**
 * The tag readers, against buffers built here.
 *
 * Binary formats are where a bug is silent: a wrong offset does not throw, it
 * produces an artist with a NUL between every letter, and a library that
 * quietly cannot be searched. Every case below is one a real ripper actually
 * writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlac, parseId3, parseOgg, parseVorbisComment, readTags, trackNumber } from '../plugins/audio-player/tags.mjs';

const NUL = String.fromCharCode(0);

/** A Vorbis comment payload: a vendor string, a count, then length-prefixed entries. */
function vorbisComment(entries, vendor = 'probe') {
  const parts = [Buffer.alloc(4), Buffer.from(vendor, 'utf8'), Buffer.alloc(4)];
  parts[0].writeUInt32LE(Buffer.byteLength(vendor));
  parts[2].writeUInt32LE(entries.length);
  for (const entry of entries) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(Buffer.byteLength(entry));
    parts.push(length, Buffer.from(entry, 'utf8'));
  }
  return Buffer.concat(parts);
}

/** Ogg cuts a packet into 255-byte segments; a shorter one is what ends it. */
function lace(packet) {
  const segments = [];
  let at = 0;
  while (packet.length - at >= 255) {
    segments.push(packet.subarray(at, at + 255));
    at += 255;
  }
  segments.push(packet.subarray(at));
  return segments;
}

/** One Ogg page: the 27-byte header, a lacing table, then the segments themselves. */
function oggPage(segments) {
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'latin1');
  header[26] = segments.length;
  return Buffer.concat([header, Buffer.from(segments.map((segment) => segment.length)), ...segments]);
}

/** The first packet of a stream, which is not the one carrying comments. */
const OPUS_HEAD = Buffer.concat([Buffer.from('OpusHead', 'latin1'), Buffer.alloc(11)]);
const VORBIS_HEAD = Buffer.concat([Buffer.from([1]), Buffer.from('vorbis', 'latin1'), Buffer.alloc(23)]);

/** Sizes in an ID3 header are seven bits to the byte. */
function syncsafe(value) {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

/** One frame: id, size, flags, encoding byte, text. */
function frame(id, text, { major = 3, encoding = 3 } = {}) {
  const body = Buffer.concat([Buffer.from([encoding]), Buffer.from(text, encoding === 0 ? 'latin1' : 'utf8')]);
  const size = major >= 4 ? syncsafe(body.length) : (() => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(body.length);
    return buffer;
  })();
  return Buffer.concat([Buffer.from(id, 'latin1'), size, Buffer.from([0, 0]), body]);
}

function id3(frames, { major = 3, padding = 0 } = {}) {
  const body = Buffer.concat([...frames, Buffer.alloc(padding)]);
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([major, 0, 0]),
    syncsafe(body.length),
    body,
  ]);
}

test('an ID3v2.3 tag gives up the four fields that matter', () => {
  const tag = id3([
    frame('TIT2', 'Elderly Woman Behind the Counter in a Small Town'),
    frame('TPE1', 'Pearl Jam'),
    frame('TALB', 'Vs.'),
    frame('TRCK', '9/12'),
  ]);
  const tags = parseId3(tag);
  assert.equal(tags.title, 'Elderly Woman Behind the Counter in a Small Town');
  assert.equal(tags.artist, 'Pearl Jam');
  assert.equal(tags.album, 'Vs.');
  assert.equal(trackNumber(tags.track), 9);
});

test('v2.4 frame sizes are syncsafe and v2.3 sizes are not', () => {
  // Reading a v2.4 size as a plain integer overshoots and loses every frame
  // after the first — the tag looks half-empty rather than broken.
  const four = parseId3(id3([frame('TIT2', 'One', { major: 4 }), frame('TPE1', 'Two', { major: 4 })], { major: 4 }));
  assert.deepEqual([four.title, four.artist], ['One', 'Two']);

  const three = parseId3(id3([frame('TIT2', 'One'), frame('TPE1', 'Two')]));
  assert.deepEqual([three.title, three.artist], ['One', 'Two']);
});

test('v2.2 uses three-character ids and shorter headers', () => {
  // Old rips are exactly the files with no folder structure to fall back on.
  const body = Buffer.concat([Buffer.from([0]), Buffer.from('Rush', 'latin1')]);
  const short = Buffer.concat([
    Buffer.from('TP1', 'latin1'),
    Buffer.from([(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
  const tag = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([2, 0, 0]), syncsafe(short.length), short]);
  assert.equal(parseId3(tag).artist, 'Rush');
});

test('every text encoding a tagger writes is read as itself', () => {
  assert.equal(parseId3(id3([frame('TPE1', 'Motorhead', { encoding: 0 })])).artist, 'Motorhead');
  assert.equal(parseId3(id3([frame('TPE1', 'Океан Ельзи')])).artist, 'Океан Ельзи');

  // UTF-16 with a BOM, both ways round. Reading big-endian as little-endian
  // yields CJK where a band name should be, and nothing downstream notices.
  for (const [bom, encoding] of [[[0xff, 0xfe], 'utf16le'], [[0xfe, 0xff], 'be']]) {
    const text = 'Ukraine';
    const raw = encoding === 'utf16le'
      ? Buffer.from(text, 'utf16le')
      : Buffer.from(text, 'utf16le').swap16();
    const body = Buffer.concat([Buffer.from([1]), Buffer.from(bom), raw]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(body.length);
    const built = Buffer.concat([Buffer.from('TPE1', 'latin1'), size, Buffer.from([0, 0]), body]);
    const tag = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(built.length), built]);
    assert.equal(parseId3(tag).artist, text, `${encoding} BOM`);
  }
});

test('a NUL terminator ends the value rather than joining the next one', () => {
  // v2.4 allows several values in one frame, separated by NUL. Keeping them all
  // produces "Pearl JamPearl Jam" on screen.
  assert.equal(parseId3(id3([frame('TPE1', `Pearl Jam${NUL}Eddie Vedder`)])).artist, 'Pearl Jam');
});

test('padding ends the frame loop instead of being read as a frame', () => {
  // A tag normally ends in zeroes, and reading those as an id produces garbage
  // fields or an endless loop.
  const tags = parseId3(id3([frame('TIT2', 'Alive')], { padding: 64 }));
  assert.equal(tags.title, 'Alive');
  assert.equal(Object.keys(tags).length, 1);
});

test('nothing that is not a tag is mistaken for one', () => {
  assert.deepEqual(parseId3(Buffer.alloc(0)), {});
  assert.deepEqual(parseId3(Buffer.from('not a tag at all, really')), {});
  // A header promising more than the buffer holds must stop, not read past it.
  const truncated = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(9999)]);
  assert.deepEqual(parseId3(truncated), {});
});

test('Vorbis comments are read case-insensitively', () => {
  const tags = parseVorbisComment(vorbisComment(['ARTIST=Pearl Jam', 'title=Black', 'Album=Ten', 'TRACKNUMBER=5']));
  assert.equal(tags.artist, 'Pearl Jam');
  assert.equal(tags.title, 'Black');
  assert.equal(tags.album, 'Ten');
  assert.equal(trackNumber(tags.track), 5);
});

test('a FLAC comment block is found past the blocks before it', () => {
  const comment = (() => {
    const entry = 'ARTIST=Rush';
    const length = Buffer.alloc(4);
    length.writeUInt32LE(Buffer.byteLength(entry));
    const vendor = Buffer.alloc(4);
    const count = Buffer.alloc(4);
    count.writeUInt32LE(1);
    return Buffer.concat([vendor, count, length, Buffer.from(entry, 'utf8')]);
  })();

  const streaminfo = Buffer.alloc(34);
  const block = (type, payload, last) =>
    Buffer.concat([
      Buffer.from([(last ? 0x80 : 0) | type, (payload.length >> 16) & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff]),
      payload,
    ]);

  const file = Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    block(0, streaminfo, false),
    block(4, comment, true),
  ]);
  assert.equal(parseFlac(file).artist, 'Rush');
  assert.deepEqual(parseFlac(Buffer.from('OggS junk')), {});
});

test('Opus tags are found in the second packet of the stream', () => {
  const tags = Buffer.concat([
    Buffer.from('OpusTags', 'latin1'),
    vorbisComment(['ARTIST=Океан Ельзи', 'TITLE=Не питай', 'ALBUM=Модель']),
  ]);
  const file = Buffer.concat([oggPage(lace(OPUS_HEAD)), oggPage(lace(tags))]);

  const parsed = parseOgg(file);
  assert.equal(parsed.artist, 'Океан Ельзи');
  assert.equal(parsed.title, 'Не питай');
  assert.equal(parsed.album, 'Модель');
});

test('a comment packet is stitched back together across the pages it spans', () => {
  // This is the whole reason the Ogg reader is not four lines. A packet is cut
  // into 255-byte segments and spills onto the next page, and a comment block
  // carrying anything more than an artist is over that in the ordinary case.
  // Parsed page by page it yields half a vendor string and no fields at all.
  const comment = Buffer.concat([
    Buffer.from([3]),
    Buffer.from('vorbis', 'latin1'),
    vorbisComment(['ARTIST=Pearl Jam', 'ALBUM=Ten', 'TRACKNUMBER=5', `DESCRIPTION=${'x'.repeat(400)}`]),
  ]);

  const segments = lace(comment);
  assert.ok(segments.length > 1, 'the packet has to be long enough to span pages for this to test anything');

  const file = Buffer.concat([
    oggPage(lace(VORBIS_HEAD)),
    oggPage(segments.slice(0, 1)),
    oggPage(segments.slice(1)),
  ]);

  const parsed = parseOgg(file);
  assert.equal(parsed.artist, 'Pearl Jam');
  assert.equal(parsed.album, 'Ten');
  assert.equal(trackNumber(parsed.track), 5);
});

test('nothing that is not an Ogg stream is read as one', () => {
  assert.deepEqual(parseOgg(Buffer.alloc(0)), {});
  assert.deepEqual(parseOgg(Buffer.from('fLaC, and then a good deal more of it')), {});
  // A stream with no comment packet in the part that was read is untagged, not
  // an endless walk: the page loop has to advance even past a page carrying
  // nothing at all.
  assert.deepEqual(parseOgg(Buffer.concat([oggPage(lace(OPUS_HEAD)), oggPage([])])), {});

  // A page whose segments run past the end of the buffer must stop there. Only
  // the head of a file is ever read, so the last page in it is normally cut.
  const cut = oggPage(lace(Buffer.concat([Buffer.from('OpusTags', 'latin1'), vorbisComment(['ARTIST=Rush'])])));
  assert.deepEqual(parseOgg(cut.subarray(0, 30)), {});
});

test('an Ogg file on disk reaches the Ogg reader', async () => {
  // The dispatch in readTags is the half that was missing: parseOgg can be
  // faultless and every `.opus` in the library still scans as untagged if
  // nothing routes to it.
  const dir = await mkdtemp(join(tmpdir(), 'wasteland-tags-'));
  try {
    const path = join(dir, 'track.opus');
    const tags = Buffer.concat([Buffer.from('OpusTags', 'latin1'), vorbisComment(['ARTIST=Rush', 'TITLE=Limelight'])]);
    await writeFile(path, Buffer.concat([oggPage(lace(OPUS_HEAD)), oggPage(lace(tags))]));

    const found = await readTags(path);
    assert.equal(found.artist, 'Rush');
    assert.equal(found.title, 'Limelight');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a track number is a number however it was written', () => {
  assert.equal(trackNumber('9/12'), 9);
  assert.equal(trackNumber('05'), 5);
  assert.equal(trackNumber(''), null);
  assert.equal(trackNumber('A-side'), null);
  assert.equal(trackNumber(undefined), null);
});
