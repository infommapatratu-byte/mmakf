// Turning a week of form fields into schedule rules.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS A MODULE AND NOT A LOOP IN THE PAGE
// ═══════════════════════════════════════════════════════════════════════════
//
// /admin/schedules/start renders seven days × three session slots and posts
// twenty-one pairs of times. Reading them back is the only real logic on that
// page, and it is exactly the kind of logic that is wrong in a way nobody
// notices: a half-filled row silently dropped, a closed day that still carries
// a session, a slot order that scrambles the morning and the evening batch.
//
// None of those raise an error. They publish a WRONG TIMETABLE that looks
// entirely plausible, which is the failure mode this whole domain exists to
// prevent. So the parsing lives here, where tests/week-form.test.ts can hold it,
// and the page keeps only the rendering.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IT DOES NOT DO
// ═══════════════════════════════════════════════════════════════════════════
//
// It does not decide whether two sessions overlap, whether a window ends before
// it starts, or whether a time is a time. `setRules()` in src/db/scheduling.ts
// decides all three, refuses with the offending times named, and is tested. A
// second opinion here would eventually disagree with it — and the edge would
// win, silently, because it runs first.
//
// This file answers one question only: WHICH ROWS DID THE PERSON ENTER.

import type { RuleInput } from '../db/scheduling';

export class WeekFormError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'WeekFormError';
  }
}

export const DAY_LABELS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const;

export interface WeekFormOptions {
  /** How many session slots the form rendered per day. */
  maxSlotsPerDay?: number;
}

/**
 * Read a posted week.
 *
 * Field names, matching what the form renders:
 *   `closed-<day>`            'yes' when the day is marked closed
 *   `open-<day>-<slot>`       HH:MM
 *   `close-<day>-<slot>`      HH:MM
 *   `label-<day>-<slot>`      optional name for the session
 *
 * `day` is 1 (Monday) to 7 (Sunday), matching `schedule_rules.day_of_week`.
 */
export function parseWeekForm(
  field: (name: string) => string,
  opts: WeekFormOptions = {},
): RuleInput[] {
  const maxSlots = opts.maxSlotsPerDay ?? 3;
  const rules: RuleInput[] = [];

  for (let day = 1; day <= 7; day++) {
    const closed = field(`closed-${day}`) === 'yes';
    const entered: Array<{ slot: number; opensAt: string; closesAt: string; label: string }> = [];

    for (let slot = 1; slot <= maxSlots; slot++) {
      const opensAt = field(`open-${day}-${slot}`).trim();
      const closesAt = field(`close-${day}-${slot}`).trim();
      const label = field(`label-${day}-${slot}`).trim();

      if (!opensAt && !closesAt) continue;

      // HALF A WINDOW IS A TYPO, NOT A SESSION. Inventing the other end would
      // publish a time nobody typed; dropping the row silently would lose a
      // session the person believes they entered. Both are worse than saying so.
      if (!opensAt || !closesAt) {
        throw new WeekFormError(
          'half_window',
          `${DAY_LABELS[day - 1]} session ${slot} has only one end of its time. ` +
          'Give both, or clear both.',
        );
      }
      entered.push({ slot, opensAt, closesAt, label });
    }

    // A DAY CANNOT BE BOTH CLOSED AND OPEN. Silently preferring one would make
    // the tick box or the times a lie, and the person cannot tell which.
    if (closed && entered.length) {
      throw new WeekFormError(
        'closed_with_sessions',
        `${DAY_LABELS[day - 1]} is marked closed and also has ${entered.length} ` +
        `session${entered.length === 1 ? '' : 's'} entered. Clear one or the other.`,
      );
    }
    if (closed) continue;

    for (const e of entered) {
      rules.push({
        dayOfWeek: day,
        opensAt: e.opensAt,
        closesAt: e.closesAt,
        kind: 'open',
        label: e.label || null,
        // ORDER AS ENTERED, not as sorted. The morning batch is slot 1 because
        // somebody put it there; re-sorting by time would be a different claim
        // about which session is which, and `displayOrder` is what the timetable
        // renders by.
        displayOrder: e.slot,
      });
    }
  }

  return rules;
}

/**
 * An empty week is refused, deliberately.
 *
 * A version with no rules resolves as "closed every day", which `publishVersion()`
 * also refuses — but the refusal a person needs here is different from the one
 * the module gives, because at this point they have not published anything and
 * the useful advice is about where closed days belong.
 */
export function assertWeekNotEmpty(rules: RuleInput[]): void {
  if (rules.length) return;
  throw new WeekFormError(
    'empty_week',
    'No sessions were entered. A timetable with no sessions reads as "closed every day", ' +
    'which is a statement to make deliberately — set the closed days on the club’s own ' +
    'schedule page rather than publishing an empty week here.',
  );
}

/** Every day that carries at least one session, in week order. */
export function daysWithSessions(rules: RuleInput[]): number[] {
  return [...new Set(rules.map((r) => r.dayOfWeek))].sort((a, b) => a - b);
}
