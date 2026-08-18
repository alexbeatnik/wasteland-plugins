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
import { albumOrder, readTracks, scanFolder, search, shuffled } from './library.mjs';

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

When several tracks could be what they meant, you are told so and the user is
shown the list to pick from. Say that you found more than one and that they can
choose — do NOT pick for them, and do not read the list out: it is already on
their screen, with a button on each line.

PLAYLIST — {"type":"queue_music","steps":"<what to gather>"}

For "play everything by X", "make a playlist of Y", "put on some Z". It queues
every track that matches instead of asking which one, and starts playing.
A playlist gathered from more than one album is shuffled without being asked —
an album keeps the order it was sequenced in. So this is the whole call:

\`\`\`action
{"type":"queue_music","steps":"pearl jam"}
\`\`\`

Add " | in order" to the end of "steps" only when they ask for it in order,
or " | shuffle" to shuffle an album too.

Use play_music for one song and queue_music for a set of them. Asking which of
forty tracks was meant is the wrong question when somebody asked for all forty.

{"type":"music_control","steps":"<command>"} controls what is already playing.
The commands are: pause, resume, next, previous, stop, shuffle on, shuffle off,
repeat all, repeat one, repeat off, what is playing.

You are told what is now playing. Say it in one short sentence, and do not list
the queue unless you are asked for it.`;

/** How many tracks to name when reporting back to the model. */
const NAMED_IN_FEEDBACK = 5;
/**
 * How many near-matches to put on screen.
 *
 * A list long enough to scroll is not a choice, it is a second search. Beyond
 * this the user is better served by narrowing what they asked for.
 */
const MAX_CHOICES = 8;

export function activate(ctx) {
  const audio = ctx.service('audio');

  /** The whole library, rescanned when the folder setting changes. */
  let library = [];
  let scanned = '';
  let scanning = null;

  /** What is queued now, and where in it we are. */
  let queue = [];
  /**
   * The same tracks in the order they were gathered.
   *
   * Kept beside the playing order because shuffling is a permutation of the
   * queue rather than a dice roll at every track, and "shuffle off" has to
   * have somewhere to go back to.
   */
  let ordered = [];
  let index = -1;
  let shuffle = false;
  let repeat = 'all';
  /**
   * The last set of near-matches put in front of the user, and its identity.
   *
   * Kept so a click can be answered minutes later: the turn that offered them
   * finished long ago, and the button carries only a position in this list.
   *
   * The token is what makes an *old* list safe. A second search replaces this
   * one, and the buttons of the first are still on screen and still clickable —
   * with a bare index they would quietly pick from the newer list, playing
   * something the user never saw offered. The id carries the token, so a stale
   * click is refused in words instead.
   */
  let offered = { token: '', tracks: [] };
  let offerCount = 0;

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
      // Tags are read here, once per folder, rather than per search: it is the
      // difference between knowing who performed a track and guessing from its
      // file name, and on a library with no folder structure it is the only
      // difference there is.
      library = await readTracks(paths, dir);
      scanned = dir;
      const tagged = library.filter((track) => track.tagged).length;
      ctx.log(`${library.length} track(s) under ${dir}, ${tagged} with tags`);
      return library;
    })().finally(() => {
      scanning = null;
    });

    return scanning;
  }

  /** Put a set in the queue and start it, in order or drawn at random. */
  function queueUp(tracks, wantsShuffle = false) {
    shuffle = Boolean(wantsShuffle) && tracks.length > 1;
    ordered = tracks;
    queue = shuffle ? shuffled(tracks) : tracks;
    index = 0;
    cue();
    return queue[0];
  }

  /** Queue a set and start it, reporting what the model should say. */
  function start(tracks, what, wantsShuffle = false) {
    const first = queueUp(tracks, wantsShuffle);
    const named = queue.slice(0, NAMED_IN_FEEDBACK).map((track) => track.title).join(', ');
    return {
      ok: true,
      summary: `${first.title}${queue.length > 1 ? ` (+${queue.length - 1} queued${shuffle ? ', shuffled' : ''})` : ''}`,
      feedback:
        `[MUSIC] Now playing "${first.title}"${first.artist ? ` by ${first.artist}` : ''}` +
        `${queue.length > 1 ? `, with ${queue.length} track(s) queued${shuffle ? ' in a random order' : ''}: ${named}` : ''}. ` +
        `That is what "${what}" resolved to. Say what is playing in one short sentence.`,
    };
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
        // Artist first: with no tags it is the only place a band name appears,
        // and it is what tells two versions of the same song apart.
        sublabel: [track.artist, track.album, position, flags].filter(Boolean).join(' · '),
      },
      { play },
    );
  }

  function step(delta) {
    if (queue.length === 0) return -1;
    // Shuffling is done once, to the queue itself, which leaves this the only
    // place that says what "next" means — and means every track is heard once,
    // "previous" goes back to what actually just played, and "3 of 47" is true.
    const next = index + delta;
    if (next >= queue.length) return repeat === 'off' ? -1 : 0;
    if (next < 0) return queue.length - 1;
    return next;
  }

  function advance(delta) {
    const next = step(delta);
    if (next < 0) {
      queue = [];
      ordered = [];
      index = -1;
      return audio.clear();
    }
    // Coming round again on a shuffled queue is a fresh draw. Replaying one
    // permutation for ever is the cassette this was meant to be the end of.
    if (shuffle && delta > 0 && next === 0 && queue.length > 1) {
      const last = queue[index];
      queue = shuffled(queue);
      if (queue[0] === last) [queue[0], queue[queue.length - 1]] = [queue[queue.length - 1], queue[0]];
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
        ordered = [];
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

      // Asked for one song and finding several, the honest answer is to ask.
      // A model choosing between "Elderly Woman Behind the Counter in a Small
      // Town" and the live recording of it is guessing, and the user is the
      // only one who knows which they meant — so they get the list, with a
      // button on each line, and nothing starts playing until they press one.
      if (!wanted) {
        // Nothing asked for means everything: that is not an ambiguity. It is
        // shuffled, because a whole library played from the top is a filing
        // cabinet rather than a playlist.
        return start(hits, `everything — ${hits.length} track(s)`, true);
      }
      if (hits.length === 1) return start(hits, hits[0].title);

      offerCount += 1;
      offered = { token: `o${offerCount}`, tracks: hits.slice(0, MAX_CHOICES) };
      return {
        ok: true,
        summary: `${hits.length} possible match(es) for "${wanted}"`,
        choices: offered.tracks.map((track, position) => ({
          id: `${offered.token}:${position}`,
          label: track.title,
          note: [track.artist, track.album].filter(Boolean).join(' · '),
          title: track.path,
        })),
        feedback:
          `[MUSIC] ${hits.length} track(s) could be "${wanted}", so nothing is playing yet and the user has been ` +
          'shown the list with a button on each line. Tell them there is more than one and to pick — do not choose ' +
          'for them, and do not repeat the list, it is already on their screen.',
      };
    },

    /**
     * One of those buttons was pressed.
     *
     * The rest of the offered set is queued behind the chosen track rather than
     * discarded: somebody who wanted the second of five versions is quite
     * likely to want the third next.
     */
    choose: async (choiceId) => {
      const [token, rawPosition] = String(choiceId).split(':');
      if (token !== offered.token) throw new Error('that list is no longer the current one');

      const position = Number(rawPosition);
      const picked = offered.tracks[position];
      if (!picked) throw new Error('that list is no longer the current one');

      queueUp([picked, ...offered.tracks.filter((_, at) => at !== position)]);
      return { ok: true, summary: picked.title };
    },
  });

  ctx.action({
    type: 'queue_music',
    run: async (steps, turn) => {
      turn.status('Building a playlist…');
      const tracks = await ensureLibrary();

      // After a `|` rather than anywhere in the words: a band called Random
      // Order would otherwise be unplayable in order, and the model is told
      // exactly what to write.
      const [rawQuery = '', ...modifiers] = String(steps ?? '').split('|');
      const wanted = rawQuery.trim();
      const modifier = modifiers.join(' ');
      const askedShuffle = /shuffle|random/i.test(modifier);
      const askedOrder = /in ?order|ordered|alphabet|sequence/i.test(modifier);

      const hits = wanted ? search(tracks, wanted) : tracks;
      if (hits.length === 0) {
        return {
          ok: false,
          summary: `nothing matches "${wanted}"`,
          feedback: `[MUSIC] Nothing in the library matches "${wanted}", so there is no playlist to build. Say so, and ask what they meant.`,
        };
      }

      // An album is the one playlist somebody else already put in an order, so
      // it is played in that order. Everything else — a band, a genre, the
      // whole library — is a pile of songs that `search` hands back ranked and
      // then alphabetical, which is why the same request has been coming out in
      // the same sequence every time, like a cassette. That pile is shuffled by
      // default; only being asked for it in order keeps it as it came.
      const record = albumOrder(hits);
      const list = record ?? hits;
      const wantsShuffle = askedShuffle || (!askedOrder && !record && list.length > 1);

      const first = queueUp(list, wantsShuffle);
      const named = queue.slice(0, NAMED_IN_FEEDBACK).map((track) => track.title).join(', ');
      const how = shuffle ? ' in a random order' : record ? ' in album order' : '';
      return {
        ok: true,
        summary: `${queue.length} track(s)${shuffle ? ', shuffled' : ''} — now ${first.title}`,
        feedback:
          `[MUSIC] Queued ${queue.length} track(s)${how} for "${wanted || 'everything'}", ` +
          `now playing "${first.title}". It includes: ${named}${queue.length > NAMED_IN_FEEDBACK ? ', …' : ''}. ` +
          'Say how many are queued and what is playing, in one short sentence.',
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
        ordered = [];
        index = -1;
        audio.clear();
        return { ok: true, summary: 'stopped', feedback: '[MUSIC] Stopped, and the queue is empty. Say so briefly.' };
      }
      if (/^shuffle/.test(command)) {
        shuffle = !/off|no/.test(command);
        // What is playing does not change because a mode was toggled: it keeps
        // its place at the head of the redrawn queue, and switching back finds
        // it again wherever it sits in the order the tracks were gathered in.
        const current = queue[index];
        if (current && shuffle) {
          queue = [current, ...shuffled(queue.filter((track) => track !== current))];
          index = 0;
        } else if (current && ordered.length > 0) {
          queue = ordered;
          index = Math.max(0, queue.indexOf(current));
        }
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
