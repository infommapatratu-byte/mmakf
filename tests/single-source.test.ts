// One rule, one definition.
//
// Four separate files carried their own copy of PUBLIC_EVENT_STATUSES — the
// list that decides whether a competition event is public information. Each
// copy had a comment acknowledging the duplication and arguing it was fine.
// It was not: a visibility rule that exists in four places answers differently
// in four places the day one of them is edited, and the failure is an
// unpublished event reaching the public through whichever copy was missed.
//
// A comment saying "keep these in sync" is not an enforcement mechanism. This
// file is.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  PUBLIC_EVENT_STATUSES, isPublicEventStatus, eventStatus,
} from '../src/db/competition.schema';

/** Every .ts and .astro file under src/, recursively. */
function sources(dir = 'src'): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|astro)$/.test(name)) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

const FILES = sources();
const read = (f: string) => readFileSync(f, 'utf8');

describe('the public-event visibility rule has exactly one definition', () => {
  it('is declared once, in the schema beside the enum it constrains', () => {
    const declaring = FILES.filter((f) =>
      /(export )?const PUBLIC_EVENT_STATUSES\s*[:=]/.test(read(f))
    );
    expect(declaring).toEqual(['src/db/competition.schema.ts']);
  });

  it('no file writes the status list out by hand', () => {
    // The signature of a hand-written copy: 'published' and 'results_final' as
    // adjacent string literals in a list, outside the schema.
    const offenders = FILES.filter((f) => {
      if (f === 'src/db/competition.schema.ts') return false;
      const src = read(f);
      // The signature of a restated list is the eight public statuses written
      // out IN ORDER. Loose matching also flags the legal-transition map in
      // src/db/competition.ts, which legitimately names several of them.
      const seq = PUBLIC_EVENT_STATUSES
        .map((x) => "'" + x + "'")
        .join("[,\s]+");
      return new RegExp(seq).test(src);
    });
    expect(offenders, 'a file restates the public-status list').toEqual([]);
  });

  it('every status in the list is a real member of the enum', () => {
    // `as const satisfies` makes this a compile error too; asserting it here
    // means the guard survives someone loosening the type annotation.
    for (const st of PUBLIC_EVENT_STATUSES) {
      expect(eventStatus.enumValues, `${st} is not an event status`).toContain(st);
    }
  });

  it('withholds every status the federation has not published', () => {
    // Named explicitly rather than derived, so adding a new internal status to
    // the enum makes somebody decide about it.
    for (const internal of ['draft', 'technical_review', 'sanction_review', 'approved']) {
      expect(isPublicEventStatus(internal), `${internal} is publicly visible`).toBe(false);
    }
  });

  it('the predicate agrees with the list', () => {
    for (const st of eventStatus.enumValues) {
      expect(isPublicEventStatus(st)).toBe((PUBLIC_EVENT_STATUSES as readonly string[]).includes(st));
    }
  });

  it('cancelled and postponed are not public, because they are not events', () => {
    // They exist in the enum and are deliberately absent: a cancelled event is
    // not "published", and a surface listing it as current would send somebody
    // to a venue.
    expect(isPublicEventStatus('cancelled')).toBe(false);
    expect(isPublicEventStatus('postponed')).toBe(false);
  });
});
