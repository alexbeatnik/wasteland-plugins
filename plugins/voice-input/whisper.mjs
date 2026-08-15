/**
 * Getting whisper.cpp onto the machine, and getting words out of it.
 *
 * Everything here is about files and subprocesses; `main.mjs` is about the
 * plugin. Kept apart because the interesting parts — which model is which, how
 * a partial download resumes, which of three archive tools on a Windows box can
 * actually read a zip — are decidable without the app anywhere near them, and
 * so are testable.
 *
 * The approach is lifted from OS-Manul, which has been running it for a while:
 * a `whisper-cli` subprocess fed a 16 kHz mono WAV, with the transcript read
 * back off disk. It keeps this plugin free of native modules — there is no
 * binding to build, nothing to match against Electron's ABI, and a plugin that
 * needed one could not be installed from a zip at all.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * The three models offered, and nothing else.
 *
 * `large` here is the q5-quantised v3 turbo, which is both better and less than
 * half the size of `medium` — worth knowing before anyone spends twenty minutes
 * downloading the wrong one. The labels say so, because a list of three names
 * with no sizes is a list nobody can choose from.
 */
export const MODELS = [
  { value: 'small', file: 'ggml-small.bin', label: 'small — fastest (≈466 MB)', approxMB: 466 },
  { value: 'medium', file: 'ggml-medium.bin', label: 'medium — slower, accurate (≈1.5 GB)', approxMB: 1530 },
  {
    value: 'large',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    label: 'large v3 turbo — best, and smaller than medium (≈547 MB)',
    approxMB: 547,
  },
];

const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

/**
 * A pinned whisper.cpp release for Windows.
 *
 * Pinned rather than resolved from the API, unlike the app's llama.cpp
 * provisioning, because this is fetched once and never again — and a pin goes
 * stale in a way that is at least loud: the download 404s and says so. When
 * bumping it, check that `whisper-cli` still takes `-nt -otxt -of`.
 */
const WINDOWS_RELEASE = {
  tag: 'v1.9.1',
  asset: 'whisper-bin-x64.zip',
  get url() {
    return `https://github.com/ggml-org/whisper.cpp/releases/download/${this.tag}/${this.asset}`;
  },
};

export function modelFor(value) {
  return MODELS.find((model) => model.value === value) ?? null;
}

/** Where a model file lands, given the plugin's own data directory. */
export function modelPath(dataDir, value) {
  const model = modelFor(value);
  return model ? join(dataDir, 'models', model.file) : '';
}

export function binaryDir(dataDir) {
  return join(dataDir, 'whisper');
}

/** The executable name this platform spawns. */
export function binaryName() {
  return process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download to `target`, resuming a partial file if one is there.
 *
 * A model is between half a gigabyte and one and a half, which is long enough
 * for a connection to drop — and starting a 1.5 GB download again from zero
 * because of one dropped connection is how a feature gets abandoned. The
 * partial is kept as `.part` and a `Range` request continues it; a server that
 * ignores the range answers 200, and then starting over is correct, because
 * appending a whole body to a partial file corrupts it silently.
 */
export async function download(url, target, { onProgress, signal } = {}) {
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.part`;

  let already = 0;
  try {
    already = (await stat(partial)).size;
  } catch {
    /* nothing to resume */
  }

  const response = await fetch(url, {
    signal,
    headers: already > 0 ? { Range: `bytes=${already}-` } : {},
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`the download failed with ${response.status}`);
  }
  if (!response.body) throw new Error('the download was empty');

  // A 206 *and* bytes on disk: a server volunteering 206 with nothing to resume
  // would otherwise open the writer in append mode over an empty file.
  const resumed = response.status === 206 && already > 0;
  const total = Number(response.headers.get('content-length') || 0) + (resumed ? already : 0);

  let received = resumed ? already : 0;
  let announced = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      // Four times a second. Chunks land hundreds of times a second, and every
      // one of them is an IPC message and a re-render for a figure nobody can
      // read as it flickers.
      const now = Date.now();
      if (now - announced > 250) {
        announced = now;
        onProgress?.({ received, total });
      }
      controller.enqueue(chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body.pipeThrough(counter)),
    createWriteStream(partial, { flags: resumed ? 'a' : 'w' }),
  );
  onProgress?.({ received, total });

  // Renamed only once the whole body is on disk: a `.part` is resumable, a
  // truncated model file is a whisper-cli that fails minutes later for reasons
  // that have nothing to do with the microphone.
  await rename(partial, target);
  return target;
}

/** Fetch one of the three models unless it is already there. */
export async function ensureModel(dataDir, value, { onProgress, signal } = {}) {
  const model = modelFor(value);
  if (!model) throw new Error(`"${value}" is not one of the models this offers`);

  const target = modelPath(dataDir, value);
  if (await exists(target)) return target;

  await download(`${MODEL_BASE}${model.file}`, target, { onProgress, signal });
  return target;
}

/**
 * Unpack a zip, on a machine that may have three different tools for it.
 *
 * The same lesson the app learned about llama.cpp, relearned here because a
 * plugin cannot import the app's copy: `tar` on PATH is usually *GNU* tar on a
 * machine with Git installed, and GNU tar cannot read a zip at all. Windows
 * ships bsdtar in System32, which can — so that path is named explicitly first,
 * then PATH, then PowerShell.
 */
async function extractZip(archive, into) {
  await mkdir(into, { recursive: true });

  const system32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
  const attempts = [
    { command: system32, args: ['-xf', archive, '-C', into] },
    { command: 'tar', args: ['-xf', archive, '-C', into] },
    {
      command: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Never build a PowerShell command by interpolating a path unquoted: a
        // home directory like `C:\Users\O'Connor` closes the string early and
        // the unpack fails on the user's own name.
        `Expand-Archive -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(into)} -Force`,
      ],
    },
  ];

  let last = '';
  for (const attempt of attempts) {
    try {
      await run(attempt.command, attempt.args, {});
      return into;
    } catch (err) {
      last = err.message;
    }
  }
  throw new Error(`the archive could not be unpacked — ${last}`);
}

/** Single-quoted for PowerShell, apostrophes doubled. */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Spawn something and wait for it, keeping the output for the error message. */
function run(command, args, { cwd, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, signal, windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on('error', (err) => reject(new Error(err.code === 'ENOENT' ? `${command} is not there` : err.message)));
    // `close`, not `exit`: exit fires when the process is gone, which can be
    // before its pipes have drained, so concluding there can read an empty tail
    // for a process that explained itself on the way out.
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.trim().split('\n').pop() || `${basename(command)} exited (${code})`));
    });
  });
}

/** Find a file by name anywhere under a directory. */
async function findUnder(root, name) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findUnder(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return '';
}

/**
 * The `whisper-cli` to spawn: the one the user named, one already downloaded,
 * or one fetched now.
 *
 * Only Windows is fetched automatically, which is the platform this app ships
 * an installer for. Everywhere else whisper.cpp comes from a package manager and
 * the answer is a sentence saying so, not a download that would have to guess at
 * a distribution's libc.
 */
export async function ensureBinary(dataDir, { configured = '', onProgress, signal } = {}) {
  const named = String(configured ?? '').trim();
  if (named) {
    if (!(await exists(named))) throw new Error(`there is no whisper-cli at ${named}`);
    return named;
  }

  const dir = binaryDir(dataDir);
  const already = await findUnder(dir, binaryName());
  if (already) return already;

  if (process.platform !== 'win32') {
    throw new Error(
      'install whisper.cpp (the `whisper-cli` command) with your package manager, then give its path in the setting above',
    );
  }

  onProgress?.({ text: `fetching whisper.cpp ${WINDOWS_RELEASE.tag}`, received: 0, total: 0 });
  const archive = join(dir, WINDOWS_RELEASE.asset);
  await download(WINDOWS_RELEASE.url, archive, {
    onProgress: (progress) => onProgress?.({ text: `fetching whisper.cpp ${WINDOWS_RELEASE.tag}`, ...progress }),
    signal,
  });

  try {
    await extractZip(archive, dir);
  } finally {
    await rm(archive, { force: true }).catch(() => {});
  }

  const found = await findUnder(dir, binaryName());
  if (!found) throw new Error(`${WINDOWS_RELEASE.asset} did not contain ${binaryName()}`);
  return found;
}

/**
 * Transcribe one WAV.
 *
 * whisper-cli writes the transcript to a file rather than to stdout, so `-of`
 * names it and it is deleted here. The app deletes the WAV it handed us and
 * knows nothing about a `.txt` beside it — a recording of somebody's voice and
 * its transcript are both theirs, and neither is ours to leave lying about.
 *
 * The binary's own directory goes on `PATH` and becomes the working directory:
 * the Windows build ships its shared libraries beside the executable, and
 * spawned from anywhere else it fails to load them.
 */
export async function transcribe({ binary, model, wav, language = 'auto', threads = 0, signal }) {
  if (!binary) throw new Error('there is no whisper-cli to run');
  if (!model) throw new Error('no speech model has been chosen');
  if (!(await exists(model))) throw new Error('the speech model is missing — choose it again to fetch it');

  const base = wav.replace(/\.wav$/i, '');
  const transcript = `${base}.txt`;
  const dir = dirname(binary);

  const args = ['-m', model, '-f', wav, '-nt', '-otxt', '-of', base];
  if (language && language !== 'auto') args.push('-l', language);
  else args.push('-l', 'auto');
  if (threads > 0) args.push('-t', String(threads));

  try {
    await run(binary, args, {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
      signal,
    });
    return cleanTranscript(await readFile(transcript, 'utf8'));
  } finally {
    await rm(transcript, { force: true }).catch(() => {});
  }
}

/**
 * What whisper.cpp prints, as a line of text.
 *
 * It marks silence and non-speech with bracketed tags — `[BLANK_AUDIO]`,
 * `(wind blowing)` — which are a description of the recording rather than
 * something the user said, and pasting them into the composer as if they were
 * dictation is worse than pasting nothing. Line breaks go too: whisper splits
 * on its own segment boundaries, which have nothing to do with sentences.
 */
export function cleanTranscript(raw) {
  return String(raw ?? '')
    .replace(/\[[^\]\n]*\]/g, ' ')
    .replace(/\((?:BLANK_AUDIO|blank audio|silence|music|applause|laughter)[^)\n]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
