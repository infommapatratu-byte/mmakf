// Moving the headquarters' published hours out of a string and into the engine.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS IS FOR, AND WHY IT IS NOT A SCRIPT
// ═══════════════════════════════════════════════════════════════════════════
//
// The federation's opening hours have lived in two English sentences on the
// editorial record since the site was built:
//
//     federation.contact.hours       'Mon–Sat · 06:00–09:00 & 17:00–20:00 IST'
//     federation.contact.hoursSunday 'Sun · Summer 06:00–10:00 & 15:00–18:00 ·
//                                     Winter 08:00–11:30 & 16:00–18:30 IST'
//
// Migration 0032 gives those facts a home with structure. This module carries
// the EXISTING VALUES across. It does not invent hours and it does not correct
// them — whatever the federation last typed at /admin is what it reads and what
// it stores.
//
// It is a module and not a command-line script for a reason that is about
// accountability rather than convenience: `schedule_versions` REFUSES a
// published row with no publisher, so somebody's name goes onto this change. A
// script picks "whichever national administrator the query returned first",
// which is a name on a record belonging to a person who was not there. Run from
// the admin console, the publisher is the administrator who clicked, their
// authority is checked by the same RBAC every other change goes through, and
// the audit row says what they were doing.
//
// ═══════════════════════════════════════════════════════════════════════════
// FOUR REFUSALS, AND EACH ONE IS THE POINT
// ═══════════════════════════════════════════════════════════════════════════
//
//  1. IT WILL NOT PUT THESE HOURS AT NATIONAL SCOPE. A schedule owned by the
//     national federation is INHERITED by every unit that has configured
//     nothing — which would publish Patratu's clock as the default for every
//     affiliated club in the country. That is the exact defect the engine was
//     built to end, so this requires a dojo to attach them to.
//
//  2. IT WILL NOT TOUCH THE EDITORIAL RECORD. The two strings stay exactly
//     where they are. The pages prefer the engine when it has an answer and
//     fall back to the strings when it does not, so nothing goes dark between
//     the migration and somebody checking the rendering. Deleting the source
//     before the destination is proven is how a federation loses its own
//     opening hours.
//
//  3. IT WILL NOT OVERWRITE A SCHEDULE SOMEBODY HAS ALREADY CONFIGURED. If the
//     target dojo already has a live operating schedule, `planMigration()`
//     returns `blocked` and `applyMigration()` refuses. An administrator's
//     Tuesday afternoon is not this module's to discard.
//
//  4. IT WILL NOT GUESS A CLASS LENGTH. The `schedule` array on the editorial
//     record carries a START time and no end — '6:00 AM', not '6:00–7:30 AM'.
//     A class record needs both, and how long a class runs is federation policy
//     nobody has set, so those rows are REPORTED and not migrated. Inventing
//     "an hour, probably" would put a duration on the federation's timetable
//     that nobody decided — the same refusal src/db/booking.ts makes about
//     session length, notice period and cancellation windows.
//
// ═══════════════════════════════════════════════════════════════════════════
// SEASON DATES
// ═══════════════════════════════════════════════════════════════════════════
//
// The strings say 'Summer' and 'Winter' and give no dates at all, so dates have
// to come from somewhere. `DIRECTIVE_SEASONS` below holds the ones stated as an
// EXAMPLE in the federation's own written instruction, and every surface that
// uses them is expected to show them as an assumption rather than a fact. They
// are editable afterwards in one place: moving a season moves every rule bound
// to it.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE PARSER LIVES HERE AND NOWHERE ELSE
// ═══════════════════════════════════════════════════════════════════════════
//
// src/db/scheduling.ts must never learn to read English opening hours. This is
// a ONE-WAY migration of a legacy representation; a parser inside the engine
// would become the path by which prose kept being stored, and six months later
// somebody would be adding a case for 'Mon-Sat mornings only (except holidays)'.

import { and, eq } from 'drizzle-orm';
import * as s from '@/db/schema';
import * as sch from '@/db/scheduling.schema';
import {
  createSchedule, defineSeason, draftVersion, publishVersion,
  SchedulingError, type IsoDate, type RuleInput, type Wall,
} from '@/db/scheduling';
import { type AuditContext } from '@/db/federation';

type DB = any;

/**
 * The season windows stated as an example in the federation's instruction.
 *
 * NOT a fact this codebase established, and every surface that offers them is
 * expected to say so. They exist as a starting point an administrator adjusts,
 * because the alternative — asking somebody to type four dates before they can
 * see anything at all — is how a migration does not get run.
 */
export const DIRECTIVE_SEASONS = [
  { code: 'summer', name: 'Summer', startsOn: '2026-04-01', endsOn: '2026-09-30' },
  { code: 'winter', name: 'Winter', startsOn: '2026-10-01', endsOn: '2027-03-31' },
] as const;

// ─── Parsing ────────────────────────────────────────────────────────────────

const DAY_TOKENS: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};
const DASH = /[–—-]/;

export interface ParsedWindow { opensAt: Wall; closesAt: Wall }
export interface ParsedGroup { season: string | null; windows: ParsedWindow[] }
export interface ParsedHours { days: number[]; groups: ParsedGroup[] }

/** 'Mon–Sat' → [1..6]; 'Sun' → [7]; 'Mon, Wed, Fri' → [1,3,5]. */
function parseDays(token: string): number[] {
  const text = token.trim().toLowerCase();
  if (text.includes(',')) {
    return text.split(',').map((t) => {
      const day = DAY_TOKENS[t.trim().slice(0, 3)];
      if (!day) throw new SchedulingError('unparsable_hours', `${JSON.stringify(t.trim())} is not a day I recognise.`);
      return day;
    });
  }
  const parts = text.split(DASH).map((t) => t.trim()).filter(Boolean);
  const from = DAY_TOKENS[parts[0]?.slice(0, 3) ?? ''];
  if (!from) throw new SchedulingError('unparsable_hours', `${JSON.stringify(token)} is not a day I recognise.`);
  if (parts.length === 1) return [from];
  const to = DAY_TOKENS[parts[1].slice(0, 3)];
  if (!to) throw new SchedulingError('unparsable_hours', `${JSON.stringify(token)} is not a day span I recognise.`);
  if (to < from) {
    throw new SchedulingError('unparsable_hours', `${JSON.stringify(token)} runs backwards through the week.`);
  }
  const out: number[] = [];
  for (let d = from; d <= to; d++) out.push(d);
  return out;
}

/** '06:00–09:00 & 17:00–20:00' → two windows. Anything else throws. */
function parseWindows(token: string): ParsedWindow[] {
  return token.split('&').map((chunk) => {
    const times = chunk.trim().match(/([01]?\d|2[0-3]):([0-5]\d)/g);
    if (!times || times.length !== 2) {
      throw new SchedulingError(
        'unparsable_hours',
        `I expected two HH:MM times in ${JSON.stringify(chunk.trim())} and found ${times?.length ?? 0}.`
      );
    }
    const pad = (t: string) => (t.length === 4 ? `0${t}` : t);
    const [opensAt, closesAt] = times.map(pad) as [Wall, Wall];
    if (closesAt <= opensAt) {
      throw new SchedulingError('unparsable_hours', `${opensAt}–${closesAt} ends before it starts.`);
    }
    return { opensAt, closesAt };
  });
}

/**
 * 'Mon–Sat · 06:00–09:00 & 17:00–20:00 IST', and the seasonal Sunday form.
 *
 * Everything the parser does not understand is THROWN, never guessed at. A
 * mis-parsed opening time sends somebody to a locked dojo, which is the failure
 * the whole engine exists to prevent — so a string it cannot read leaves the
 * federation with the string it already had, and a message saying which part of
 * it was unreadable.
 */
export function parseHoursLine(raw: unknown): ParsedHours | null {
  const text = String(raw ?? '')
    .replace(/\b(IST|UTC|GMT)\b/gi, '')
    .replace(/ /g, ' ')
    .trim();
  if (!text) return null;

  const segments = text.split('·').map((t) => t.trim()).filter(Boolean);
  if (segments.length < 2) {
    throw new SchedulingError(
      'unparsable_hours',
      `I expected "<days> · <times>" and received ${JSON.stringify(String(raw))}.`
    );
  }

  const days = parseDays(segments[0]);
  const groups: ParsedGroup[] = [];
  for (const segment of segments.slice(1)) {
    // A season prefix is a word before the first digit — 'Summer 06:00–10:00'.
    const seasonMatch = segment.match(/^([A-Za-z]+)\s+(?=\d)/);
    if (seasonMatch) {
      groups.push({ season: seasonMatch[1], windows: parseWindows(segment.slice(seasonMatch[0].length)) });
    } else {
      groups.push({ season: null, windows: parseWindows(segment) });
    }
  }
  return { days, groups };
}

// ─── The plan ───────────────────────────────────────────────────────────────

export interface SeasonWindow { code: string; name: string; startsOn: IsoDate; endsOn: IsoDate }

export interface MigrationPlan {
  /** Non-empty when the migration must not run. Each entry says why. */
  blocked: string[];
  dojoId: number | null;
  dojoName: string | null;
  timezone: string;
  /** The strings as read, so a reviewer can compare them with the rules below. */
  sources: Array<{ field: string; value: string }>;
  seasons: SeasonWindow[];
  /** True when a season of that code already exists and will be left alone. */
  seasonsAlreadyDefined: string[];
  rules: RuleInput[];
  effectiveFrom: IsoDate;
  /**
   * Timetable rows that cannot become classes because they record no finish
   * time. Reported, never migrated — see refusal 4.
   */
  classesNotMigrated: Array<{ day: string; time: string; description: string; instructor: string; mode: string }>;
  /** Anything the parser could not read, with the reason. */
  unreadable: Array<{ field: string; value: string; reason: string }>;
}

/**
 * Work out exactly what would be written, and write nothing.
 *
 * Returning a plan rather than doing it is what makes the admin surface honest:
 * an administrator sees the days, the windows and the season dates BEFORE
 * anything is stored, and can compare them line by line against the two strings
 * they already know. A migration whose first output is "done" is one nobody can
 * check.
 */
export async function planMigration(
  db: DB,
  input: {
    federation: any;
    /** The editorial `schedule` array, for the class report. Optional. */
    timetable?: any[] | null;
    dojoId: number | null;
    timezone?: string;
    seasons?: SeasonWindow[];
  }
): Promise<MigrationPlan> {
  const seasons: SeasonWindow[] = (input.seasons ?? DIRECTIVE_SEASONS.map((x) => ({ ...x })));
  const timezone = input.timezone ?? 'Asia/Kolkata';
  const blocked: string[] = [];
  const unreadable: MigrationPlan['unreadable'] = [];

  const hours = String(input.federation?.contact?.hours ?? '');
  const hoursSunday = String(input.federation?.contact?.hoursSunday ?? '');
  const sources = [
    { field: 'federation.contact.hours', value: hours },
    { field: 'federation.contact.hoursSunday', value: hoursSunday },
  ].filter((x) => x.value);

  if (!sources.length) {
    blocked.push('The federation record publishes no hours at all, so there is nothing to migrate. Entering them in the schedule editor is the way in.');
  }

  let dojoName: string | null = null;
  if (input.dojoId == null) {
    blocked.push(
      'These are the HEADQUARTERS\' hours and they need a club to belong to. They will not be stored at ' +
      'national scope: a national schedule is inherited by every unit that has configured nothing, which ' +
      'would publish one dojo\'s clock as the timetable of every affiliated club in the country.'
    );
  } else {
    const [dojo] = await db.select({ id: s.dojos.id, name: s.dojos.name })
      .from(s.dojos).where(eq(s.dojos.id, input.dojoId)).limit(1);
    if (!dojo) blocked.push(`No dojo ${input.dojoId} is on the register.`);
    else dojoName = dojo.name;

    const live = await db.select({ id: sch.schedules.id, code: sch.schedules.code, name: sch.schedules.name })
      .from(sch.schedules).where(and(
        eq(sch.schedules.ownerScope, 'dojo'),
        eq(sch.schedules.ownerId, input.dojoId),
        eq(sch.schedules.purpose, 'operating'),
        eq(sch.schedules.status, 'active')
      ));
    if (live.length) {
      blocked.push(
        `${dojo?.name ?? 'That club'} already has an operating schedule (${live[0].code}). This migration will not ` +
        'overwrite it — whatever is in there was put there by an administrator. Edit it in the schedule editor instead.'
      );
    }
  }

  // ── Parse ────────────────────────────────────────────────────────────────
  const parsed: Array<{ field: string; line: ParsedHours }> = [];
  for (const src of sources) {
    try {
      const line = parseHoursLine(src.value);
      if (line) parsed.push({ field: src.field, line });
    } catch (err: any) {
      unreadable.push({ field: src.field, value: src.value, reason: err?.message ?? String(err) });
    }
  }
  if (unreadable.length) {
    blocked.push(
      'One of the published strings is not in a shape this migration can read. It has not been changed. ' +
      'Either correct it at /admin so it reads like "Mon–Sat · 06:00–09:00 & 17:00–20:00 IST", or enter the ' +
      'hours directly in the schedule editor, which needs no parsing at all.'
    );
  }

  const seasonByName = new Map(seasons.map((x) => [x.name.toLowerCase(), x]));
  for (const p of parsed) {
    for (const group of p.line.groups) {
      if (group.season && !seasonByName.has(group.season.toLowerCase())) {
        blocked.push(
          `${p.field} names a season called "${group.season}", which is not one of the seasons this migration ` +
          `defines (${seasons.map((x) => x.name).join(', ')}). Define it first, or correct the string.`
        );
      }
    }
  }

  // ── Rules ────────────────────────────────────────────────────────────────
  // Season ids are not known until the seasons are written, so the plan carries
  // the season CODE in `notes` and applyMigration() resolves it. A plan that
  // carried ids would be a plan that had already written something.
  const rules: RuleInput[] = [];
  for (const p of parsed) {
    for (const day of p.line.days) {
      let order = 0;
      for (const group of p.line.groups) {
        const season = group.season ? seasonByName.get(group.season.toLowerCase()) : null;
        for (const w of group.windows) {
          rules.push({
            dayOfWeek: day,
            opensAt: w.opensAt,
            closesAt: w.closesAt,
            seasonId: null,
            label: season ? `${season.name} session ${order + 1}` : `Session ${order + 1}`,
            displayOrder: order,
            notes: season ? `season:${season.code}` : null,
          });
          order++;
        }
      }
    }
  }
  if (!rules.length && !blocked.length) {
    blocked.push('The published strings produced no rules at all, which means nothing would be stored.');
  }

  // ── Refusal 4 ────────────────────────────────────────────────────────────
  const classesNotMigrated = (input.timetable ?? [])
    .filter((r: any) => (String(r?.t ?? '').match(/\d{1,2}:\d{2}/g) ?? []).length < 2)
    .map((r: any) => ({
      day: String(r?.day ?? ''), time: String(r?.t ?? ''),
      description: String(r?.d ?? ''), instructor: String(r?.ins ?? ''), mode: String(r?.mode ?? ''),
    }));

  // Effective from the earliest season start, so the timetable covers the dates
  // the seasons it references already cover. NOT "today": a version starting
  // today cannot answer a question about last month, and being able to answer
  // that is the entire reason versions are effective-dated.
  const effectiveFrom = seasons.map((x) => x.startsOn).sort()[0] ?? '2026-01-01';

  const alreadyDefined: string[] = [];
  for (const season of seasons) {
    const [hit] = await db.select({ id: sch.seasons.id }).from(sch.seasons).where(and(
      eq(sch.seasons.ownerScope, 'national'), eq(sch.seasons.code, season.code)
    )).limit(1);
    if (hit) alreadyDefined.push(season.code);
  }

  return {
    blocked, dojoId: input.dojoId, dojoName, timezone,
    sources, seasons, seasonsAlreadyDefined: alreadyDefined,
    rules, effectiveFrom, classesNotMigrated, unreadable,
  };
}

export interface MigrationResult {
  scheduleId: number;
  scheduleCode: string;
  versionId: number;
  rules: number;
  seasonsCreated: string[];
  seasonsReused: string[];
}

/**
 * Carry out a plan.
 *
 * Re-plans from the same inputs before writing rather than trusting the plan it
 * was handed: a plan is a page an administrator has been looking at, and the
 * world can have changed while they read it — most obviously by somebody else
 * configuring the same club. The re-plan is what makes the "will not overwrite"
 * refusal true at the moment of writing rather than at the moment of rendering.
 */
export async function applyMigration(
  db: DB, ctx: AuditContext,
  input: Parameters<typeof planMigration>[1]
): Promise<MigrationResult> {
  const plan = await planMigration(db, input);
  if (plan.blocked.length) {
    throw new SchedulingError('migration_blocked', plan.blocked.join(' '));
  }

  const seasonsCreated: string[] = [];
  const seasonsReused: string[] = [];
  const seasonIdByCode = new Map<string, number>();

  for (const season of plan.seasons) {
    const [existing] = await db.select().from(sch.seasons).where(and(
      eq(sch.seasons.ownerScope, 'national'), eq(sch.seasons.code, season.code)
    )).limit(1);
    if (existing) {
      seasonIdByCode.set(season.code, existing.id);
      seasonsReused.push(season.code);
      continue;
    }
    const created = await defineSeason(db, ctx, {
      code: season.code, name: season.name,
      owner: { scope: 'national', id: null },
      startsOn: season.startsOn, endsOn: season.endsOn,
      activate: true,
      notes: 'Created when the published headquarters hours were migrated into the engine. The dates came from the example in the federation instruction and are editable.',
    });
    seasonIdByCode.set(season.code, created.id);
    seasonsCreated.push(season.code);
  }

  const rules: RuleInput[] = plan.rules.map((r) => {
    const code = typeof r.notes === 'string' && r.notes.startsWith('season:') ? r.notes.slice(7) : null;
    if (!code) return { ...r, notes: null };
    const id = seasonIdByCode.get(code);
    if (!id) throw new SchedulingError('migration_blocked', `No season was created for code ${code}.`);
    return { ...r, seasonId: id, notes: null };
  });

  const schedule = await createSchedule(db, ctx, {
    name: `${plan.dojoName} — opening hours`,
    purpose: 'operating',
    owner: { scope: 'dojo', id: plan.dojoId as number },
    timezone: plan.timezone,
    notes: 'Migrated from federation.contact.hours and federation.contact.hoursSunday. The editorial strings were left in place.',
  });

  const version = await draftVersion(db, ctx, schedule.id, {
    effectiveFrom: plan.effectiveFrom,
    reason: 'Initial migration of the published headquarters hours',
    rules,
  });

  await publishVersion(
    db, ctx, version.id,
    'Migrated the published headquarters hours from the editorial record into the scheduling engine. The values were not changed.'
  );

  return {
    scheduleId: schedule.id, scheduleCode: schedule.code,
    versionId: version.id, rules: rules.length,
    seasonsCreated, seasonsReused,
  };
}
