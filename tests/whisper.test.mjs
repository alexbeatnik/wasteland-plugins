/**
 * The parts of voice input that do not need a microphone.
 *
 * Nothing here spawns whisper.cpp or downloads a gigabyte: what is worth
 * testing is the catalogue the picker is built from, the paths a model lands
 * at, and the transcript cleaning — which is the one piece that silently
 * changes what the user appears to have said.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { MODELS, binaryName, cleanTranscript, modelFor, modelPath, psQuote } from '../plugins/voice-input/whisper.mjs';

test('the three models offered are the three the manifest lists', async () => {
  // The picker is drawn from the manifest and the download from this list, so
  // the two drifting apart is a choice that resolves to nothing.
  const manifest = JSON.parse(
    await import('node:fs/promises').then((fs) => fs.readFile(new URL('../plugins/voice-input/plugin.json', import.meta.url), 'utf8')),
  );
  const declared = manifest.settings.find((setting) => setting.key === 'model').options.map((option) => option.value);
  assert.deepEqual(declared, MODELS.map((model) => model.value));
  assert.deepEqual(declared, ['small', 'medium', 'large']);
});

test('a model resolves to a file, and anything else to nothing', () => {
  assert.equal(modelFor('small').file, 'ggml-small.bin');
  // `large` is the q5 v3 turbo, which is both better and less than half the
  // size of medium — the label has to say so or nobody would pick it.
  assert.match(modelFor('large').file, /large-v3-turbo/);
  assert.ok(modelFor('large').approxMB < modelFor('medium').approxMB);
  assert.equal(modelFor('enormous'), null);
  assert.equal(modelPath('/data', 'enormous'), '');
  assert.equal(modelPath('/data', 'small'), join('/data', 'models', 'ggml-small.bin'));
});

test('the executable is named for the platform it will be spawned on', () => {
  assert.equal(binaryName(), process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
});

test('what whisper marks as not-speech does not reach the composer', () => {
  // Bracketed tags are a description of the recording rather than something the
  // user said, and pasting them in as dictation is worse than pasting nothing.
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript('  [_TT_170] hello there  '), 'hello there');
  assert.equal(cleanTranscript('(wind blowing) open the browser'), '(wind blowing) open the browser');
  assert.equal(cleanTranscript('(BLANK_AUDIO) open the browser'), 'open the browser');

  // whisper splits on its own segment boundaries, which have nothing to do with
  // sentences — so a dictated paragraph must not arrive as five short lines.
  assert.equal(cleanTranscript('one line\nand another\n'), 'one line and another');
  assert.equal(cleanTranscript(''), '');
  assert.equal(cleanTranscript(null), '');
});

test('a path with an apostrophe in it survives PowerShell', () => {
  // A home directory like C:\Users\O'Connor closes the string early and the
  // unpack fails on the user's own name.
  assert.equal(psQuote("C:\\Users\\O'Connor\\x.zip"), "'C:\\Users\\O''Connor\\x.zip'");
  assert.equal(psQuote('C:\\plain'), "'C:\\plain'");
});
