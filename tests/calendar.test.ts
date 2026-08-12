// The federation calendar.
//
// The failure this suite exists to prevent: a calendar that puts an event on a
// day the federation never chose. Every other bug here is recoverable; a member
// who travels to a grading that was never scheduled is not.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import {
  federationCalendar, toIcs, icsEscape, foldLine, registrationState,
  requireDate, addMonths, todayIso, CalendarError, isCalendarError,
  PUBLIC_EVENT_STATUSES, PUBLIC_GRADING_STATUSES,
} from '../src/lib/calendar';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number, BR: number, SYL: number;

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const jhAdmin = (): Principal => ({
  userId: 2, label: 'jh', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
});
const brAdmin = (): Principal => ({
  userId: 3, label: 'br', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: BR }],
});

const WINDOW = { from: '2026-01-01', to: '2026-12-31', asAt: '2026-06-01' };
const STAMP = new Date('2026-06-01T09:00:00Z');

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  const [br] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-BR', state: 'Bihar', name: 'Bihar', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id; BR = br.id;

  await db.insert(s.competitionEvents).values([
    // National, sanctioned, dated, registration open on 2026-06-01.
    {
      code: 'MMAKF-EVT-2026-000001', title: 'MMAKF National Championship 2026',
      kind: 'national_championship', status: 'registration_open',
      startsOn: '2026-08-02', endsOn: '2026-08-03', venue: 'State Sports Centre', city: 'Ranchi',
      sanctionedAt: new Date('2026-02-01T00:00:00Z'), sanctionReference: 'MMAKF/SANC/2026/001',
      registrationOpensAt: new Date('2026-05-01T00:00:00Z'),
      registrationClosesAt: new Date('2026-07-15T00:00:00Z'),
    },
    // Jharkhand, published, NOT sanctioned.
    {
      code: 'MMAKF-EVT-2026-000002', title: 'Ramgarh District Championship',
      kind: 'district_championship', status: 'published',
      startsOn: '2026-06-22', venue: 'Indoor Sports Complex', city: 'Ramgarh', stateUnitId: JH,
    },
    // Bihar DRAFT — must not reach anyone but a Bihar official.
    {
      code: 'MMAKF-EVT-2026-000003', title: 'Bihar Selection Trial',
      kind: 'selection_trial', status: 'draft', startsOn: '2026-07-05', stateUnitId: BR,
    },
    // Announced with NO DATE.
    {
      code: 'MMAKF-EVT-2026-000004', title: 'Open National — dates to be confirmed',
      kind: 'open_national', status: 'published', startsOn: null,
    },
    // Cancelled.
    {
      code: 'MMAKF-EVT-2026-000005', title: 'Winter Camp 2026',
      kind: 'camp', status: 'cancelled', startsOn: '2026-12-10', stateUnitId: JH,
    },
    // Outside the window.
    {
      code: 'MMAKF-EVT-2027-000001', title: 'Nationals 2027',
      kind: 'national_championship', status: 'published', startsOn: '2027-03-01',
    },
  ]);

  const [syl] = await db.insert(s.syllabusVersions)
    .values({ code: 'MMAKF-SYL-V1', title: 'Shotokan syllabus', status: 'active' })
    .returning({ id: s.syllabusVersions.id });
  SYL = syl.id;

  await db.insert(s.gradingEvents).values([
    {
      code: 'MMAKF-GRD-2026-000001', title: 'National Black Belt Grading Camp',
      syllabusVersionId: SYL, status: 'scheduled', heldOn: '2026-06-15',
      venue: 'MMAKF Dojo — Main Hall', stateUnitId: JH,
      registrationOpensOn: '2026-05-01', registrationClosesOn: '2026-06-10',
    },
    // DRAFT — a plan, not a fixture.
    {
      code: 'MMAKF-GRD-2026-000002', title: 'Draft grading (office plan)',
      syllabusVersionId: SYL, status: 'draft', heldOn: '2026-09-01', stateUnitId: BR,
    },
  ]);

  await db.insert(s.courses).values([
    { slug: 'shotokan-foundations', title: 'Shotokan Foundations', status: 'published', level: 'Beginner' },
    { slug: 'unpublished-course', title: 'Not published yet', status: 'draft' },
  ]);
});

describe('an event with no date is never placed on one', () => {
  it('separates undated announcements instead of guessing or dropping them', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const dated = r.entries.map((e) => e.ref);
    const undated = r.undated.map((e) => e.ref);

    expect(undated).toContain('MMAKF-EVT-2026-000004');
    expect(dated).not.toContain('MMAKF-EVT-2026-000004');
    // Dropping it would hide an announcement the federation actually made.
    expect(r.undated.find((e) => e.ref === 'MMAKF-EVT-2026-000004')!.startsOn).toBeNull();
  });

  it('every dated entry genuinely has a date', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    expect(r.entries.every((e) => e.startsOn !== null)).toBe(true);
  });

  it('sorts dated entries earliest first, deterministically', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const dates = r.entries.map((e) => e.startsOn!);
    expect(dates).toEqual([...dates].sort());
  });
});

describe('what anonymous callers may see', () => {
  it('shows published and sanctioned fixtures', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    expect(r.entries.map((e) => e.ref)).toContain('MMAKF-EVT-2026-000001');
  });

  it('NEVER shows another unit\'s draft fixture', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const all = [...r.entries, ...r.undated].map((e) => e.ref);
    expect(all).not.toContain('MMAKF-EVT-2026-000003');
  });

  it('never shows a DRAFT grading — a plan is not a fixture', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const all = [...r.entries, ...r.undated].map((e) => e.ref);
    expect(all).toContain('MMAKF-GRD-2026-000001');
    expect(all).not.toContain('MMAKF-GRD-2026-000002');
  });

  it('shows only published courses', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const refs = r.undated.map((e) => e.ref);
    expect(refs).toContain('shotokan-foundations');
    expect(refs).not.toContain('unpublished-course');
  });

  it('excludes events outside the window', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    expect(r.entries.map((e) => e.ref)).not.toContain('MMAKF-EVT-2027-000001');
  });
});

describe('scope', () => {
  it('a Bihar official sees their own draft; a Jharkhand official does not', async () => {
    const br = await federationCalendar(db, brAdmin(), WINDOW);
    expect(br.entries.map((e) => e.ref)).toContain('MMAKF-EVT-2026-000003');

    const jh = await federationCalendar(db, jhAdmin(), WINDOW);
    expect(jh.entries.map((e) => e.ref)).not.toContain('MMAKF-EVT-2026-000003');
  });

  it('a state official still sees NATIONAL fixtures — they select athletes for them', async () => {
    const jh = await federationCalendar(db, jhAdmin(), WINDOW);
    expect(jh.entries.map((e) => e.ref)).toContain('MMAKF-EVT-2026-000001');
  });

  it('a national admin sees every draft', async () => {
    const r = await federationCalendar(db, national, WINDOW);
    const all = [...r.entries, ...r.undated].map((e) => e.ref);
    expect(all).toContain('MMAKF-EVT-2026-000003');
    expect(all).toContain('MMAKF-GRD-2026-000002');
  });

  it('a broken principal is treated as anonymous, not as powerful', async () => {
    const broken = { userId: 9, label: 'x', bindings: null as any };
    const r = await federationCalendar(db, broken, WINDOW);
    expect(r.entries.map((e) => e.ref)).not.toContain('MMAKF-EVT-2026-000003');
  });
});

describe('sanction is carried, never assumed', () => {
  it('marks a sanctioned championship as sanctioned, with its reference', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const e = r.entries.find((x) => x.ref === 'MMAKF-EVT-2026-000001')!;
    expect(e.sanctioned).toBe(true);
    expect(e.sanctionReference).toBe('MMAKF/SANC/2026/001');
  });

  it('marks an unsanctioned event false rather than omitting the question', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const e = r.entries.find((x) => x.ref === 'MMAKF-EVT-2026-000002')!;
    expect(e.sanctioned).toBe(false);
  });

  it('reports NULL for a grading, because sanction is not its governing concept', async () => {
    // A grading is authorised by its syllabus version and chief examiner.
    // Reporting `false` would claim the federation withheld something it never
    // had a field for.
    const r = await federationCalendar(db, null, WINDOW);
    const g = r.entries.find((x) => x.kind === 'grading')!;
    expect(g.sanctioned).toBeNull();
  });
});

describe('registration is answered AS AT A DATE', () => {
  it('open on a date inside the window, closed after it', async () => {
    const during = await federationCalendar(db, null, { ...WINDOW, asAt: '2026-06-01' });
    expect(during.entries.find((e) => e.ref === 'MMAKF-EVT-2026-000001')!.registration.state).toBe('open');

    const after = await federationCalendar(db, null, { ...WINDOW, asAt: '2026-07-20' });
    expect(after.entries.find((e) => e.ref === 'MMAKF-EVT-2026-000001')!.registration.state).toBe('closed');

    const before = await federationCalendar(db, null, { ...WINDOW, asAt: '2026-04-01' });
    expect(before.entries.find((e) => e.ref === 'MMAKF-EVT-2026-000001')!.registration.state).toBe('not_open_yet');
  });

  it('carries the date it answered for, so a stale page cannot mislead', async () => {
    const r = await federationCalendar(db, null, { ...WINDOW, asAt: '2026-06-01' });
    expect(r.asAt).toBe('2026-06-01');
    expect(r.entries[0].registration.asAt).toBe('2026-06-01');
  });

  it('"no window recorded" is NOT "open"', () => {
    // A missing window may be deliberate or an omission, and only the office
    // knows which. Rendering it as "entries open" invents a federation decision.
    expect(registrationState(null, null, '2026-06-01')).toBe('no_window_recorded');
    expect(registrationState('2026-05-01', null, '2026-06-01')).toBe('open');
    expect(registrationState(null, '2026-05-01', '2026-06-01')).toBe('closed');
  });
});

describe('malformed input is refused, not coerced', () => {
  it('refuses a non-ISO date rather than shifting the window', async () => {
    await expect(federationCalendar(db, null, { from: '01/06/2026' })).rejects.toThrow(CalendarError);
    await expect(federationCalendar(db, null, { from: '2026-13-01' })).rejects.toThrow(/not a real date/);
  });

  it('refuses a window that ends before it starts', async () => {
    await expect(federationCalendar(db, null, { from: '2026-12-01', to: '2026-01-01' }))
      .rejects.toThrow(/before its start/);
  });

  it('refuses an unknown source', async () => {
    await expect(federationCalendar(db, null, { kinds: ['gradings' as any] }))
      .rejects.toThrow(/Unknown calendar source/);
  });

  it('reads an EMPTY kinds array as none, not as everything', async () => {
    const r = await federationCalendar(db, null, { ...WINDOW, kinds: [] });
    expect(r.entries).toEqual([]);
    expect(r.undated).toEqual([]);
    // And says which sources it skipped, so the emptiness is explainable.
    expect(r.skipped.map((x) => x.kind).sort()).toEqual(['competition', 'course', 'grading']);
  });

  it('refuses a non-finite limit', async () => {
    await expect(federationCalendar(db, null, { limit: NaN })).rejects.toThrow(/finite/);
  });
});

describe('error identification survives a duplicated module', () => {
  it('recognises the error by its own shape, not by constructor identity', async () => {
    // instanceof compares constructor identity. A bundler that resolves this
    // module under two specifiers hands a page a DIFFERENT CalendarError class
    // than the one thrown, the check silently fails, and "from must be an ISO
    // date" is replaced by "something went wrong" — which happened.
    const thrown = await federationCalendar(db, null, { from: 'nonsense' }).catch((e) => e);
    expect(isCalendarError(thrown)).toBe(true);
    expect(thrown.message).toMatch(/ISO date/);

    // A structurally identical error from a second copy of the class is still
    // recognised, which is the whole point.
    class OtherCopy extends Error {
      code = 'bad_date';
      constructor(m: string) { super(m); this.name = 'CalendarError'; }
    }
    expect(isCalendarError(new OtherCopy('x'))).toBe(true);
  });

  it('does not claim an unrelated error as its own', () => {
    expect(isCalendarError(new Error('boom'))).toBe(false);
    expect(isCalendarError(null)).toBe(false);
    expect(isCalendarError({ code: 'bad_date' })).toBe(false);   // wrong name
  });
});

describe('date helpers', () => {
  it('clamps a month rollover instead of spilling into the next month', () => {
    // 31 January + 1 month is the last day of February, not 3 March.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-06-15', 12)).toBe('2027-06-15');
  });

  it('addMonths REFUSES a bad date instead of throwing a RangeError from inside', () => {
    // This is the bug that shipped: the calendar page computed its window end
    // as addMonths(fromParam, 12) before anything validated fromParam, so
    // ?from=nonsense crashed with a RangeError out of toISOString() and the
    // page could only say "something went wrong".
    expect(() => addMonths('nonsense', 12)).toThrow(/not an ISO date/);
    expect(() => addMonths('2026-13-45', 1)).toThrow(/not an ISO date/);
  });

  it('requireDate returns the fallback only when the value is absent', () => {
    expect(requireDate(undefined, '2026-01-01', 'from')).toBe('2026-01-01');
    expect(requireDate('2026-05-05', '2026-01-01', 'from')).toBe('2026-05-05');
    expect(() => requireDate('', '2026-01-01', 'from')).toThrow();
  });

  it('todayIso is a date, not an instant', () => {
    expect(todayIso(new Date('2026-06-01T23:45:00Z'))).toBe('2026-06-01');
  });
});

describe('the iCalendar feed', () => {
  it('produces a valid calendar with CRLF line endings', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const ics = toIcs(r, { now: STAMP });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toMatch(/VERSION:2\.0/);
    // Bare LF is rejected by real clients.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it('EXCLUDES undated entries, because iCalendar cannot express "date unknown"', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const ics = toIcs(r, { now: STAMP });
    expect(ics).not.toMatch(/dates to be confirmed/);
    // Every workaround — today, the 1st, a year-long block — asserts a day the
    // federation has not chosen.
    const events = ics.match(/BEGIN:VEVENT/g) || [];
    expect(events.length).toBe(r.entries.length);
  });

  it('makes DTEND exclusive, so a one-day event is not zero-length', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const ics = toIcs(r, { now: STAMP });
    // The grading is held on a single day, 2026-06-15.
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20260615/);
    expect(ics).toMatch(/DTEND;VALUE=DATE:20260616/);
    // And the two-day national ends on the 3rd, so DTEND is the 4th.
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20260802/);
    expect(ics).toMatch(/DTEND;VALUE=DATE:20260804/);
  });

  it('keeps a cancelled event with STATUS:CANCELLED rather than dropping it', async () => {
    const r = await federationCalendar(db, jhAdmin(), WINDOW);
    const ics = toIcs(r, { now: STAMP });
    // An event that simply vanishes from the feed stays in a subscriber's diary
    // forever; the cancellation is the update they need.
    expect(ics).toMatch(/SUMMARY:Winter Camp 2026/);
    expect(ics).toMatch(/STATUS:CANCELLED/);
  });

  it('says plainly in the feed when an event is NOT sanctioned', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const ics = toIcs(r, { now: STAMP });
    // Unfold first — the description is long enough to be folded, which is the
    // correct output and not what a client shows the reader.
    const unfolded = ics.replace(/\r\n /g, '');
    // A calendar entry travels far from the page that carries the caveat.
    expect(unfolded).toMatch(/NOT SANCTIONED by the federation/);
    // And a sanctioned event carries its reference instead.
    expect(unfolded).toMatch(/Sanction: MMAKF\/SANC\/2026\/001/);
  });

  it('gives every event a stable UID, so a re-subscribe does not duplicate it', async () => {
    const r = await federationCalendar(db, null, WINDOW);
    const a = toIcs(r, { now: STAMP });
    const b = toIcs(r, { now: new Date('2026-07-01T00:00:00Z') });
    const uids = (t: string) => (t.match(/^UID:.*$/gm) || []).sort();
    expect(uids(a)).toEqual(uids(b));
    expect(uids(a)[0]).toMatch(/@mmakf\.in$/);
  });
});

describe('RFC 5545 text handling', () => {
  it('escapes backslash FIRST, so its own escapes are not re-escaped', () => {
    expect(icsEscape('a\\b')).toBe('a\\\\b');
    expect(icsEscape('a;b,c')).toBe('a\\;b\\,c');
    expect(icsEscape('line1\nline2')).toBe('line1\\nline2');
    expect(icsEscape('a\\;b')).toBe('a\\\\\\;b');
  });

  it('folds at 75 OCTETS, not characters', () => {
    // A Devanagari title is three bytes per character. Folding on character
    // count produces lines that look legal and are over the limit.
    const hindi = 'SUMMARY:' + 'क'.repeat(60);
    const folded = foldLine(hindi);
    for (const line of folded.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
    }
    // And unfolding restores the original exactly — no character was split.
    expect(folded.split('\r\n ').join('')).toBe(hindi);
  });

  it('leaves a short line alone', () => {
    expect(foldLine('SUMMARY:Nationals')).toBe('SUMMARY:Nationals');
  });

  it('continuation lines carry the required leading space', () => {
    const folded = foldLine('DESCRIPTION:' + 'x'.repeat(200));
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines.slice(1)) expect(l.startsWith(' ')).toBe(true);
  });
});

describe('the public status lists are the ones the rest of the system uses', () => {
  it('does not publish a draft competition under any name', () => {
    expect(PUBLIC_EVENT_STATUSES).not.toContain('draft' as any);
    expect(PUBLIC_EVENT_STATUSES).not.toContain('sanction_review' as any);
  });

  it('does not publish a draft grading', () => {
    expect(PUBLIC_GRADING_STATUSES).not.toContain('draft' as any);
  });
});
