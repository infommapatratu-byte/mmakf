// Reading a posted week.
//
// The wizard at /admin/schedules/start renders seven days × three slots and
// posts twenty-one pairs of times. Every failure this suite covers publishes a
// WRONG TIMETABLE that looks entirely plausible — no error, no exception, no
// failing assertion anywhere else — which is why the parsing is a module with
// tests rather than a loop inside a page.
//
// What it deliberately does NOT test is whether two sessions overlap or whether
// a window ends before it starts. `setRules()` decides both, refuses with the
// offending times named, and is covered by tests/scheduling.test.ts. A second
// opinion here would eventually disagree with it, and the edge would win
// because it runs first.

import { describe, it, expect } from 'vitest';
import { parseWeekForm, assertWeekNotEmpty, daysWithSessions, WeekFormError } from '../src/lib/week-form';

/** A form, as a lookup. Missing fields read as '' exactly as FormData does. */
const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? '';

describe('the sessions a person entered', () => {
  it('reads a morning and an evening batch on one day', () => {
    const rules = parseWeekForm(form({
      'open-1-1': '06:00', 'close-1-1': '09:00',
      'open-1-2': '17:00', 'close-1-2': '20:00',
    }));
    expect(rules).toEqual([
      { dayOfWeek: 1, opensAt: '06:00', closesAt: '09:00', kind: 'open', label: null, displayOrder: 1 },
      { dayOfWeek: 1, opensAt: '17:00', closesAt: '20:00', kind: 'open', label: null, displayOrder: 2 },
    ]);
  });

  it('keeps the order the person put them in, rather than sorting by time', () => {
    // The evening batch typed into slot 1 and the morning into slot 2 is
    // unusual and it is what they meant. Re-sorting would be a different claim
    // about which session is which, and displayOrder is what renders.
    const rules = parseWeekForm(form({
      'open-3-1': '18:00', 'close-3-1': '20:00',
      'open-3-2': '06:00', 'close-3-2': '08:00',
    }));
    expect(rules.map((r) => [r.opensAt, r.displayOrder])).toEqual([['18:00', 1], ['06:00', 2]]);
  });

  it('carries an optional session name and drops an empty one', () => {
    const rules = parseWeekForm(form({
      'open-2-1': '17:00', 'close-2-1': '18:30', 'label-2-1': 'Kids batch',
      'open-2-2': '19:00', 'close-2-2': '20:30', 'label-2-2': '   ',
    }));
    expect(rules[0].label).toBe('Kids batch');
    expect(rules[1].label).toBeNull();
  });

  it('ignores slots nobody filled in, without shifting the ones that follow', () => {
    const rules = parseWeekForm(form({
      'open-5-1': '', 'close-5-1': '',
      'open-5-3': '19:00', 'close-5-3': '21:00',
    }));
    expect(rules).toHaveLength(1);
    expect(rules[0].displayOrder, 'the third slot stays the third').toBe(3);
  });

  it('reads all seven days, Monday as 1 and Sunday as 7', () => {
    const fields: Record<string, string> = {};
    for (let d = 1; d <= 7; d++) {
      fields[`open-${d}-1`] = '07:00';
      fields[`close-${d}-1`] = '08:00';
    }
    const rules = parseWeekForm(form(fields));
    expect(daysWithSessions(rules)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('what it refuses, and why each refusal exists', () => {
  it('refuses half a window rather than inventing the other end', () => {
    // Publishing a time nobody typed is worse than stopping; dropping the row
    // silently is worse still, because the person believes they entered it.
    expect(() => parseWeekForm(form({ 'open-7-1': '06:00' })))
      .toThrow(/Sunday session 1 has only one end/);
    expect(() => parseWeekForm(form({ 'close-4-2': '20:00' })))
      .toThrow(/Thursday session 2 has only one end/);
  });

  it('names the day in the reader’s words, not as a number', () => {
    try {
      parseWeekForm(form({ 'open-6-1': '07:00' }));
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err).toBeInstanceOf(WeekFormError);
      expect(err.code).toBe('half_window');
      expect(err.message).toContain('Saturday');
      expect(err.message).not.toMatch(/day 6|dayOfWeek/);
    }
  });

  it('refuses a day that is both closed and has sessions', () => {
    // Preferring one silently would make either the tick box or the times a
    // lie, and the person cannot tell which was ignored.
    try {
      parseWeekForm(form({ 'closed-2': 'yes', 'open-2-1': '18:00', 'close-2-1': '20:00' }));
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err.code).toBe('closed_with_sessions');
      expect(err.message).toContain('Tuesday');
      expect(err.message).toContain('1 session');
    }
  });

  it('drops a closed day entirely rather than writing a closed rule', () => {
    const rules = parseWeekForm(form({
      'closed-7': 'yes',
      'open-1-1': '06:00', 'close-1-1': '09:00',
    }));
    expect(daysWithSessions(rules)).toEqual([1]);
    expect(rules.every((r) => r.kind === 'open')).toBe(true);
  });

  it('refuses an empty week with advice about where closed days belong', () => {
    expect(() => assertWeekNotEmpty([])).toThrow(/closed every day/);
    expect(() => assertWeekNotEmpty(parseWeekForm(form({})))).toThrow(WeekFormError);
    // And says nothing when there is something to publish.
    expect(() => assertWeekNotEmpty(parseWeekForm(form({ 'open-1-1': '06:00', 'close-1-1': '07:00' }))))
      .not.toThrow();
  });
});

describe('the slot count follows the form', () => {
  it('reads only as many slots as were rendered', () => {
    const fields = {
      'open-1-1': '06:00', 'close-1-1': '07:00',
      'open-1-2': '08:00', 'close-1-2': '09:00',
      'open-1-3': '10:00', 'close-1-3': '11:00',
    };
    expect(parseWeekForm(form(fields), { maxSlotsPerDay: 2 })).toHaveLength(2);
    expect(parseWeekForm(form(fields), { maxSlotsPerDay: 3 })).toHaveLength(3);
  });
});
