/**
 * Take the superseded archives off the rolling release.
 *
 * One release tagged `plugins` holds every archive ever published, and nothing
 * removed them — seven versions of one plugin, of which the app can install
 * exactly one, because `index.json` on main names a single URL per plugin and
 * refuses anything whose bytes hash differently. The rest is a wall of dead
 * files that grows by one row per push.
 *
 * What is deleted is decided from `index.json` rather than from the release:
 * that file is the only statement of what is installable, so "not named there"
 * is the definition of superseded. An archive belonging to a plugin the index
 * no longer lists is left alone and reported — a plugin that was renamed or
 * withdrawn is a decision somebody made deliberately, and this script is not
 * the place to act on it.
 *
 * Usage: node scripts/prune-release.mjs [--tag=plugins] [--keep=1] [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `audio-player-1.4.0.zip` split back up, or null for anything else. */
export function parseArchiveName(name) {
  const match = /^(.+)-(\d+(?:\.\d+)*)\.zip$/.exec(name);
  if (!match) return null;
  return { id: match[1], version: match[2] };
}

/**
 * Newest first.
 *
 * Field by field as numbers, because `localeCompare` puts 1.10.0 before 1.9.0
 * and a version that sorts wrong here is an archive deleted while it is the
 * current one.
 */
export function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    const difference = (right[at] ?? 0) - (left[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * What to delete, what to keep, and what this has no opinion about.
 *
 * Only versions *older* than the one the index names are ever deleted, and
 * `keep` says how many of those to spare, newest first. Older rather than
 * "not the newest" because between the upload and the index commit the release
 * holds an archive newer than anything the index mentions, and a re-run in that
 * window must leave it exactly where it is. It also means a release that
 * somehow lacks the current archive loses nothing: there is no version older
 * than one that is not there.
 */
export function plan({ assets, plugins, keep = 1 }) {
  const current = new Map(plugins.map((plugin) => [plugin.id, plugin.version]));
  const byPlugin = new Map();
  const ignored = [];

  for (const name of assets) {
    const parsed = parseArchiveName(name);
    // Source archives, notes, anything uploaded by hand: not ours to judge.
    if (!parsed || !current.has(parsed.id)) {
      ignored.push(name);
      continue;
    }
    if (!byPlugin.has(parsed.id)) byPlugin.set(parsed.id, []);
    byPlugin.get(parsed.id).push(parsed);
  }

  const kept = [];
  const remove = [];
  for (const [id, versions] of byPlugin) {
    versions.sort((a, b) => compareVersions(a.version, b.version));
    const published = current.get(id);
    const superseded = versions.filter((item) => compareVersions(item.version, published) > 0);
    // `keep` counts the current one, so it is the spare copies that are short
    // of it — and at 1 there are none.
    const spared = new Set(superseded.slice(0, Math.max(0, keep - 1)).map((item) => item.version));
    for (const item of versions) {
      const name = `${item.id}-${item.version}.zip`;
      const older = compareVersions(item.version, published) > 0;
      (older && !spared.has(item.version) ? remove : kept).push(name);
    }
  }

  return { remove, keep: kept, ignored };
}

/** Everything below is the part that talks to GitHub. */

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function flag(name, fallback) {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
}

function main() {
  const tag = flag('tag', process.env.RELEASE_TAG || 'plugins');
  const keep = Math.max(1, Number(flag('keep', process.env.KEEP_VERSIONS || '1')) || 1);
  const dryRun = process.argv.includes('--dry-run');

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { plugins } = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));

  let assets;
  try {
    assets = JSON.parse(gh(['release', 'view', tag, '--json', 'assets'])).assets.map((asset) => asset.name);
  } catch (err) {
    // No release yet is the first run, not a failure.
    console.log(`no release "${tag}" to prune — ${String(err.message).split('\n')[0]}`);
    return;
  }

  const { remove, keep: kept, ignored } = plan({ assets, plugins, keep });

  console.log(`keeping ${kept.length}: ${kept.join(', ') || 'nothing'}`);
  if (ignored.length > 0) console.log(`leaving alone ${ignored.length}: ${ignored.join(', ')}`);
  if (remove.length === 0) {
    console.log('nothing superseded');
    return;
  }

  const failed = [];
  for (const name of remove) {
    if (dryRun) {
      console.log(`would delete ${name}`);
      continue;
    }
    try {
      gh(['release', 'delete-asset', tag, name, '--yes']);
      console.log(`deleted ${name}`);
    } catch (err) {
      failed.push(name);
      console.log(`::warning::could not delete ${name} — ${String(err.message).split('\n')[0]}`);
    }
  }

  // A leftover file is clutter, not a broken publish, and the archives and the
  // index both went out before this ran. Say so loudly and end green.
  if (failed.length > 0) console.log(`::warning::${failed.length} archive(s) left in place`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
