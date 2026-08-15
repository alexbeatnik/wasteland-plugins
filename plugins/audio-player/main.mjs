/**
 * The audio player.
 *
 * Everything that makes a music player is here: the library, the queue, what
 * "next" means, shuffle and repeat, and the two actions the model can use. The
 * app supplies only the part that cannot live in a plugin — an `<audio>`
 * element in a window that runs no plugin code, and the transport bar attached
 * to it — through the `audio` service this manifest asks for.
 *
 * The queue is deliberately not handed to the app. The bar shows one track and
 * a line of text the plugin writes, so "3 of 47" and "shuffled" are this file's
 * words. That keeps the app's audio service able to serve a second plugin that
 * has no queue at all.
 */
import { stat } from 'node:fs/promises';
import { scanFolder, search, trackFor } from './library.mjs';

/**
 * What the model is told.
 *
 * The first paragraph is not decoration. Asked to play a song, a model that
 * holds this action still answers "I can't directly play music, but I can
 * search YouTube for you" — it is describing a session it is not in, exactly as
 * one answered "I have no access to real-time information" while holding the
 * lookup action. The cure is the same one the app's lookup section already
 * uses: name the refusal it is about to produce and say plainly that it is
 * wrong here. Reaching for the browser instead is a live risk rather than a
 * theoretical one, because the browser section sitting beside this one carries
 * a worked example of playing a song on YouTube.
 */
const PROMPT = `
MUSIC — {"type":"play_music","steps":"<what to play>"}

You CAN play music in this session. It plays out of the user's own speakers,
from their own folder, through the player in the chat window. "I can't play
music", "I can't directly play audio" and "I can only search for it" are all
wrong here — this action is how you do it, and it costs one turn. Never offer
to look a song up on YouTube instead of playing it.

When the user asks for a song, reach for this FIRST, and do not ask permission
to search their library: searching is what the action does. "steps" is what
they asked for in their own words — a song, an album, an artist, a folder, or
empty to play everything. Never invent a file name or a path.

A title you do not recognise is still worth passing straight through. The
library is theirs, not yours, and you are told plainly when nothing matched —
that answer names some of what IS there, so offer one of those. Only when the
user then asks for something the library does not hold is the browser the right
tool.

{"type":"music_control","steps":"<command>"} controls what is already playing.
The commands are: pause, resume, next, previous, stop, shuffle on, shuffle off,
repeat all, repeat one, repeat off, what is playing.

You are told what is now playing. Say it in one short sentence, and do not list
the queue unless you are asked for it.`;

/** How many tracks to name when reporting back to the model. */
const NAMED_IN_FEEDBACK = 5;

export function activate(ctx) {
  const audio = ctx.service('audio');

  /** The whole library, rescanned when the folder setting changes. */
  let library = [];
  let scanned = '';
  let scanning = null;

  /** What is queued now, and where in it we are. */
  let queue = [];
  let index = -1;
  let shuffle = false;
  let repeat = 'all';

  const folder = () => String(ctx.store.get('library', '') || '').trim();

  /**
   * Load the library, once per folder.
   *
   * Concurrent callers share one scan: the model asking for music while the
   * first scan is still walking a network drive should wait for it, not start a
   * second one.
   */
  async function ensureLibrary() {
    const dir = folder();
    if (!dir) throw new Error('no music folder is set — choose one in the plugin list');
    if (dir === scanned && library.length > 0) return library;
    if (scanning) return scanning;

    scanning = (async () => {
      try {
        const info = await stat(dir);
        if (!info.isDirectory()) throw new Error(`${dir} is not a folder`);
      } catch (err) {
        throw new Error(`the music folder cannot be read — ${err.message}`);
      }
      const paths = await scanFolder(dir);
      library = paths.map(trackFor);
      scanned = dir;
      ctx.log(`${library.length} track(s) under ${dir}`);
      return library;
    })().finally(() => {
      scanning = null;
    });

    return scanning;
  }

  /** Hand the current track to the app, with the words the bar should show. */
  function cue({ play = true } = {}) {
    const track = queue[index];
    if (!track) return audio.clear();
    const position = `${index + 1} of ${queue.length}`;
    const flags = [shuffle ? 'shuffled' : '', repeat === 'one' ? 'repeat one' : ''].filter(Boolean).join(' · ');
    return audio.load(
      {
        path: track.path,
        label: track.title,
        sublabel: [track.album, position, flags].filter(Boolean).join(' · '),
      },
      { play },
    );
  }

  function step(delta) {
    if (queue.length === 0) return -1;
    if (shuffle && queue.length > 1) {
      // Never the track already playing: a shuffle that repeats the current
      // song reads as a broken button rather than as chance.
      let pick = index;
      while (pick === index) pick = Math.floor(Math.random() * queue.length);
      return pick;
    }
    const next = index + delta;
    if (next >= queue.length) return repeat === 'off' ? -1 : 0;
    if (next < 0) return queue.length - 1;
    return next;
  }

  function advance(delta) {
    const next = step(delta);
    if (next < 0) {
      queue = [];
      index = -1;
      return audio.clear();
    }
    index = next;
    return cue();
  }

  // The app asks this whenever a transport button is pressed or a track runs
  // out. `repeat: 'one'` is answered here so that what plays next is decided in
  // exactly one place.
  audio.setTransport({
    pluginId: ctx.id,
    buttons: ['previous', 'next', 'stop'],
    handle: (command) => {
      if (command === 'next') return advance(1);
      if (command === 'previous') return advance(-1);
      if (command === 'ended') return repeat === 'one' ? cue() : advance(1);
      if (command === 'stop') {
        queue = [];
        index = -1;
        return audio.clear();
      }
      return undefined;
    },
  });

  // A new folder invalidates everything already found. The queue is left alone:
  // stopping the music because a setting was edited would be rude.
  ctx.onSettingsChanged(() => {
    library = [];
    scanned = '';
  });

  ctx.prompt(PROMPT);

  ctx.action({
    type: 'play_music',
    run: async (steps, turn) => {
      turn.status('Finding music…');
      const tracks = await ensureLibrary();
      if (tracks.length === 0) {
        return {
          ok: false,
          summary: 'the library is empty',
          feedback: `[MUSIC] No audio files were found under ${folder()}. Tell the user, and suggest they check the folder in the plugin list.`,
        };
      }

      const wanted = String(steps ?? '').trim();
      const hits = search(tracks, wanted);
      if (hits.length === 0) {
        // Naming a few of what *is* there is worth more than "not found": the
        // model can offer an alternative instead of asking the same question
        // again.
        const sample = tracks.slice(0, NAMED_IN_FEEDBACK).map((track) => track.title).join(', ');
        return {
          ok: false,
          summary: `nothing matches "${wanted}"`,
          feedback: `[MUSIC] Nothing in the library matches "${wanted}". It holds ${tracks.length} track(s), including: ${sample}. Offer one of those, or ask what they meant.`,
        };
      }

      queue = hits;
      index = 0;
      cue();

      const named = hits.slice(0, NAMED_IN_FEEDBACK).map((track) => track.title).join(', ');
      return {
        ok: true,
        summary: `${hits[0].title} (+${hits.length - 1} queued)`,
        feedback: `[MUSIC] Now playing "${hits[0].title}"${hits[0].album ? ` from ${hits[0].album}` : ''}, with ${hits.length} track(s) queued: ${named}${hits.length > NAMED_IN_FEEDBACK ? ', …' : ''}. Say what is playing in one short sentence.`,
      };
    },
  });

  ctx.action({
    type: 'music_control',
    run: async (steps) => {
      const command = String(steps ?? '').trim().toLowerCase();
      const playing = () => (queue[index] ? `"${queue[index].title}"` : 'nothing');

      if (/^(pause|stop playing|hold)/.test(command)) {
        audio.pause();
        return { ok: true, summary: 'paused', feedback: `[MUSIC] Paused ${playing()}. Say so briefly.` };
      }
      if (/^(resume|play|continue|unpause)/.test(command)) {
        audio.play();
        return { ok: true, summary: 'resumed', feedback: `[MUSIC] Resumed ${playing()}. Say so briefly.` };
      }
      if (/^(next|skip)/.test(command)) {
        advance(1);
        return { ok: true, summary: `skipped to ${playing()}`, feedback: `[MUSIC] Skipped to ${playing()}. Say so briefly.` };
      }
      if (/^(previous|prev|back)/.test(command)) {
        advance(-1);
        return { ok: true, summary: `back to ${playing()}`, feedback: `[MUSIC] Went back to ${playing()}. Say so briefly.` };
      }
      if (/^stop/.test(command)) {
        queue = [];
        index = -1;
        audio.clear();
        return { ok: true, summary: 'stopped', feedback: '[MUSIC] Stopped, and the queue is empty. Say so briefly.' };
      }
      if (/^shuffle/.test(command)) {
        shuffle = !/off|no/.test(command);
        cue({ play: false });
        audio.play();
        return { ok: true, summary: `shuffle ${shuffle ? 'on' : 'off'}`, feedback: `[MUSIC] Shuffle is ${shuffle ? 'on' : 'off'}. Say so briefly.` };
      }
      if (/^repeat/.test(command)) {
        repeat = /one|single|track/.test(command) ? 'one' : /off|no/.test(command) ? 'off' : 'all';
        cue({ play: false });
        audio.play();
        return { ok: true, summary: `repeat ${repeat}`, feedback: `[MUSIC] Repeat is set to ${repeat}. Say so briefly.` };
      }
      if (/what|which|now playing|current/.test(command)) {
        const track = queue[index];
        if (!track) return { ok: true, summary: 'nothing playing', feedback: '[MUSIC] Nothing is playing. Say so.' };
        return {
          ok: true,
          summary: track.title,
          feedback: `[MUSIC] Playing "${track.title}"${track.album ? ` from ${track.album}` : ''}, ${index + 1} of ${queue.length}. Tell the user.`,
        };
      }

      return {
        ok: false,
        summary: `unknown command: ${command}`,
        feedback: `[MUSIC] "${command}" is not a command this player has. The commands are: pause, resume, next, previous, stop, shuffle on/off, repeat all/one/off, what is playing.`,
      };
    },
  });
}

/** Switched off: the app takes the bar down on its own, but say goodbye tidily. */
export function deactivate() {
  /* the host releases the transport, which clears the bar */
}
