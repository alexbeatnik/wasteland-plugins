/**
 * Pack every plugin and write the index the app reads.
 *
 * One archive per plugin, named with its version, and one `index.json` naming
 * where each archive is and what its bytes hash to. The app refuses to install
 * anything without a matching checksum, so this script is the only thing that
 * makes a plugin installable — an archive uploaded by hand, with no index entry
 * regenerated, is invisible.
 *
 * Usage: node scripts/build-index.mjs --base-url https://.../download/plugins
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pluginsRoot = join(root, 'plugins');
const distRoot = join(root, 'dist');

const baseUrl = (process.argv.find((arg) => arg.startsWith('--base-url='))?.split('=').slice(1).join('=') ?? '').replace(/\/$/, '');
if (!baseUrl) {
  console.error('--base-url is required, e.g. --base-url=https://github.com/OWNER/REPO/releases/download/plugins');
  process.exit(1);
}

const MIME_BY_EXTENSION = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' };

/**
 * The icon, inlined.
 *
 * A data URI rather than a link: the app's window allows `img-src data:` and no
 * remote host at all, so an icon that lived on a server would both fail to draw
 * and turn opening the plugin list into a request telling somebody who did it.
 */
function iconDataUri(dir, file) {
  if (!file) return '';
  const path = join(dir, file);
  if (!existsSync(path)) return '';
  const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) return '';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Make a zip, with whatever this machine has.
 *
 * `zip(1)` is not present on a stock Windows box, and this script previously
 * assumed it — which made the index unbuildable on the machine the plugins are
 * written on. The same problem `extractors()` in the app solves from the other
 * end, and the same answer: name the System32 path explicitly rather than
 * trusting `tar` on PATH. Windows ships bsdtar there, which writes zip; a
 * machine with Git installed usually resolves a bare `tar` to Git's GNU tar
 * first, and GNU tar cannot write zip at all.
 */
function makeZip(dir, archive) {
  rmSync(archive, { force: true });

  const bsdtar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
  const attempts = [
    process.platform === 'win32' && existsSync(bsdtar)
      ? { file: bsdtar, args: ['-a', '-c', '-f', archive, '-C', dir, '.'] }
      : null,
    { file: 'zip', args: ['-qr', archive, '.', '-x', '.*'], cwd: dir },
    // PowerShell's own, for a Windows box with neither. `-Path dir\*` packs the
    // contents rather than the directory, which is what puts `plugin.json` at
    // the root of the archive where the app looks for it. Never interpolated
    // straight in: a checkout under a path with an apostrophe in it would close
    // the string early and pack the wrong thing, or nothing.
    process.platform === 'win32'
      ? {
          file: 'powershell',
          args: [
            '-NoProfile',
            '-Command',
            `Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${archive.replace(/'/g, "''")}' -Force`,
          ],
        }
      : null,
  ].filter(Boolean);

  const failures = [];
  for (const attempt of attempts) {
    try {
      execFileSync(attempt.file, attempt.args, { cwd: attempt.cwd, stdio: ['ignore', 'inherit', 'pipe'] });
      if (existsSync(archive)) return attempt.file;
    } catch (err) {
      failures.push(`${attempt.file}: ${err.message.split('\n')[0]}`);
    }
  }
  throw new Error(`nothing here can write a zip —\n  ${failures.join('\n  ')}`);
}

rmSync(distRoot, { recursive: true, force: true });
mkdirSync(distRoot, { recursive: true });

const entries = [];

for (const name of readdirSync(pluginsRoot).sort()) {
  const dir = join(pluginsRoot, name);
  if (!statSync(dir).isDirectory()) continue;

  const manifestPath = join(dir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    console.error(`skipping ${name}: no plugin.json`);
    continue;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.id !== name) {
    // The app refuses this at install time too, and finding out here is cheaper
    // than finding out on somebody's machine.
    console.error(`${name}: the manifest calls itself "${manifest.id}"`);
    process.exit(1);
  }

  const archiveName = `${manifest.id}-${manifest.version}.zip`;
  const archive = join(distRoot, archiveName);

  // Zipped from inside the plugin directory, so `plugin.json` sits at the root
  // of the archive rather than under a folder named after it. The app tolerates
  // one wrapper directory, but only because hand-made archives have one.
  const packer = makeZip(dir, archive);

  entries.push({
    id: manifest.id,
    name: manifest.name ?? manifest.id,
    version: manifest.version ?? '0.0.0',
    description: manifest.description ?? '',
    author: manifest.author ?? '',
    apiVersion: manifest.apiVersion ?? 1,
    /**
     * The heading it is listed under before it is installed.
     *
     * Copied out of the manifest into the index because the manifest is inside
     * an archive nobody has downloaded, and the whole point of a heading is to
     * help somebody decide whether to download it. Left out, the app files it
     * under "other" — which is not an error anywhere and simply looks like the
     * sections do not work.
     */
    category: manifest.category ?? '',
    // What the user is agreeing to run. A theme pack has no entry point, so it
    // is data the app reads itself and needs no approval; anything with `main`
    // is code.
    kind: manifest.main ? 'code' : 'theme',
    icon: iconDataUri(dir, manifest.icon),
    url: `${baseUrl}/${archiveName}`,
    sha256: sha256(archive),
    size: statSync(archive).size,
  });

  console.log(`packed ${archiveName} — ${statSync(archive).size} bytes, with ${packer}`);
}

writeFileSync(
  join(root, 'index.json'),
  `${JSON.stringify({ schema: 1, updated: new Date().toISOString().slice(0, 10), plugins: entries }, null, 2)}\n`,
  'utf8',
);

console.log(`index.json written with ${entries.length} plugin(s)`);
