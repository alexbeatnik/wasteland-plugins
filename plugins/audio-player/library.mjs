/**
 * Finding the music.
 *
 * Carried over from A-Player's library scan, minus the tag reader: a plugin is
 * a directory the app imports by path, with no `node_modules` of its own, so
 * `music-metadata` is not available to it. Titles therefore come from file
 * names — which is what that reader falls back to anyway when a file has no
 * tags — and the folder above a file stands in for the album.
 *
 * Nothing here touches the app. It is plain Node, so it can be reasoned about
 * and tested on its own.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export const AUDIO_EXTENSIONS = new Set(['mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'm4b', 'aac', 'wav', 'webm', 'weba']);

/** A library larger than this is a mistake, not a collection. */
export const MAX_TRACKS = 5000;

export function isAudioFile(path) {
  return AUDIO_EXTENSIONS.has(extname(path).slice(1).toLowerCase());
}

/**
 * Collect audio files under a folder.
 *
 * Directories that cannot be read are skipped: one protected folder must not
 * break the whole scan. Symlinks and Windows junctions are followed, because
 * `readdir` reports them as neither file nor directory and a library assembled
 * out of links to another drive would otherwise scan as empty — and each
 * directory is visited at most once, by resolved path, because links can point
 * back up the tree.
 */
export async function scanFolder(folder, { maxDepth = 12, limit = MAX_TRACKS } = {}) {
  const found = [];
  const visited = new Set();

  const identify = async (dir) => {
    try {
      return await realpath(dir);
    } catch {
      return dir;
    }
  };

  const walk = async (dir, depth) => {
    if (depth > maxDepth || found.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();

      if (!isDirectory && !isFile && entry.isSymbolicLink()) {
        try {
          // stat follows the link, unlike the Dirent flags.
          const target = await stat(full);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // dangling link — nothing behind it
        }
      }

      if (isDirectory) {
        const identity = await identify(full);
        if (visited.has(identity)) continue;
        visited.add(identity);
        await walk(full, depth + 1);
      } else if (isFile && isAudioFile(full)) {
        found.push(full);
      }
    }
  };

  visited.add(await identify(folder));
  await walk(folder, 0);
  // Numeric collation, so `track 2` comes before `track 10`.
  found.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return found;
}

/**
 * Drop the track number a ripper put in front of the file name.
 *
 * Carefully, because a song can begin with digits: "99 Luftballons" and "1979"
 * are titles, not numbering. Two things are taken as numbering and nothing else
 * is — digits followed by a real separator (`01. `, `12 - `, `03_`), or a
 * *zero-padded* number followed by a space, since a ripper pads and a title does
 * not. "99 Luftballons" therefore survives and "01 Pink Moon" does not.
 */
export function stripTrackNumber(name) {
  const stripped = name.replace(/^(?:\d{1,3}\s*[.\-_]\s*|0\d{1,2}\s+)/, '');
  // Never strip a name down to nothing: a file actually called `01.mp3` is
  // better shown as "01" than as an empty row.
  return stripped.trim() || name;
}

/**
 * What a path can tell us without opening the file.
 *
 * The folders above a track are the only place an artist is written when there
 * are no tags, and leaving them unread is why "Elderly woman pearl jam" found
 * the live recording and not the album one: the live file happened to carry the
 * band in its name and the album file did not, while both sat under a folder
 * called Pearl Jam. Segments are counted from the library root, so
 * `root/Artist/Album/track.mp3` reads as it looks and `root/track.mp3` claims
 * neither.
 */
export function trackFor(path, root = '') {
  const title = stripTrackNumber(basename(path, extname(path)));
  let album = '';
  let artist = '';

  if (root) {
    const parts = path.slice(root.length).split(/[\\/]+/).filter(Boolean);
    // The last part is the file itself.
    if (parts.length >= 2) album = parts[parts.length - 2];
    if (parts.length >= 3) artist = parts[parts.length - 3];
    // Two levels down, the one folder there is far more likely to be the artist
    // than an album: people keep `Artist/song.mp3`, rarely `Album/song.mp3`
    // with no artist above it.
    if (parts.length === 2) {
      artist = album;
      album = '';
    }
  } else {
    album = basename(dirname(path));
  }

  return { path, title, album, artist };
}

/**
 * The words a query is really made of.
 *
 * A user — or a model repeating one — pastes a file name, and a file name
 * carries things that appear nowhere in a title: an extension, a track number,
 * punctuation. `009 - Elderly Woman Behind the Counter in a Small Town.mp3`
 * found nothing at all, because the search demanded every word and neither
 * `009` nor `mp3` is in any title.
 */
export function queryTokens(query) {
  return stripTrackNumber(String(query ?? '').replace(/\.(mp3|flac|ogg|oga|opus|m4a|m4b|aac|wav|webm|weba)$/i, ''))
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Tracks matching a query, best first.
 *
 * Ranked rather than filtered. The first version required *every* word to
 * appear and returned nothing when one did not — so a pasted file name, an
 * extra "live", or a misremembered word cost the whole result. What survives of
 * that strictness is a floor: most of the words have to land somewhere, or
 * "pearl jam" would return the entire library on the strength of "a".
 *
 * Where a word lands is what ranks it. A title is what somebody naming a song
 * means; an artist folder is how they name a band; an album is the weakest of
 * the three and still worth having.
 */
export function search(tracks, query) {
  const words = queryTokens(query);
  if (words.length === 0) return tracks;

  // One word must land; beyond that, most of them must, so a long query cannot
  // match on a single common word.
  const needed = Math.max(1, Math.ceil(words.length * 0.6));

  const scored = [];
  for (const track of tracks) {
    const title = track.title.toLowerCase();
    const artist = (track.artist ?? '').toLowerCase();
    const album = (track.album ?? '').toLowerCase();

    let hits = 0;
    let score = 0;
    for (const word of words) {
      if (title.includes(word)) {
        hits += 1;
        score += 3;
      } else if (artist.includes(word)) {
        hits += 1;
        score += 2;
      } else if (album.includes(word)) {
        hits += 1;
        score += 1;
      }
    }
    if (hits < needed) continue;

    // Everything asked for, and nothing else in the title: as close to "this
    // exact song" as a file name can get.
    if (title === words.join(' ')) score += 10;
    else if (hits === words.length) score += 4;
    // A shorter title carrying the same words is the more precise match — it is
    // what separates the album cut from the twelve-minute live medley.
    score -= Math.min(3, Math.floor(title.length / 40));

    scored.push({ track, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title, 'en', { numeric: true }))
    .map((item) => item.track);
}
