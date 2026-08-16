/**
 * Reading a time out of what somebody said.
 *
 * Every test here is a case that only shows up on a clock: a time that has
 * already gone by today, a weekly reminder set on the very day it is due, a
 * daily one crossing a daylight-saving boundary. None of them is visible from
 * reading the code, and all of them are the difference between a reminder
 * arriving and a reminder arriving a day late.
 *
 * `now` is passed in everywhere rather than read from the clock, so the suite
 * does not behave differently at 23:59.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clockOf,
  describeAt,
  describeRepeat,
  nextAfter,
  nextClock,
  nextWeekly,
  parseWhen,
} from '../plugins/reminders/schedule.mjs';

/** A fixed local moment to reason from: Saturday 15 August 2026, 18:22. */
const NOW = new Date(2026, 7, 15, 18, 22, 0, 0).getTime();

test('a delay is measured from now', () => {
  assert.equal(parseWhen('+25m', NOW).at, NOW + 25 * 60_000);
  assert.equal(parseWhen('+2h', NOW).at, NOW + 2 * 3_600_000);
  assert.equal(parseWhen('+1d', NOW).at, NOW + 86_400_000);
  // The spellings a model actually emits, not just the terse ones.
  assert.equal(parseWhen('+30 minutes', NOW).at, NOW + 30 * 60_000);
  assert.equal(parseWhen('+ 3 hours', NOW).at, NOW + 3 * 3_600_000);
});

test('a bare clock time means the next time it is that o’clock', () => {
  // Later today.
  const evening = parseWhen('18:45', NOW);
  assert.equal(clockOf(evening.at), '18:45');
  assert.equal(new Date(evening.at).getDate(), 15);

  // Already gone by, so tomorrow — the case that makes "remind me at 9" work
  // when it is said in the evening.
  const morning = parseWhen('09:00', NOW);
  assert.equal(clockOf(morning.at), '09:00');
  assert.equal(new Date(morning.at).getDate(), 16);
});

test('the current minute is not "now", it is tomorrow', () => {
  // Strictly after, on purpose: a reminder set for 18:22 at 18:22 that fires
  // instantly is not what "remind me at twenty past six" meant, and a daily one
  // rescheduled that way would fire twice and then loop.
  const at = parseWhen('18:22', NOW).at;
  assert.equal(new Date(at).getDate(), 16);
});

test('an exact date is taken as written, and a past one is refused', () => {
  const exact = parseWhen('2026-08-20 09:00', NOW);
  assert.equal(exact.ok, true);
  assert.equal(new Date(exact.at).getDate(), 20);
  assert.equal(clockOf(exact.at), '09:00');

  // Refused rather than quietly moved to next year: a date in the past is a sum
  // somebody got wrong, and silently fixing it hides the mistake.
  const past = parseWhen('2020-01-01 09:00', NOW);
  assert.equal(past.ok, false);
  assert.match(past.reason, /already gone by/);
});

test('a date that is not on the calendar is refused, not rolled forward', () => {
  // `new Date(2026, 1, 31)` is the 3rd of March and says nothing about it, so
  // without a check "remind me on 2026-02-31" is accepted and then arrives
  // three days after the date somebody typed. Being told the date is wrong is
  // the better outcome by a distance.
  const impossible = parseWhen('2026-02-31 09:00', NOW);
  assert.equal(impossible.ok, false);
  assert.match(impossible.reason, /not a day on the calendar/);

  assert.equal(parseWhen('2026-04-31 09:00', NOW).ok, false, 'April has thirty days');
  assert.equal(parseWhen('2027-02-29 09:00', NOW).ok, false, '2027 is not a leap year');
  assert.equal(parseWhen('2026-13-01 09:00', NOW).ok, false, 'there is no thirteenth month');
  assert.equal(parseWhen('2026-00-10 09:00', NOW).ok, false, 'nor a zeroth');

  // The leap day that does exist is still a date, which is the half of this
  // that a cruder "February has 28 days" check would get wrong.
  assert.equal(parseWhen('2028-02-29 09:00', NOW).ok, true);
  assert.equal(parseWhen('2026-08-31 09:00', NOW).ok, true);
});

test('daily and weekly carry the clock, not just the next moment', () => {
  const daily = parseWhen('daily 07:30', NOW);
  assert.equal(daily.repeat, 'daily');
  assert.equal(daily.hour, 7);
  assert.equal(daily.minute, 30);
  assert.equal(clockOf(daily.at), '07:30');

  const weekly = parseWhen('every mon 09:00', NOW);
  assert.equal(weekly.repeat, 'weekly');
  assert.equal(weekly.weekday, 1);
  assert.equal(new Date(weekly.at).getDay(), 1);
  assert.ok(weekly.at > NOW);
});

test('"every day" is not a weekday called "day"', () => {
  // The weekly pattern would match it, so the daily one is tried first.
  const daily = parseWhen('every day 07:30', NOW);
  assert.equal(daily.repeat, 'daily');
});

test('a weekly reminder set on its own day, before the time, is today', () => {
  // Saturday 18:22, asking for Saturday 20:00 — the same evening, not a week
  // away. The naive "add seven days" gets this wrong every time.
  const at = nextWeekly(NOW, 6, 20, 0);
  assert.equal(new Date(at).getDate(), 15);
  assert.equal(clockOf(at), '20:00');

  // And Saturday 09:00, which has gone, is next Saturday.
  const next = nextWeekly(NOW, 6, 9, 0);
  assert.equal(new Date(next).getDate(), 22);
});

test('a recurring reminder is rescheduled from the clock, not from when it fired', () => {
  const daily = { repeat: 'daily', hour: 7, minute: 30 };
  // Fired late — the laptop was asleep until 09:10. The next one is still 07:30
  // tomorrow, not 09:10 tomorrow: computing from the firing drags the schedule
  // later every time it slips.
  const late = new Date(2026, 7, 16, 9, 10, 0, 0).getTime();
  const next = nextAfter(daily, late);
  assert.equal(clockOf(next), '07:30');
  assert.equal(new Date(next).getDate(), 17);
});

test('a one-off has nothing after it', () => {
  // Which is what says it should be forgotten once it has fired.
  assert.equal(nextAfter({ repeat: 'once' }, NOW), 0);
});

test('nonsense is refused with a sentence naming the formats', () => {
  // The reason goes back to the model as the explanation for why nothing was
  // set, so "unparseable" would be useless: it has to be able to correct itself.
  const bad = parseWhen('sometime after lunch', NOW);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /18:45/);
  assert.match(bad.reason, /daily 07:30/);

  assert.equal(parseWhen('', NOW).ok, false);
  assert.equal(parseWhen('25:00', NOW).ok, false, 'there is no 25 o’clock');
  assert.equal(parseWhen('12:60', NOW).ok, false, 'nor a 60th minute');
  assert.equal(parseWhen('every blursday 09:00', NOW).ok, false);
});

test('a time is described relative to now while that is more use', () => {
  assert.equal(describeAt(NOW + 20 * 60_000, NOW), 'in 20 minutes');
  assert.equal(describeAt(NOW + 61 * 60_000, NOW), 'at 19:23');
  assert.match(describeAt(NOW + 14 * 3_600_000, NOW), /^tomorrow at /);
  assert.match(describeAt(NOW + 5 * 86_400_000, NOW), /^on 2026-08-20 at /);
  // A minute away is not "in 0 minutes", and a moment past is not negative.
  assert.equal(describeAt(NOW + 30_000, NOW), 'in less than a minute');
  assert.equal(describeAt(NOW - 60_000, NOW), 'now');
});

test('a repeat describes itself in the user’s own clock', () => {
  const daily = parseWhen('daily 07:30', NOW);
  assert.equal(describeRepeat({ ...daily }), 'daily at 07:30');

  const weekly = parseWhen('every mon 09:00', NOW);
  assert.equal(describeRepeat({ ...weekly }), 'every Monday at 09:00');
  assert.equal(describeRepeat({ repeat: 'once' }), '');
});

test('a daily reminder keeps its clock across a daylight-saving change', () => {
  // The arithmetic is done with the local-time constructors rather than by
  // adding 86,400,000 milliseconds, which would move 07:30 to 06:30 for half
  // the year in any zone that changes. Skipped where the runner's zone has no
  // change to cross, since there is then nothing to assert.
  const winter = new Date(2026, 0, 15, 12, 0, 0, 0);
  const summer = new Date(2026, 6, 15, 12, 0, 0, 0);
  if (winter.getTimezoneOffset() === summer.getTimezoneOffset()) return;

  const before = new Date(2026, 2, 28, 12, 0, 0, 0).getTime();
  let at = nextClock(before, 7, 30);
  for (let day = 0; day < 5; day += 1) {
    assert.equal(clockOf(at), '07:30', 'the clock time must not drift');
    at = nextClock(at, 7, 30);
  }
});
