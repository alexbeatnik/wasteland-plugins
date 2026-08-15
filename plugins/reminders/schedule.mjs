/**
 * Turning what somebody said into a moment in time.
 *
 * Kept apart from `main.mjs` because every function here is pure and every one
 * of them has an edge that only a test will find: a time that has already gone
 * by today, a weekly reminder set on the day it is due, a clock that crosses
 * midnight, a daylight-saving change that makes a day 23 hours long.
 *
 * Everything is local time. A reminder is a promise about the user's own clock —
 * "quarter to seven" means quarter to seven where they are sitting — so the
 * arithmetic is done with the local-time constructors rather than on epoch
 * milliseconds, which is also what keeps `07:30 daily` at 07:30 across a
 * daylight-saving boundary instead of drifting to 06:30 for half the year.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS = { s: SECOND, m: MINUTE, h: HOUR, d: DAY };

/** Sunday first, because that is what `Date.getDay()` counts from. */
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Which day of the week is this, if it is one? Three letters is enough. */
function weekdayOf(word) {
  const text = String(word ?? '').toLowerCase();
  if (text.length < 3) return -1;
  return WEEKDAYS.findIndex((day) => day.startsWith(text.slice(0, 3)));
}

/** The moment `hour:minute` on the calendar day that `base` falls in. */
function atClock(base, hour, minute) {
  const date = new Date(base);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

/**
 * The next `hour:minute` strictly after `from` — today if it is still ahead,
 * tomorrow otherwise.
 *
 * Strictly after, not "at or after": a reminder set for 18:45 at exactly 18:45
 * that fires immediately is not what anybody meant by "remind me at quarter to
 * seven", and a daily one rescheduled that way would fire twice and then loop.
 */
export function nextClock(from, hour, minute) {
  const today = atClock(from, hour, minute);
  return today > from ? today : atClock(from + DAY, hour, minute);
}

/** The next `weekday` at `hour:minute` strictly after `from`. */
export function nextWeekly(from, weekday, hour, minute) {
  let at = nextClock(from, hour, minute);
  // At most seven steps; the guard is for a `weekday` that is not one, which
  // would otherwise spin forever rather than fail.
  for (let step = 0; step < 8 && new Date(at).getDay() !== weekday; step += 1) {
    at = atClock(at + DAY, hour, minute);
  }
  return new Date(at).getDay() === weekday ? at : 0;
}

function validClock(hour, minute) {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/**
 * Read a "when" into a reminder.
 *
 * Returns `{ok: true, at, repeat, hour, minute, weekday}` or `{ok: false,
 * reason}` — a sentence, because it goes back to the model as the reason
 * nothing was set, and "unparseable" tells it nothing it can act on.
 *
 * The grammar is deliberately small and is spelled out in the system prompt: the
 * model has the current date and time in its context and is asked to do the
 * arithmetic itself. Guessing at free text here — "after lunch", "next week
 * sometime" — would be a second, worse language model.
 */
export function parseWhen(input, now = Date.now()) {
  const text = String(input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return { ok: false, reason: 'no time was given' };

  // +25m, +2h, +1d — a delay from now.
  const delay = /^\+ ?(\d+) ?(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(text);
  if (delay) {
    const count = Number(delay[1]);
    const unit = UNITS[delay[2][0]];
    if (!count || !unit) return { ok: false, reason: `"${input}" is not a delay this understands` };
    return { ok: true, at: now + count * unit, repeat: 'once' };
  }

  // daily 07:30
  const daily = /^(?:daily|every day) (\d{1,2}):(\d{2})$/.exec(text);
  if (daily) {
    const [hour, minute] = [Number(daily[1]), Number(daily[2])];
    if (!validClock(hour, minute)) return { ok: false, reason: `${daily[1]}:${daily[2]} is not a time of day` };
    return { ok: true, at: nextClock(now, hour, minute), repeat: 'daily', hour, minute };
  }

  // every mon 09:00 — checked after `every day`, which would otherwise look
  // like a weekday called "day".
  const weekly = /^(?:weekly|every) ([a-z]{3,9}) (\d{1,2}):(\d{2})$/.exec(text);
  if (weekly) {
    const weekday = weekdayOf(weekly[1]);
    const [hour, minute] = [Number(weekly[2]), Number(weekly[3])];
    if (weekday < 0) return { ok: false, reason: `"${weekly[1]}" is not a day of the week` };
    if (!validClock(hour, minute)) return { ok: false, reason: `${weekly[2]}:${weekly[3]} is not a time of day` };
    return { ok: true, at: nextWeekly(now, weekday, hour, minute), repeat: 'weekly', hour, minute, weekday };
  }

  // 2026-08-20 09:00 — an exact date.
  const exact = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(text);
  if (exact) {
    const [, year, month, day, rawHour, rawMinute] = exact;
    const [hour, minute] = [Number(rawHour), Number(rawMinute)];
    if (!validClock(hour, minute)) return { ok: false, reason: `${rawHour}:${rawMinute} is not a time of day` };
    const at = new Date(Number(year), Number(month) - 1, Number(day), hour, minute, 0, 0).getTime();
    if (!Number.isFinite(at)) return { ok: false, reason: `"${input}" is not a date` };
    // Refused rather than quietly moved: a date in the past is a sum somebody
    // got wrong, and silently setting it for next year would be worse.
    if (at <= now) return { ok: false, reason: 'that moment has already gone by' };
    return { ok: true, at, repeat: 'once' };
  }

  // tomorrow 07:15
  const tomorrow = /^tomorrow (\d{1,2}):(\d{2})$/.exec(text);
  if (tomorrow) {
    const [hour, minute] = [Number(tomorrow[1]), Number(tomorrow[2])];
    if (!validClock(hour, minute)) return { ok: false, reason: `${tomorrow[1]}:${tomorrow[2]} is not a time of day` };
    return { ok: true, at: atClock(now + DAY, hour, minute), repeat: 'once' };
  }

  // 18:45 — the next time it is that o'clock.
  const clock = /^(?:at )?(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const [hour, minute] = [Number(clock[1]), Number(clock[2])];
    if (!validClock(hour, minute)) return { ok: false, reason: `${clock[1]}:${clock[2]} is not a time of day` };
    return { ok: true, at: nextClock(now, hour, minute), repeat: 'once' };
  }

  return {
    ok: false,
    reason: `"${input}" is not a time this understands — use "18:45", "2026-08-20 09:00", "+25m", "daily 07:30" or "every mon 09:00"`,
  };
}

/**
 * When does this reminder come round again?
 *
 * 0 for a one-off, which is what says it should be forgotten once it has fired.
 * Computed from the clock rather than by adding a day to the last firing, so a
 * reminder that fired late — a sleeping laptop, an app that was closed — does
 * not drag its own schedule later every time.
 */
export function nextAfter(reminder, from) {
  if (reminder?.repeat === 'daily') return nextClock(from, reminder.hour, reminder.minute);
  if (reminder?.repeat === 'weekly') return nextWeekly(from, reminder.weekday, reminder.hour, reminder.minute);
  return 0;
}

/** `18:45`, in the user's own clock. */
export function clockOf(at) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function sameDay(a, b) {
  const [left, right] = [new Date(a), new Date(b)];
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * How to say when this is, to somebody who knows what time it is now.
 *
 * "in 20 minutes" is more use than "at 18:45" for something imminent, and
 * "tomorrow at 07:30" is more use than either for something that is not. The
 * date only appears when it has to.
 */
export function describeAt(at, now = Date.now()) {
  const away = at - now;
  if (away <= 0) return 'now';
  if (away < MINUTE) return 'in less than a minute';
  if (away < HOUR) {
    const minutes = Math.round(away / MINUTE);
    return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (sameDay(at, now)) return `at ${clockOf(at)}`;
  if (sameDay(at, now + DAY)) return `tomorrow at ${clockOf(at)}`;

  const date = new Date(at);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `on ${day} at ${clockOf(at)}`;
}

/** "daily at 07:30" / "every Monday at 09:00" / "" for a one-off. */
export function describeRepeat(reminder) {
  if (reminder?.repeat === 'daily') return `daily at ${clockOf(reminder.at)}`;
  if (reminder?.repeat === 'weekly') {
    const day = WEEKDAYS[reminder.weekday] ?? '';
    return `every ${day.charAt(0).toUpperCase()}${day.slice(1)} at ${clockOf(reminder.at)}`;
  }
  return '';
}
