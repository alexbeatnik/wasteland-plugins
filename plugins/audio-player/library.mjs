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

/** What a path can tell us without opening the file. */
export function trackFor(path) {
  return {
    path,
    title: stripTrackNumber(basename(path, extname(path))),
    album: basename(dirname(path)),
  };
}

/**
 * Tracks matching a query, best first.
 *
 * Every word has to appear somewhere in the track's own text, so "pink moon"
 * finds a file called `Pink Moon.flac` in a folder called anything. A title hit
 * outranks a folder hit, because a user naming a song means the song.
 */
export function search(tracks, query) {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return tracks;

  const scored = [];
  for (const track of tracks) {
    const title = track.title.toLowerCase();
    const album = track.album.toLowerCase();
    const haystack = `${title} ${album}`;
    if (!words.every((word) => haystack.includes(word))) continue;
    // An exact title beats a title that merely contains the words, which beats
    // a match that only happened in the folder name.
    const score = title === words.join(' ') ? 3 : words.every((word) => title.includes(word)) ? 2 : 1;
    scored.push({ track, score });
  }

  return scored.sort((a, b) => b.score - a.score).map((item) => item.track);
}
