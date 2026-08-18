/**
 * What the release prune decides to delete.
 *
 * The whole risk of this script is in one direction: an archive the index still
 * points at, deleted, is a plugin nobody can install and bytes nobody has a
 * copy of. So the cases below are mostly about what must survive — the current
 * version, a version that sorts oddly, and anything this has no business
 * touching at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, parseArchiveName, plan } from '../scripts/prune-release.mjs';

const plugins = [
  { id: 'audio-player', version: '1.4.0' },
  { id: 'voice-input', version: '1.1.1' },
];

test('an archive name splits back into a plugin and a version', () => {
  assert.deepEqual(parseArchiveName('audio-player-1.4.0.zip'), { id: 'audio-player', version: '1.4.0' });
  // A hyphen in the id is the ordinary case, so the version is taken from the end.
  assert.deepEqual(parseArchiveName('phosphor-themes-1.0.1.zip'), { id: 'phosphor-themes', version: '1.0.1' });
});

test('anything that is not a versioned archive parses as nothing', () => {
  assert.equal(parseArchiveName('Source code (zip)'), null);
  assert.equal(parseArchiveName('index.json'), null);
  assert.equal(parseArchiveName('audio-player.zip'), null);
  assert.equal(parseArchiveName('audio-player-1.4.0.zip.sig'), null);
});

test('versions sort by number, not by letter', () => {
  const order = ['1.9.0', '1.10.0', '1.4.0', '2.0.0'].sort(compareVersions);
  assert.deepEqual(order, ['2.0.0', '1.10.0', '1.9.0', '1.4.0']);
});

test('everything but the current version goes', () => {
  const assets = [
    'audio-player-1.0.0.zip',
    'audio-player-1.3.1.zip',
    'audio-player-1.4.0.zip',
    'voice-input-1.0.0.zip',
    'voice-input-1.1.1.zip',
  ];
  const { remove, keep } = plan({ assets, plugins });
  assert.deepEqual(keep.sort(), ['audio-player-1.4.0.zip', 'voice-input-1.1.1.zip']);
  assert.deepEqual(remove.sort(), ['audio-player-1.0.0.zip', 'audio-player-1.3.1.zip', 'voice-input-1.0.0.zip']);
});

test('the version the index names survives even when a newer one is present', () => {
  // The window between the upload and the index commit looks exactly like this,
  // and a re-run inside it must not delete what the app is still being told to
  // fetch.
  const assets = ['audio-player-1.3.1.zip', 'audio-player-1.4.0.zip'];
  const { remove, keep } = plan({ assets, plugins: [{ id: 'audio-player', version: '1.3.1' }] });
  assert.deepEqual(keep.sort(), ['audio-player-1.3.1.zip', 'audio-player-1.4.0.zip']);
  assert.deepEqual(remove, []);
});

test('keeping more than one keeps the newest ones', () => {
  const assets = ['audio-player-1.0.0.zip', 'audio-player-1.3.1.zip', 'audio-player-1.4.0.zip'];
  const { remove, keep } = plan({ assets, plugins, keep: 2 });
  assert.deepEqual(keep.sort(), ['audio-player-1.3.1.zip', 'audio-player-1.4.0.zip']);
  assert.deepEqual(remove, ['audio-player-1.0.0.zip']);
});

test('a plugin the index no longer lists is left alone, not tidied away', () => {
  const assets = ['audio-player-1.4.0.zip', 'withdrawn-1.0.0.zip', 'withdrawn-1.1.0.zip'];
  const { remove, ignored } = plan({ assets, plugins });
  assert.deepEqual(remove, []);
  assert.deepEqual(ignored.sort(), ['withdrawn-1.0.0.zip', 'withdrawn-1.1.0.zip']);
});

test('assets that are not plugin archives are never deleted', () => {
  const assets = ['Source code (zip)', 'checksums.txt', 'audio-player-1.0.0.zip'];
  const { remove, ignored } = plan({ assets, plugins });
  assert.deepEqual(remove, ['audio-player-1.0.0.zip']);
  assert.deepEqual(ignored.sort(), ['Source code (zip)', 'checksums.txt']);
});

test('a release holding only current archives has nothing to do', () => {
  const { remove } = plan({ assets: ['audio-player-1.4.0.zip', 'voice-input-1.1.1.zip'], plugins });
  assert.deepEqual(remove, []);
});

test('an empty release is not an error', () => {
  assert.deepEqual(plan({ assets: [], plugins }), { remove: [], keep: [], ignored: [] });
});
