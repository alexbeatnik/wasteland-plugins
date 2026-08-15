/**
 * Reminders.
 *
 * Everything is on this machine: a list in the plugin's own document, a timer in
 * the main process, and a notification when one comes due. No account, no
 * calendar, no server — the app is either running or it is not, and what happens
 * when it is not is the interesting half of this file.
 *
 * Three decisions worth knowing about before changing anything here.
 *
 * **A single ticker, not a timer per reminder.** `setTimeout` for six hours'
 * time is a promise about a process that will probably be restarted first, and
 * it does not survive the machine going to sleep — a laptop shut at 18:00 and
 * opened at 20:00 owes a 18:45 reminder, which a sleeping timer will not pay.
 * One interval comparing wall-clock time against a stored moment gets both cases
 * right for free: a reminder that came due while nothing was watching fires the
 * moment something is.
 *
 * **What was missed is reported, not replayed.** Everything already due when the
 * plugin activates is collected into one notice — "while you were away, these
 * came round" — rather than six notifications arriving at once, which is what
 * firing them individually would produce after a weekend.
 *
 * **Nothing here talks to the model.** A reminder coming due does not start a
 * turn: there is no user message to answer, it would cost a model call for every
 * reminder, and a notification that has to wait for a 7B to compose it is not a
 * notification. The notice says what the user wrote, in their own words.
 */
import { clockOf, describeAt, describeRepeat, nextAfter, parseWhen } from './schedule.mjs';

/**
 * What the model is told.
 *
 * The first paragraph exists because of the audio player: an action a model
 * holds is not the same as an action it believes it holds, and asked to play a
 * song it answered "I can't directly play music" while holding `play_music`.
 * The same shape of refusal is waiting here — "I have no way to notify you
 * later", "you would need a calendar app" — so the fragment names it and says
 * plainly that it is wrong in this session.
 */
const PROMPT = `
REMINDERS — {"type":"remind","steps":"<when> | <what>"}

You CAN set reminders in this session. They are kept on the user's own machine
and arrive as a notification when they come due, whether or not this window is
in front — and if the app was closed at the time, the user is told what they
missed the next time it starts. "I can't set reminders", "I have no way to
notify you later" and "you would need a calendar for that" are all wrong here.

The current date and time are in the context above. Use them to turn what the
user said into exactly one of these, before the "|":

  "18:45"              the next time it is 18:45, today or tomorrow
  "2026-08-20 09:00"   an exact date and time
  "+25m", "+2h"        a delay from now
  "tomorrow 07:15"     that time tomorrow
  "daily 07:30"        every day at that time
  "every mon 09:00"    every week on that day

Do the arithmetic yourself. "In half an hour" is "+30m"; "quarter to seven" in
the evening is "18:45"; "in the morning" with nothing else said is "tomorrow
09:00". Never hand the format back to the user and ask them to restate it — work
it out, set it, and say in one sentence what you set and when it will happen.

After the "|" comes what to remind them of, in their own words, as the
notification will read it. Write it as a note to them, not about them:

\`\`\`action
{"type":"remind","steps":"18:45 | watch the next episode"}
\`\`\`

{"type":"reminders","steps":"<command>"} manages the ones already set:
"list" reads them back, "cancel <words from one>" removes it — you are offered
the choice when several match — and "clear" removes all of them.

The pending ones are in the context above, so answer "what have I got set?"
from there rather than by calling anything.`;

/** How often the clock is looked at. Twenty seconds is finer than any reminder. */
const TICK_MS = 20_000;

/** A list long enough to scroll is not a choice; beyond this, narrow the words. */
const MAX_CHOICES = 8;

/** Kept in the context, so a model can answer "what have I got set" for free. */
const NAMED_IN_CONTEXT = 5;

/**
 * The one interval, held at module scope.
 *
 * `deactivate` is a module export — the host calls it on the module, not on
 * anything `activate` returned — so the handle has to live somewhere both can
 * see. A timer that outlived the plugin being switched off would go on raising
 * notifications from a plugin whose checkbox says it is not running, which is
 * the plainest possible way for that checkbox to be a lie.
 */
let ticker = null;

export function activate(ctx) {
  const notify = ctx.service('notify');

  /** The last set of near-matches offered for cancelling, and its identity. */
  let offered = { token: '', reminders: [] };
  let offerCount = 0;

  const load = () => {
    const stored = ctx.state.get();
    return Array.isArray(stored.reminders) ? stored.reminders : [];
  };

  const save = (reminders) => {
    // Sorted on the way to disk so every reader — the ticker, the listing, the
    // context — sees them in the order they will happen, without sorting again.
    ctx.state.set({ version: 1, reminders: [...reminders].sort((a, b) => a.at - b.at) });
  };

  /**
   * Advance a reminder past a firing.
   *
   * Returns the reminder as it should now be stored, or null for a one-off that
   * has done its job. Recurring ones are computed from the clock rather than
   * from when they actually fired, so one that went off late does not drag its
   * own schedule later every time.
   */
  const advance = (reminder, now) => {
    const next = nextAfter(reminder, now);
    return next ? { ...reminder, at: next, fired: (reminder.fired ?? 0) + 1 } : null;
  };

  /** Everything already due, and everything else, kept apart. */
  const split = (reminders, now) => ({
    due: reminders.filter((reminder) => reminder.at <= now),
    waiting: reminders.filter((reminder) => reminder.at > now),
  });

  /**
   * The ticker.
   *
   * Wrapped whole in a try: this runs on a timer with nobody to catch anything,
   * and an exception thrown out of an interval callback in the main process is
   * not a failed reminder, it is a crashed application.
   */
  const tick = () => {
    try {
      const now = Date.now();
      const { due, waiting } = split(load(), now);
      if (due.length === 0) return;

      for (const reminder of due) {
        notify.show({
          pluginId: ctx.id,
          title: reminder.what,
          // The time it was *set* for, not the time it is now: a reminder that
          // fired late — a sleeping laptop — should say what it was for, which
          // is the only way the difference is visible.
          body: `Due at ${clockOf(reminder.at)}${describeRepeat(reminder) ? ` · ${describeRepeat(reminder)}` : ''}`,
        });
      }

      save([...waiting, ...due.map((reminder) => advance(reminder, now)).filter(Boolean)]);
    } catch (err) {
      ctx.log(`a reminder could not be delivered — ${err.message}`);
    }
  };

  /**
   * What came due while nothing was running.
   *
   * One notice for the batch, and no desktop notification: this lands as the
   * window is opening, and a system notification for something the user is
   * already looking at is noise. A weekend away otherwise arrives as six toasts
   * at once.
   */
  const reportMissed = () => {
    const now = Date.now();
    const { due, waiting } = split(load(), now);
    if (due.length === 0) return;

    const lines = due.map((reminder) => `${clockOf(reminder.at)} — ${reminder.what}`);
    notify.show({
      pluginId: ctx.id,
      title: due.length === 1 ? 'You missed a reminder' : `You missed ${due.length} reminders`,
      body: lines.join('\n'),
      desktop: false,
    });

    save([...waiting, ...due.map((reminder) => advance(reminder, now)).filter(Boolean)]);
  };

  reportMissed();
  // Switching the plugin off and on again activates it a second time; the old
  // ticker has to go or every reminder fires twice.
  if (ticker) clearInterval(ticker);
  ticker = setInterval(tick, TICK_MS);
  // Nothing about a pending reminder should keep the process alive on its own;
  // the app is what holds the loop open, and this must not delay a quit.
  ticker.unref?.();

  /**
   * The time, and what is pending, on every turn.
   *
   * The time is here because the model cannot set a reminder without it — "in
   * half an hour" is unanswerable otherwise — and it makes "what time is it"
   * answerable in passing. The pending list is here so that "what have I got
   * set?" costs no action at all.
   */
  ctx.context(() => {
    const now = new Date();
    const stamp = `${now.toDateString()}, ${clockOf(now.getTime())}`;
    const reminders = load();
    if (reminders.length === 0) return `[REMINDERS] Local time is now ${stamp}. Nothing is set.`;

    const named = reminders
      .slice(0, NAMED_IN_CONTEXT)
      .map((reminder) => `${describeAt(reminder.at, now.getTime())}: ${reminder.what}${describeRepeat(reminder) ? ` (${describeRepeat(reminder)})` : ''}`)
      .join('; ');
    const rest = reminders.length > NAMED_IN_CONTEXT ? `, and ${reminders.length - NAMED_IN_CONTEXT} more` : '';
    return `[REMINDERS] Local time is now ${stamp}. ${reminders.length} pending — ${named}${rest}.`;
  });

  ctx.prompt(PROMPT);

  ctx.action({
    type: 'remind',
    run: async (steps) => {
      const [rawWhen = '', ...rest] = String(steps ?? '').split('|');
      const what = rest.join('|').trim();
      if (!what) {
        return {
          ok: false,
          summary: 'nothing to be reminded of',
          feedback: '[REMINDERS] The part after "|" was empty, so there is nothing to remind them of. Ask what the reminder should say.',
        };
      }

      const now = Date.now();
      const when = parseWhen(rawWhen, now);
      if (!when.ok) {
        // The reason names the formats, so the model can correct itself on the
        // next turn instead of asking the user to type a timestamp.
        return {
          ok: false,
          summary: when.reason,
          feedback: `[REMINDERS] Nothing was set: ${when.reason}. Work the time out from the current time above and try once more.`,
        };
      }

      const reminder = {
        id: `r${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
        what,
        at: when.at,
        repeat: when.repeat,
        hour: when.hour ?? 0,
        minute: when.minute ?? 0,
        weekday: when.weekday ?? 0,
        created: now,
        fired: 0,
      };
      save([...load(), reminder]);

      const repeat = describeRepeat(reminder);
      return {
        ok: true,
        summary: `${describeAt(reminder.at, now)} — ${what}`,
        feedback:
          `[REMINDERS] Set: "${what}", ${describeAt(reminder.at, now)}${repeat ? `, repeating ${repeat}` : ''}. ` +
          'Confirm it in one short sentence, saying when it will happen. Do not list the others.',
      };
    },

    /** Nothing to choose here — `remind` sets one thing at one time. */
  });

  ctx.action({
    type: 'reminders',
    run: async (steps) => {
      const command = String(steps ?? '').trim();
      const reminders = load();
      const now = Date.now();

      if (/^clear|^remove all|^cancel all/i.test(command)) {
        if (reminders.length === 0) {
          return { ok: true, summary: 'nothing was set', feedback: '[REMINDERS] There were none to clear. Say so.' };
        }
        save([]);
        return {
          ok: true,
          summary: `cleared ${reminders.length}`,
          feedback: `[REMINDERS] All ${reminders.length} reminder(s) were cancelled. Say so in one sentence.`,
        };
      }

      if (/^cancel|^remove|^delete|^forget/i.test(command)) {
        const wanted = command.replace(/^(cancel|remove|delete|forget)\s*/i, '').trim();
        if (reminders.length === 0) {
          return { ok: true, summary: 'nothing is set', feedback: '[REMINDERS] Nothing is set, so there is nothing to cancel. Say so.' };
        }

        // Matched on the words the user would say — what the reminder is about,
        // or the time it is set for. A model naming an index it inferred from a
        // listing it half-remembers is how the wrong one gets cancelled.
        const hits = wanted
          ? reminders.filter(
              (reminder) =>
                reminder.what.toLowerCase().includes(wanted.toLowerCase()) || clockOf(reminder.at).includes(wanted),
            )
          : reminders;

        if (hits.length === 0) {
          return {
            ok: false,
            summary: `nothing matches "${wanted}"`,
            feedback: `[REMINDERS] No reminder matches "${wanted}". There are ${reminders.length} set. Ask which one they meant.`,
          };
        }
        if (hits.length === 1) {
          save(reminders.filter((reminder) => reminder.id !== hits[0].id));
          return {
            ok: true,
            summary: `cancelled "${hits[0].what}"`,
            feedback: `[REMINDERS] Cancelled "${hits[0].what}", which was ${describeAt(hits[0].at, now)}. Say so briefly.`,
          };
        }

        // Several could be meant, and cancelling is not undoable, so the user
        // picks. Same shape as the audio player's near-matches, for the same
        // reason: the model is guessing and the user is not.
        offerCount += 1;
        offered = { token: `c${offerCount}`, reminders: hits.slice(0, MAX_CHOICES) };
        return {
          ok: true,
          summary: `${hits.length} could be cancelled`,
          choices: offered.reminders.map((reminder, position) => ({
            id: `${offered.token}:${position}`,
            label: `✕ ${reminder.what}`,
            note: describeAt(reminder.at, now) + (describeRepeat(reminder) ? ` · ${describeRepeat(reminder)}` : ''),
          })),
          feedback:
            `[REMINDERS] ${hits.length} reminder(s) match "${wanted}", so none has been cancelled and the user has been ` +
            'shown the list with a button on each. Tell them to pick which one — do not choose for them, and do not ' +
            'repeat the list, it is already on their screen.',
        };
      }

      // Anything else is a request to read them back.
      if (reminders.length === 0) {
        return { ok: true, summary: 'nothing is set', feedback: '[REMINDERS] Nothing is set. Say so, and offer to set one.' };
      }
      const lines = reminders
        .map((reminder) => `${describeAt(reminder.at, now)}: ${reminder.what}${describeRepeat(reminder) ? ` (${describeRepeat(reminder)})` : ''}`)
        .join('; ');
      return {
        ok: true,
        summary: `${reminders.length} set`,
        feedback: `[REMINDERS] ${reminders.length} pending — ${lines}. Read them back plainly, one per line.`,
      };
    },

    /**
     * One of the cancel buttons was pressed.
     *
     * The token is what makes an old list safe: a second cancel search replaces
     * this one while the first is still on screen and still clickable, and a
     * bare index would quietly remove something the user never saw offered.
     */
    choose: async (choiceId) => {
      const [token, rawPosition] = String(choiceId).split(':');
      if (token !== offered.token) throw new Error('that list is no longer the current one');

      const picked = offered.reminders[Number(rawPosition)];
      if (!picked) throw new Error('that list is no longer the current one');

      const remaining = load().filter((reminder) => reminder.id !== picked.id);
      if (remaining.length === load().length) throw new Error('that reminder is already gone');
      save(remaining);
      return { ok: true, summary: `cancelled "${picked.what}"` };
    },
  });
}

/** Switched off, or on the way out. The reminders stay; the clock stops. */
export function deactivate() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}
