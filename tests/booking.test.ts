// Coach diaries and bookings.
//
// src/db/booking.ts §"NOT PROVEN, AND SAID OUT LOUD" describes this file: it
// "fires N simultaneous bookings for one slot and exactly one survives —
// measured, not asserted". The file did not exist, which made that paragraph a
// claim of verification with nothing behind it. It exists now and it does what
// the paragraph says.
//
// READ THE CAVEAT IN THAT PARAGRAPH BEFORE READING A GREEN RUN HERE AS PROOF OF
// THE ADVISORY LOCK. These tests run on PGlite, whose transactions are
// serialised inside the engine. What they establish is that the CHECK AND THE
// INSERT ARE INSIDE ONE TRANSACTION and that the invariant holds when N callers
// race — remove the transaction and the double-booking test fails with N rows.
// They do not, and cannot, prove that pg_advisory_xact_lock excludes two real
// backends; that needs two connections to a server Postgres and nothing in this
// repository can do it.
//
// The interval algebra and the IST helpers below need no database at all, and
// they are where the quiet bugs live: an off-by-one in istInstant() moves a
// 07:00 class off Tuesday and onto Monday, and the only symptom is a member who
// cannot find a slot they were told exists.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import {
  istInstant, istDayOf, istTimeOf, istDayRange,
  mergeIntervals, subtractIntervals, clipIntervals,
  setAvailability, book, cancel, isBookingError,
  BOOKING_KINDS,
} from '../src/db/booking';
import type { Principal } from '../src/lib/rbac';

const nat: Principal = {
  userId: 1, label: 'nat',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx = { principal: nat };

let db: any, JH: number, coachId: number;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  // The diary tables record who wrote each row, and the column is a real
  // foreign key — so the principal doing the writing has to be a real user.
  await db.insert(s.users).values({ id: nat.userId, email: 'nat@example.test', status: 'active' });

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'ST-JH', state: 'JH', name: 'Jharkhand' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const coach = await createPerson(db, ctx, { fullName: 'Coach', stateUnitId: JH });
  coachId = coach.id;
});

const iv = (a: string, b: string) => ({ start: new Date(a), end: new Date(b) });
const show = (list: { start: Date; end: Date }[]) =>
  list.map((i) => `${i.start.toISOString()}/${i.end.toISOString()}`);

// ─── IST, which is where the day boundary goes wrong ────────────────────────

describe('IST day handling', () => {
  it('places midnight on an IST day 5h30 BEFORE midnight UTC', () => {
    // The whole point of istInstant(). new Date('2026-09-15') is 05:30 on the
    // 15th in Patratu, so a naive search drops the first five and a half hours
    // of the day the member asked about.
    expect(istInstant('2026-09-15').toISOString()).toBe('2026-09-14T18:30:00.000Z');
    expect(istInstant('2026-09-15', '07:00').toISOString()).toBe('2026-09-15T01:30:00.000Z');
  });

  it('round-trips: the day and time of the instant it built', () => {
    const at = istInstant('2026-09-15', '07:00');
    expect(istDayOf(at)).toBe('2026-09-15');
    expect(istTimeOf(at)).toBe('07:00');
  });

  it('keeps an early-morning class on the day the member sees it on', () => {
    // 01:30 UTC on the 15th is 07:00 IST on the 15th. Read in UTC it is still
    // the 15th, but 20:00 UTC on the 14th is 01:30 IST on the 15th — the case
    // that moves a late class onto the wrong day.
    expect(istDayOf(new Date('2026-09-14T20:00:00Z'))).toBe('2026-09-15');
    expect(istTimeOf(new Date('2026-09-14T20:00:00Z'))).toBe('01:30');
  });

  it('treats "Monday to Friday" as including Friday', () => {
    const { from, to } = istDayRange('2026-09-14', '2026-09-18');
    expect(from.toISOString()).toBe('2026-09-13T18:30:00.000Z');
    // Inclusive of the 18th: the window ends at IST midnight ending the 18th.
    expect(to.toISOString()).toBe('2026-09-18T18:30:00.000Z');
  });

  it('refuses a malformed date or time rather than guessing at one', () => {
    expect(() => istInstant('15-09-2026')).toThrow();
    expect(() => istInstant('2026-09-15', '7am')).toThrow();
    expect(() => istInstant('2026-13-01')).toThrow();
    expect(() => istDayRange('2026-09-18', '2026-09-14')).toThrow();
  });
});

// ─── Interval algebra ───────────────────────────────────────────────────────

describe('interval algebra', () => {
  it('joins touching windows so the result has no seams', () => {
    // [09,10) and [10,11) must come back as [09,11). A seam left in here is a
    // ten-minute gap the slot search reports as unbookable for no reason.
    expect(show(mergeIntervals([
      iv('2026-09-15T09:00:00Z', '2026-09-15T10:00:00Z'),
      iv('2026-09-15T10:00:00Z', '2026-09-15T11:00:00Z'),
    ]))).toEqual(['2026-09-15T09:00:00.000Z/2026-09-15T11:00:00.000Z']);
  });

  it('merges out of order and drops empty windows', () => {
    expect(show(mergeIntervals([
      iv('2026-09-15T14:00:00Z', '2026-09-15T15:00:00Z'),
      iv('2026-09-15T09:00:00Z', '2026-09-15T09:00:00Z'), // empty
      iv('2026-09-15T09:00:00Z', '2026-09-15T10:00:00Z'),
    ]))).toEqual([
      '2026-09-15T09:00:00.000Z/2026-09-15T10:00:00.000Z',
      '2026-09-15T14:00:00.000Z/2026-09-15T15:00:00.000Z',
    ]);
  });

  it('cuts a hole in the middle and leaves both sides', () => {
    // The leave-day-inside-an-available-block case the module says is the
    // normal way a coach describes a week.
    expect(show(subtractIntervals(
      [iv('2026-09-15T09:00:00Z', '2026-09-15T17:00:00Z')],
      [iv('2026-09-15T12:00:00Z', '2026-09-15T13:00:00Z')],
    ))).toEqual([
      '2026-09-15T09:00:00.000Z/2026-09-15T12:00:00.000Z',
      '2026-09-15T13:00:00.000Z/2026-09-15T17:00:00.000Z',
    ]);
  });

  it('removes a window entirely when the cut covers it', () => {
    expect(subtractIntervals(
      [iv('2026-09-15T09:00:00Z', '2026-09-15T17:00:00Z')],
      [iv('2026-09-15T08:00:00Z', '2026-09-15T18:00:00Z')],
    )).toEqual([]);
  });

  it('leaves a window alone when the cut merely touches its edge', () => {
    // Half-open: a cut ending exactly at 09:00 removes nothing from [09,17).
    expect(show(subtractIntervals(
      [iv('2026-09-15T09:00:00Z', '2026-09-15T17:00:00Z')],
      [iv('2026-09-15T08:00:00Z', '2026-09-15T09:00:00Z')],
    ))).toEqual(['2026-09-15T09:00:00.000Z/2026-09-15T17:00:00.000Z']);
  });

  it('clips to the window and drops what falls outside it', () => {
    expect(show(clipIntervals(
      [iv('2026-09-15T06:00:00Z', '2026-09-15T12:00:00Z'), iv('2026-09-16T09:00:00Z', '2026-09-16T10:00:00Z')],
      iv('2026-09-15T09:00:00Z', '2026-09-15T17:00:00Z'),
    ))).toEqual(['2026-09-15T09:00:00.000Z/2026-09-15T12:00:00.000Z']);
  });
});

// ─── The claim the module makes about itself ────────────────────────────────

describe('a slot cannot be taken twice', () => {
  /** Publish an available window and return the slot inside it. */
  async function openDiary(day: string, from = '09:00', to = '17:00') {
    await setAvailability(db, ctx, {
      coachPersonId: coachId,
      kind: 'available',
      startsAt: istInstant(day, from),
      endsAt: istInstant(day, to),
    });
  }

  it('two simultaneous bookings for one slot leave exactly one booking', async () => {
    const day = '2026-09-15';
    await openDiary(day);
    const startsAt = istInstant(day, '10:00');
    const endsAt = istInstant(day, '11:00');

    const results = await Promise.allSettled([
      book(db, ctx, { kind: 'consultation', coachPersonId: coachId, startsAt, endsAt }),
      book(db, ctx, { kind: 'consultation', coachPersonId: coachId, startsAt, endsAt }),
    ]);

    const kept = results.filter((r) => r.status === 'fulfilled');
    expect(kept).toHaveLength(1);

    // Measured against the table, not inferred from what the calls returned.
    const rows = await db.select().from(s.bookings).where(eq(s.bookings.coachPersonId, coachId));
    expect(rows.filter((r: any) => r.status === 'confirmed')).toHaveLength(1);
  });

  it('the loser is refused with a reason a person can act on, not a constraint name', async () => {
    const day = '2026-09-16';
    await openDiary(day);
    const startsAt = istInstant(day, '10:00');
    const endsAt = istInstant(day, '11:00');

    await book(db, ctx, { kind: 'consultation', coachPersonId: coachId, startsAt, endsAt });
    const err = await book(db, ctx, { kind: 'consultation', coachPersonId: coachId, startsAt, endsAt })
      .then(() => null, (e) => e);

    expect(err).not.toBeNull();
    expect(isBookingError(err)).toBe(true);
    expect(err.code).toBe('slot_taken');
    expect(String(err.message)).toMatch(/already been booked/i);
    expect(String(err.message)).toMatch(/nothing was booked twice/i);
  });

  it('survives a five-way race', async () => {
    const day = '2026-09-17';
    await openDiary(day);
    const startsAt = istInstant(day, '10:00');
    const endsAt = istInstant(day, '11:00');

    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map(() =>
        book(db, ctx, { kind: 'consultation', coachPersonId: coachId, startsAt, endsAt })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const rows = await db.select().from(s.bookings);
    const onDay = rows.filter((r: any) => istDayOf(r.startsAt) === day && r.status === 'confirmed');
    expect(onDay).toHaveLength(1);
  });

  it('frees the slot again once the booking is cancelled', async () => {
    const day = '2026-09-18';
    await openDiary(day);
    const startsAt = istInstant(day, '10:00');
    const endsAt = istInstant(day, '11:00');

    const first = await book(db, ctx, { kind: 'consultation', coachPersonId: coachId, startsAt, endsAt });
    await cancel(db, ctx, first.id, 'The member asked to move it.');

    // A cancelled booking that still blocks its own slot is how a diary fills
    // up with times nobody is coming to.
    const again = await book(db, ctx, { kind: 'consultation', coachPersonId: coachId, startsAt, endsAt });
    expect(again.id).not.toBe(first.id);
    expect(again.status).toBe('confirmed');
  });
});

describe('what a booking refuses', () => {
  it('refuses a time the coach never published', async () => {
    const err = await book(db, ctx, {
      kind: 'consultation',
      coachPersonId: coachId,
      startsAt: istInstant('2026-10-01', '10:00'),
      endsAt: istInstant('2026-10-01', '11:00'),
    }).then(() => null, (e) => e);

    expect(isBookingError(err)).toBe(true);
    expect(err.code).toBe('outside_availability');
  });

  it('refuses a booking that ends before it starts', async () => {
    const err = await book(db, ctx, {
      kind: 'consultation',
      coachPersonId: coachId,
      startsAt: istInstant('2026-09-15', '11:00'),
      endsAt: istInstant('2026-09-15', '10:00'),
    }).then(() => null, (e) => e);

    expect(isBookingError(err)).toBe(true);
    expect(err.code).toBe('bad_range');
  });

  it('refuses a kind the federation has not defined', async () => {
    const err = await book(db, ctx, {
      kind: 'birthday_party' as any,
      coachPersonId: coachId,
      startsAt: istInstant('2026-09-15', '10:00'),
      endsAt: istInstant('2026-09-15', '11:00'),
    }).then(() => null, (e) => e);

    expect(isBookingError(err)).toBe(true);
    expect(err.code).toBe('bad_kind');
    // The vocabulary is a closed list, and it is the module's, not a caller's.
    expect(BOOKING_KINDS).not.toContain('birthday_party' as any);
  });

  it('refuses a negative buffer instead of quietly widening the slot', async () => {
    const err = await book(db, ctx, {
      kind: 'consultation',
      coachPersonId: coachId,
      startsAt: istInstant('2026-09-15', '10:00'),
      endsAt: istInstant('2026-09-15', '11:00'),
      bufferBeforeMinutes: -30,
    }).then(() => null, (e) => e);

    expect(isBookingError(err)).toBe(true);
    expect(err.code).toBe('bad_buffer');
  });

  it('distinguishes a taken slot from a taken BUFFER, because they are fixed differently', async () => {
    // "That slot is free but the travel and setup buffer either side of it is
    // not" is a different message on purpose: the first needs another time, the
    // second may only need a shorter buffer.
    const day = '2026-09-19';
    await setAvailability(db, ctx, {
      coachPersonId: coachId, kind: 'available',
      startsAt: istInstant(day, '09:00'), endsAt: istInstant(day, '17:00'),
    });
    await book(db, ctx, {
      kind: 'consultation', coachPersonId: coachId,
      startsAt: istInstant(day, '10:00'), endsAt: istInstant(day, '11:00'),
    });

    // 11:00-12:00 does not overlap the booking, but a 30 minute run-up does.
    const err = await book(db, ctx, {
      kind: 'consultation', coachPersonId: coachId,
      startsAt: istInstant(day, '11:00'), endsAt: istInstant(day, '12:00'),
      bufferBeforeMinutes: 30,
    }).then(() => null, (e) => e);

    expect(isBookingError(err)).toBe(true);
    expect(err.code).toBe('slot_taken');
    expect(String(err.message)).toMatch(/buffer/i);

    // Without the buffer the same slot books, which is what makes the two
    // messages worth telling apart.
    const ok = await book(db, ctx, {
      kind: 'consultation', coachPersonId: coachId,
      startsAt: istInstant(day, '11:00'), endsAt: istInstant(day, '12:00'),
    });
    expect(ok.status).toBe('confirmed');
  });

  it('will not book over leave the coach declared inside an available block', async () => {
    const day = '2026-09-21';
    await setAvailability(db, ctx, {
      coachPersonId: coachId, kind: 'available',
      startsAt: istInstant(day, '09:00'), endsAt: istInstant(day, '17:00'),
    });
    await setAvailability(db, ctx, {
      coachPersonId: coachId, kind: 'leave',
      startsAt: istInstant(day, '12:00'), endsAt: istInstant(day, '13:00'),
      reason: 'Family commitment',
    });

    const err = await book(db, ctx, {
      kind: 'consultation', coachPersonId: coachId,
      startsAt: istInstant(day, '12:00'), endsAt: istInstant(day, '13:00'),
    }).then(() => null, (e) => e);

    expect(isBookingError(err)).toBe(true);
    expect(err.code).toBe('outside_availability');
  });
});
