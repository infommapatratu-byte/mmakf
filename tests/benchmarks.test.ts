// The benchmark store, the normalisation that refuses, and the wall between a
// recommendation and a price.
//
// Three things are being proved here, and only the second is arithmetic:
//
//  1. NOTHING WAS INVENTED. The store holds thirteen rows because the
//     federation supplied thirteen, every one carries its attribution, and the
//     columns nobody supplied are null rather than plausible.
//
//  2. INCOMPARABLE THINGS ARE REFUSED, NOT AVERAGED. A club fee and an athlete
//     fee, an annual subscription and a monthly training charge, USD and GBP —
//     each produces a reason instead of a number.
//
//  3. THE RECOMMENDATION ENGINE CANNOT SET A PRICE. Not "does not"; cannot. It
//     is handed no database, and the test reads its source to say so.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  normalise, comparable, unitLabel, unitKey, parseUnit, formatBenchmarkAmount,
  listBenchmarks, listBenchmarkSources, recordSource, recordBenchmark,
  setBenchmarkStatus, takeSnapshot, readSnapshot, recentSnapshots,
  toObservation, isBenchmarkError, canReadBenchmarks,
  type BenchmarkObservation, type BenchmarkUnit,
} from '../src/db/benchmarks';
import { recommendFee, recommendFromSnapshot } from '../src/db/fee-recommendation';
import type { Principal } from '../src/lib/rbac';

let db: any;
let pg: any;

const finance: Principal = {
  userId: 1, label: 'finance',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const auditor: Principal = {
  userId: 2, label: 'auditor',
  bindings: [{ role: 'AUDITOR', scopeType: 'national', scopeId: null }],
};
const director: Principal = {
  userId: 3, label: 'director',
  bindings: [{ role: 'TRAINING_DIRECTOR', scopeType: 'national', scopeId: null }],
};
/** A client. PART AC: never sees MMAKF's pricing preparation. */
const client: Principal = {
  userId: 4, label: 'client',
  bindings: [{ role: 'INSTITUTION_ADMIN', scopeType: 'institution', scopeId: 1 }],
};
const athlete: Principal = {
  userId: 5, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};

const ctx = { principal: finance };
const auditCtx = { principal: auditor };

/** Per person, per year — the unit most of the seed expresses in. */
const PERSON_YEAR: BenchmarkUnit = { subject: 'person', period: 'per_year' };

beforeAll(async () => {
  const client_ = new PGlite();
  pg = client_;
  db = drizzle(client_, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client_.exec(st.trim());
    }
  }
  // recorded_by_user_id and taken_by_user_id are real foreign keys.
  await db.insert(s.users).values([
    { id: 1, email: 'finance@mmakf.in', status: 'active' },
    { id: 2, email: 'auditor@mmakf.in', status: 'active' },
    { id: 3, email: 'director@mmakf.in', status: 'active' },
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. NOTHING WAS INVENTED
// ═══════════════════════════════════════════════════════════════════════════

describe('the store holds what the federation supplied, and not one row more', () => {
  it('seeded exactly the thirteen supplied figures', async () => {
    const rows = await db.select().from(s.feeBenchmarks);
    // Thirteen: three USA Karate, two IBF Great Britain, six WUKF, two Japan
    // Karate-Do. If this number ever grows without the supplied list growing,
    // something has been invented.
    expect(rows).toHaveLength(13);

    const byOrg: Record<string, number> = {};
    for (const r of rows) byOrg[r.organisation] = (byOrg[r.organisation] ?? 0) + 1;
    expect(byOrg).toEqual({
      'USA Karate': 3,
      'IBF Great Britain': 2,
      'WUKF': 6,
      'Japan Karate-Do': 2,
    });
  });

  it('holds no MMAKF figure at all', async () => {
    const rows = await db.select().from(s.feeBenchmarks);
    expect(rows.filter((r: any) => /mmakf|modern martial/i.test(r.organisation))).toEqual([]);
    // And the thing it must never have become: MMAKF still publishes no fee.
    expect(await db.select().from(s.feeRules)).toEqual([]);
    expect(await db.select().from(s.feeFrameworks)).toEqual([]);
  });

  it('gives every figure a source, a source type and a confidence', async () => {
    const rows = await db.select().from(s.feeBenchmarks);
    for (const r of rows) {
      expect(r.sourceId, `${r.code} has no source`).toBeTruthy();
      expect(r.sourceTitle, `${r.code} has no source title`).toBeTruthy();
      expect(r.sourceType).toBe('federation_supplied');
      expect(r.confidence).toBe('reported');
      expect(r.retrievedAt).toBeTruthy();
      // The unaltered wording, kept beside the parsed columns.
      expect(r.amountText, `${r.code} lost the figure as supplied`).toMatch(/^(USD|GBP|EUR) \d/);
    }
  });

  it('invents no URL and no publication date, because none was supplied', async () => {
    const rows = await db.select().from(s.feeBenchmarks);
    // THE POINT OF THE WHOLE TRACK. A plausible URL beside a real federation's
    // name is a fabricated claim about a third party, and it is worse than a
    // fabricated claim about MMAKF because the party it harms never agreed to
    // be in this database. Null is the true answer and this asserts it stays.
    expect(rows.every((r: any) => r.sourceUrl === null)).toBe(true);
    expect(rows.every((r: any) => r.sourceDate === null)).toBe(true);

    const sources = await db.select().from(s.feeBenchmarkSources);
    expect(sources).toHaveLength(4);
    expect(sources.every((x: any) => x.url === null && x.publishedOn === null)).toBe(true);
    expect(sources.every((x: any) => x.sourceType === 'federation_supplied')).toBe(true);
  });

  it('leaves country null where the supplier named none', async () => {
    const rows = await db.select().from(s.feeBenchmarks);
    const wukf = rows.filter((r: any) => r.organisation === 'WUKF');
    const japan = rows.filter((r: any) => r.organisation === 'Japan Karate-Do');

    // A world union has no single country, and the office it registers in is
    // not the market it prices for.
    expect(wukf.every((r: any) => r.country === null)).toBe(true);
    // "Japan Karate-Do" contains the word Japan. That is a name, not a fact
    // about where the figures apply, and the prices are quoted in USD.
    expect(japan.every((r: any) => r.country === null)).toBe(true);

    expect(rows.filter((r: any) => r.organisation === 'USA Karate').every((r: any) => r.country === 'US')).toBe(true);
    expect(rows.filter((r: any) => r.organisation === 'IBF Great Britain').every((r: any) => r.country === 'GB')).toBe(true);
  });

  it('records the three lines that came without a period as unstated', async () => {
    const rows = await db.select().from(s.feeBenchmarks).where(eq(s.feeBenchmarks.frequency, 'unstated'));
    expect(rows.map((r: any) => r.code).sort()).toEqual([
      'BMK-WUKF-COACH',
      'BMK-WUKF-DAN-HOMOLOGATION',
      'BMK-WUKF-PROTEST',
    ]);
    // "EUR 200" for a protest is almost certainly per protest. Almost certainly
    // is not a term of somebody else's fee schedule.
    for (const r of rows) expect(r.notes).toMatch(/no period|not been inferred|unstated/i);
  });

  it('stores every amount as an integer in its own currency, never in paise', async () => {
    const rows = await db.select().from(s.feeBenchmarks);
    for (const r of rows) {
      expect(Number.isInteger(r.amountMinor), `${r.code} is not an integer`).toBe(true);
      expect(r.currency).toMatch(/^(USD|GBP|EUR)$/);
      expect(r.currency).not.toBe('INR');
    }
    const [athleteRow] = rows.filter((r: any) => r.code === 'BMK-USA-KARATE-MEMBERSHIP-ATHLETE');
    expect(athleteRow.amountMinor).toBe(6000);       // USD 60.00 in cents
    expect(athleteRow.amountText).toBe('USD 60/year');
  });

  it('seeds the same thirteen when the migration is applied twice', async () => {
    // A migration runner that retries a partially-applied file must not double
    // the evidence: fourteen rows where thirteen figures exist would make every
    // median and every sample size wrong, quietly and permanently.
    const halves = readFileSync('drizzle/0014_fee_benchmarks.sql', 'utf8')
      .split('--> statement-breakpoint')
      .filter((st) => /INSERT INTO/.test(st));
    expect(halves).toHaveLength(2);
    for (const st of halves) await pg.exec(st.trim());

    expect(await db.select().from(s.feeBenchmarks)).toHaveLength(13);
    expect(await db.select().from(s.feeBenchmarkSources)).toHaveLength(4);
  });

  it('renders a benchmark in its own currency, never with a rupee sign', () => {
    expect(formatBenchmarkAmount(6000, 'USD')).toBe('USD 60.00');
    expect(formatBenchmarkAmount(222000, 'USD')).toBe('USD 2,220.00');
    expect(formatBenchmarkAmount(1500, 'GBP')).toBe('GBP 15.00');
    expect(formatBenchmarkAmount(6000, 'USD')).not.toContain('₹');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. INCOMPARABLE THINGS ARE REFUSED
// ═══════════════════════════════════════════════════════════════════════════

/** Load one seeded observation by code. */
async function obs(code: string): Promise<BenchmarkObservation> {
  const [row] = await db.select().from(s.feeBenchmarks).where(eq(s.feeBenchmarks.code, code)).limit(1);
  return toObservation(row);
}

describe('normalise() converts what is exact and refuses what is not', () => {
  it('leaves an annual figure alone when the target is per year', async () => {
    const r = normalise(await obs('BMK-USA-KARATE-MEMBERSHIP-ATHLETE'), PERSON_YEAR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.amountMinor).toBe(6000);
    expect(r.factorPpm).toBe(1_000_000);
    expect(r.currency).toBe('USD');
  });

  it('multiplies a monthly training fee to a yearly cost, exactly', async () => {
    // USD 185/month is USD 2,220 a year. Twelve months are a year by
    // definition, so this conversion invents nothing.
    const r = normalise(await obs('BMK-JAPAN-KARATE-DO-TRAINING-TWICE-WEEKLY'), PERSON_YEAR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.amountMinor).toBe(222000);
    expect(r.factorPpm).toBe(12_000_000);
    expect(r.because).toMatch(/Twelve months are a year exactly/);
  });

  it('REFUSES to divide an annual fee into a monthly one', async () => {
    // The asymmetry is the argument. USD 60 a year is not USD 5 a month; nobody
    // pays USD 5 a month, and putting that beside a real monthly training
    // price is the comparison the store exists to prevent.
    const r = normalise(await obs('BMK-USA-KARATE-MEMBERSHIP-ATHLETE'), { subject: 'person', period: 'per_month' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('no_downward_period_conversion');
    expect(r.reason).toMatch(/accounting average/i);
  });

  it('REFUSES to put a club fee beside an athlete fee', async () => {
    // Both are USD, both are annual, and their mean describes nothing that
    // exists. This is the failure a single `frequency` column cannot see.
    const club = await obs('BMK-USA-KARATE-CLUB');
    const person = await obs('BMK-USA-KARATE-MEMBERSHIP-ATHLETE');

    const r = normalise(club, PERSON_YEAR);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('subject_mismatch');
    expect(r.reason).toMatch(/membership or squad size/i);

    expect(comparable(club, person).ok).toBe(false);
  });

  it('REFUSES a figure whose period the source never stated', async () => {
    const r = normalise(await obs('BMK-WUKF-COACH'), PERSON_YEAR);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('period_unstated');
    expect(r.reason).toMatch(/gave an amount \(EUR 50\) and no period/);
  });

  it('REFUSES to relate an entry fee to a yearly subscription', async () => {
    // EUR 45 per event becomes a yearly figure only if somebody supplies how
    // many events a year, and nobody did.
    const r = normalise(await obs('BMK-WUKF-COMPETITION-INDIVIDUAL'), PERSON_YEAR);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('occurrence_and_period');
    expect(r.reason).toMatch(/how many occasions/i);
  });

  it('REFUSES a team entry fee against an individual one', async () => {
    const team = await obs('BMK-WUKF-COMPETITION-TEAM');
    const individual = await obs('BMK-WUKF-COMPETITION-INDIVIDUAL');
    const verdict = comparable(team, individual);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/per team|per person/);
  });

  it('REFUSES across currencies rather than inventing a rate', async () => {
    const usa = await obs('BMK-USA-KARATE-MEMBERSHIP-ATHLETE');
    const ibf = await obs('BMK-IBF-GB-MEMBERSHIP-ADULT');
    const verdict = comparable(usa, ibf);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/exchange rate carrying the date/i);
  });

  it('REFUSES a membership against a training fee, on service before units', async () => {
    // The brief's own example. They are not two prices for one thing.
    const membership = await obs('BMK-USA-KARATE-MEMBERSHIP-ATHLETE');
    const training = await obs('BMK-JAPAN-KARATE-DO-TRAINING-TWICE-WEEKLY');
    const verdict = comparable(membership, training);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/different services/i);
  });

  it('accepts the one pairing that genuinely is comparable', async () => {
    const adult = await obs('BMK-IBF-GB-MEMBERSHIP-ADULT');
    const junior = await obs('BMK-IBF-GB-MEMBERSHIP-JUNIOR');
    expect(comparable(adult, junior).ok).toBe(true);
  });

  it('says the unit in words, both dimensions, always', () => {
    expect(unitLabel(PERSON_YEAR)).toBe('per person, per year');
    expect(unitLabel({ subject: 'club', period: 'per_year' })).toBe('per club, per year');
    expect(unitKey(PERSON_YEAR)).toBe('person:per_year');
    expect(parseUnit('team:per_event')).toEqual({ subject: 'team', period: 'per_event' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE RECOMMENDATION IS A DRAFT, AND IT SHOWS ITS WORKING
// ═══════════════════════════════════════════════════════════════════════════

describe('the recommendation engine', () => {
  it('returns a median, a range, a sample size and the reasons', async () => {
    const all = await listBenchmarks(db, finance, {});
    const rec = recommendFee(all, {
      service: 'membership', currency: 'USD', unit: PERSON_YEAR,
      market: { country: 'IN', label: 'India' }, asAt: '2026-08-17',
    });

    // USA Karate athlete USD 60 and coach/official USD 75. The club fee is not
    // in: it is levied on a club.
    expect(rec.sampleSize).toBe(2);
    expect(rec.median!.amountMinor).toBe(6750);       // midpoint of 6000 and 7500
    expect(rec.median!.display).toBe('USD 67.50');
    expect(rec.low!.amountMinor).toBe(6000);
    expect(rec.high!.amountMinor).toBe(7500);
    expect(rec.organisations).toEqual(['USA Karate']);
    expect(rec.reasons.join(' ')).toMatch(/Median USD 67\.50 per person, per year/);
  });

  it('is a DRAFT and says so in its own shape', async () => {
    const all = await listBenchmarks(db, finance, {});
    const rec = recommendFee(all, { service: 'membership', currency: 'GBP', unit: PERSON_YEAR });
    expect(rec.kind).toBe('fee_recommendation_draft');
    expect(rec.status).toBe('draft');
    expect(rec.isMmakfFee).toBe(false);
    expect(rec.approval.required).toBe(true);
    expect(rec.approval.approvedByUserId).toBeNull();
    expect(rec.approval.route).toMatch(/second person publishing/i);
    expect(rec.notice).toMatch(/Not an MMAKF fee/);
  });

  it('carries its refusals with it, rather than hiding them', async () => {
    const all = await listBenchmarks(db, finance, {});
    const rec = recommendFee(all, { service: 'membership', currency: 'USD', unit: PERSON_YEAR });

    // Eleven of the thirteen do not answer this question, and each says why.
    expect(rec.refusals).toHaveLength(11);
    // The club fee is refused on SERVICE first, and the order matters: club
    // affiliation and individual membership are different products, and
    // reporting it as a unit problem would be the wrong diagnosis to hand
    // somebody. Its subject problem is exercised below, where the service does
    // match.
    const club = rec.refusals.find((r) => r.benchmarkCode === 'BMK-USA-KARATE-CLUB');
    expect(club!.code).toBe('service_mismatch');
    const gbp = rec.refusals.find((r) => r.benchmarkCode === 'BMK-IBF-GB-MEMBERSHIP-ADULT');
    expect(gbp!.code).toBe('currency_mismatch');
    const training = rec.refusals.find((r) => r.benchmarkCode === 'BMK-JAPAN-KARATE-DO-TRAINING-TWICE-WEEKLY');
    expect(training!.code).toBe('service_mismatch');
    expect(rec.cautions.join(' ')).toMatch(/left out and the reasons are recorded/);
  });

  it('refuses on SUBJECT once the service matches', async () => {
    // Ask for club affiliation but in a per-person unit. Now the service is
    // right and the only thing wrong is who the fee is levied on — which is
    // the failure a single `frequency` column cannot see.
    const all = await listBenchmarks(db, finance, {});
    const rec = recommendFee(all, { service: 'club_affiliation', currency: 'USD', unit: PERSON_YEAR });
    expect(rec.sampleSize).toBe(0);
    expect(rec.median).toBeNull();
    const club = rec.refusals.find((r) => r.benchmarkCode === 'BMK-USA-KARATE-CLUB');
    expect(club!.code).toBe('subject_mismatch');
    expect(club!.reason).toMatch(/membership or squad size/i);
  });

  it('refuses to call two observations a market', async () => {
    const all = await listBenchmarks(db, finance, {});
    const rec = recommendFee(all, { service: 'membership', currency: 'GBP', unit: PERSON_YEAR });
    expect(rec.sampleSize).toBe(2);
    expect(rec.median!.amountMinor).toBe(2000);      // midpoint of 1500 and 2500
    expect(rec.confidence).toBe('insufficient');
    expect(rec.confidenceReasons.join(' ')).toMatch(/at least three/);
  });

  it('finds the federation-supplied list cannot support ONE confident answer', async () => {
    // Worth asserting as a fact about the evidence, not a gap in the code.
    // Every service in the supplied list is either a single organisation's or
    // split across three currencies, so no question it can be asked reaches
    // even 'low'. That is the honest state of the store, and the reason the
    // brief called it a starting point rather than a price list.
    const all = await listBenchmarks(db, finance, {});
    const questions = [
      { service: 'membership', currency: 'USD' },
      { service: 'membership', currency: 'GBP' },
      { service: 'training', currency: 'USD' },
      { service: 'club_affiliation', currency: 'USD' },
    ];
    for (const q of questions) {
      const unit: BenchmarkUnit = q.service === 'club_affiliation'
        ? { subject: 'club', period: 'per_year' } : PERSON_YEAR;
      const rec = recommendFee(all, { ...q, unit });
      expect(rec.confidence, `${q.service}/${q.currency} claimed ${rec.confidence}`).toBe('insufficient');
    }
  });

  it('normalises training months into years before comparing them', async () => {
    const all = await listBenchmarks(db, finance, {});
    const rec = recommendFee(all, { service: 'training', currency: 'USD', unit: PERSON_YEAR });
    expect(rec.sampleSize).toBe(2);
    expect(rec.low!.amountMinor).toBe(222000);       // USD 185 × 12
    expect(rec.high!.amountMinor).toBe(234000);      // USD 195 × 12
    expect(rec.median!.amountMinor).toBe(228000);
    expect(rec.contributions.every((c) => c.factorPpm === 12_000_000)).toBe(true);
  });

  it('has NO NUMBER when nothing answers the question', async () => {
    const all = await listBenchmarks(db, finance, {});
    const rec = recommendFee(all, { service: 'dan_homologation', currency: 'EUR', unit: PERSON_YEAR });
    // A zero would read as "free" — the same misreading computeFee() refuses.
    expect(rec.median).toBeNull();
    expect(rec.low).toBeNull();
    expect(rec.high).toBeNull();
    expect(rec.sampleSize).toBe(0);
    expect(rec.confidence).toBe('insufficient');
    expect(rec.reasons.join(' ')).toMatch(/none has been substituted/);
  });

  it('warns that no contributing figure comes from the market it is for', async () => {
    const all = await listBenchmarks(db, finance, {});
    const rec = recommendFee(all, {
      service: 'membership', currency: 'USD', unit: PERSON_YEAR,
      market: { country: 'IN', label: 'India' },
    });
    expect(rec.cautions.join(' ')).toMatch(/Not one contributing figure comes from IN/);
  });

  it('never converts a benchmark into rupees', async () => {
    const all = await listBenchmarks(db, finance, {});
    for (const currency of ['USD', 'GBP', 'EUR', 'INR']) {
      const rec = recommendFee(all, { service: 'membership', currency, unit: PERSON_YEAR });
      expect(rec.currency).toBe(currency);
      if (rec.median) expect(rec.median.currency).toBe(currency);
      expect(rec.contributions.every((c) => c.normalised.currency === currency)).toBe(true);
    }
    // And asking in INR finds nothing, because there is no Indian evidence.
    const inr = recommendFee(all, { service: 'membership', currency: 'INR', unit: PERSON_YEAR });
    expect(inr.sampleSize).toBe(0);
    expect(inr.median).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIDENCE — the rules that keep a thin sample from sounding thick
// ═══════════════════════════════════════════════════════════════════════════

describe('confidence is capped by what the sample actually is', () => {
  /** Six figures, one organisation, all comparable. */
  const oneOrg = (n: number): BenchmarkObservation[] =>
    Array.from({ length: n }, (_, i) => toObservation({
      id: 900 + i, code: `X-${i}`, organisation: 'Single Federation',
      country: 'IN', region: 'national',
      service: 'membership', serviceLabel: 'Membership', audience: 'adult',
      amountMinor: 5000 + i * 100, currency: 'INR', currencyExponent: 2,
      amountText: `INR ${50 + i}/year`, frequency: 'per_year', subject: 'person',
      sourceTitle: 'Test', sourceType: 'official_publication', confidence: 'verified',
      status: 'included',
    }));

  it('will not call one organisation a market, however many rows it has', () => {
    const rec = recommendFee(oneOrg(9), { service: 'membership', currency: 'INR', unit: PERSON_YEAR });
    expect(rec.sampleSize).toBe(9);
    expect(rec.organisationCount).toBe(1);
    expect(rec.confidence).toBe('low');
    expect(rec.confidenceReasons.join(' ')).toMatch(/One organisation's price list is not a market/);
  });

  it('rises with breadth', () => {
    const mixed = oneOrg(6).map((o, i) => toObservation({ ...o, organisation: `Federation ${i % 3}` }));
    const rec = recommendFee(mixed, { service: 'membership', currency: 'INR', unit: PERSON_YEAR });
    expect(rec.organisationCount).toBe(3);
    expect(rec.confidence).toBe('medium');
  });

  it('steps down when the highest figure is more than three times the lowest', () => {
    const spread = oneOrg(6).map((o, i) => toObservation({
      ...o, organisation: `Federation ${i % 3}`, amountMinor: i === 5 ? 100_000 : o.amountMinor,
    }));
    const rec = recommendFee(spread, { service: 'membership', currency: 'INR', unit: PERSON_YEAR });
    expect(rec.spreadPpm).toBeGreaterThan(3_000_000);
    expect(rec.confidence).toBe('low');
    expect(rec.confidenceReasons.join(' ')).toMatch(/spread rather than a cluster/);
  });

  it('never reaches high on figures nobody has verified', () => {
    const reported = oneOrg(9).map((o, i) => toObservation({
      ...o, organisation: `Federation ${i % 4}`, confidence: 'reported',
    }));
    const rec = recommendFee(reported, { service: 'membership', currency: 'INR', unit: PERSON_YEAR });
    expect(rec.confidence).not.toBe('high');
    expect(rec.confidenceReasons.join(' ')).toMatch(/attributed but not verified/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE WALL — structural, not disciplinary
// ═══════════════════════════════════════════════════════════════════════════

describe('the recommendation engine cannot write a fee rule', () => {
  const src = readFileSync('src/db/fee-recommendation.ts', 'utf8');

  /**
   * The file with its comments removed.
   *
   * The header of that module explains the separation by NAMING the functions
   * it must not reach — addRule, publishFramework — and a token search over the
   * raw text cannot tell an explanation from a call. Stripping the prose first
   * is what lets the file argue its own case without failing its own test.
   */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/[^\n\r]*/, '')).join('\n');

  it('holds no database handle, because it imports nothing that could make one', () => {
    // Not "does not write" — CANNOT. There is no db, no schema and no query
    // builder anywhere in the module, so there is no path to guard and nothing
    // for a future edit to quietly re-open.
    expect(code, 'the engine imports the schema').not.toMatch(/from\s+['"]@\/db\/schema['"]/);
    expect(code, 'the engine imports a query builder').not.toMatch(/from\s+['"]drizzle-orm/);
    expect(code, 'the engine imports the drizzle client').not.toMatch(/from\s+['"]@\/db['"]/);
  });

  it('does not import the fee-authoring module, because an import is half a call', () => {
    // addRule() and publishFramework() live in src/db/fees.ts. The one function
    // this engine needs from there — applyFactor() — is re-exported through
    // src/db/benchmarks.ts so that this import can stay absent.
    expect(code).not.toMatch(/from\s+['"]@\/db\/fees['"]/);
    expect(code).not.toMatch(/\bfeeRules\b|\bfee_rules\b|\baddRule\b|\bpublishFramework\b/);
    // And the explanation really is in the file, so a later reader knows the
    // absence was a decision rather than an oversight.
    expect(src).toMatch(/an import is the first half of a call/);
  });

  it('names no write verb at all', () => {
    expect(code).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(code).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
  });

  it('takes observations, not a database, in its signature', () => {
    expect(code).toMatch(/export function recommendFee\(\s*\n?\s*observations: readonly BenchmarkObservation\[\]/);
    expect(code).not.toMatch(/function\s+\w+\s*\(\s*db\b/);
  });

  it('leaves the fee framework empty after being run', async () => {
    const all = await listBenchmarks(db, finance, {});
    recommendFee(all, { service: 'membership', currency: 'USD', unit: PERSON_YEAR });
    recommendFee(all, { service: 'training', currency: 'USD', unit: PERSON_YEAR });
    // MMAKF still publishes no fee. It is the state of the system and running a
    // recommendation is not what changes it.
    expect(await db.select().from(s.feeRules)).toEqual([]);
    expect(await db.select().from(s.feeFrameworks)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORITY
// ═══════════════════════════════════════════════════════════════════════════

describe('who may see the market evidence', () => {
  it('lets finance read and write it', async () => {
    expect(canReadBenchmarks(finance)).toBe(true);
    expect((await listBenchmarks(db, finance, {})).length).toBe(13);
  });

  it('lets the training director read it and NOT add to it', async () => {
    expect((await listBenchmarks(db, director, {})).length).toBe(13);
    await expect(setBenchmarkStatus(db, { principal: director } as any, 1, 'excluded', 'no'))
      .rejects.toThrow(/Forbidden: benchmark:write/);
  });

  it('lets an auditor read it and not touch it', async () => {
    expect((await listBenchmarks(db, auditor, {})).length).toBe(13);
    await expect(recordSource(db, auditCtx as any, {
      code: 'X', organisation: 'X', title: 'X', sourceType: 'operator_entered', confidence: 'reported',
    })).rejects.toThrow(/Forbidden: benchmark:write/);
  });

  it('REFUSES an institution client entirely (PART AC)', async () => {
    // A client that can read the market evidence behind its own quotation is
    // reading MMAKF's pricing preparation.
    expect(canReadBenchmarks(client)).toBe(false);
    await expect(listBenchmarks(db, client, {})).rejects.toThrow(/Forbidden: benchmark:read/);
  });

  it('REFUSES an athlete and an anonymous caller', async () => {
    await expect(listBenchmarks(db, athlete, {})).rejects.toThrow(/Forbidden: benchmark:read/);
    await expect(listBenchmarks(db, null, {})).rejects.toThrow(/Forbidden: benchmark:read/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EXTENDING THE STORE
// ═══════════════════════════════════════════════════════════════════════════

describe('adding a benchmark keeps the attribution rules', () => {
  it('refuses an observation with no registered source', async () => {
    await expect(recordBenchmark(db, ctx as any, {
      code: 'BMK-MADE-UP', sourceCode: 'SRC-DOES-NOT-EXIST',
      organisation: 'Some Federation', service: 'membership',
      serviceLabel: 'Membership', audience: 'adult',
      amountMinor: 5000, currency: 'EUR', amountText: 'EUR 50/year',
      frequency: 'per_year', subject: 'person',
    })).rejects.toThrow(/not stored without one/);
  });

  it('refuses to call something an official publication with no URL', async () => {
    await expect(recordSource(db, ctx as any, {
      code: 'SRC-NO-URL', organisation: 'Some Federation',
      title: 'Their fee schedule', sourceType: 'official_publication', confidence: 'verified',
    })).rejects.toThrow(/citation nobody can follow/);
  });

  it('refuses a rupee-style amount passed as a major unit', async () => {
    await expect(recordSource(db, ctx as any, {
      code: 'SRC-REAL', organisation: 'Example Federation',
      title: 'Example Federation fee schedule 2026',
      url: 'https://example.invalid/fees', publishedOn: '2026-01-01',
      sourceType: 'official_publication', confidence: 'verified',
    })).resolves.toBeTruthy();

    await expect(recordBenchmark(db, ctx as any, {
      code: 'BMK-EXAMPLE-FLOAT', sourceCode: 'SRC-REAL',
      organisation: 'Example Federation', service: 'membership',
      serviceLabel: 'Membership', audience: 'adult',
      amountMinor: 50.5 as any, currency: 'EUR', amountText: 'EUR 50.50/year',
      frequency: 'per_year', subject: 'person',
    })).rejects.toThrow(/minor unit of their own currency/);
  });

  it('copies the provenance off the source rather than trusting the caller', async () => {
    const row = await recordBenchmark(db, ctx as any, {
      code: 'BMK-EXAMPLE-ADULT', sourceCode: 'SRC-REAL',
      organisation: 'Example Federation', country: 'IN', region: 'national',
      service: 'membership', serviceLabel: 'Adult membership', audience: 'adult',
      amountMinor: 5000, currency: 'EUR', amountText: 'EUR 50/year',
      frequency: 'per_year', subject: 'person',
    });
    expect(row.sourceUrl).toBe('https://example.invalid/fees');
    expect(row.sourceType).toBe('official_publication');
    expect(row.confidence).toBe('verified');
    expect(row.sourceDate).toBe('2026-01-01');

    const [audit] = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'fee_benchmark'));
    expect(audit).toBeTruthy();
  });

  it('will not drop a figure out of the evidence without a recorded reason', async () => {
    const [row] = await db.select().from(s.feeBenchmarks)
      .where(eq(s.feeBenchmarks.code, 'BMK-EXAMPLE-ADULT')).limit(1);

    await expect(setBenchmarkStatus(db, ctx as any, row.id, 'excluded', '   '))
      .rejects.toThrow(/cannot be told from evidence that was inconvenient/);

    await setBenchmarkStatus(db, ctx as any, row.id, 'excluded', 'Superseded by the 2027 schedule.');
    const [after] = await db.select().from(s.feeBenchmarks).where(eq(s.feeBenchmarks.id, row.id));
    expect(after.status).toBe('excluded');
    expect(after.statusReason).toMatch(/Superseded/);

    // And it stops informing recommendations.
    const evidence = await listBenchmarks(db, finance, {});
    expect(evidence.some((o) => o.code === 'BMK-EXAMPLE-ADULT')).toBe(false);
  });

  it('keeps a flagged figure in the sample and says so', async () => {
    const [row] = await db.select().from(s.feeBenchmarks)
      .where(eq(s.feeBenchmarks.code, 'BMK-EXAMPLE-ADULT')).limit(1);
    await setBenchmarkStatus(db, ctx as any, row.id, 'flagged', 'Queried with the office; not yet resolved.');

    const evidence = await listBenchmarks(db, finance, { service: 'membership', currency: 'EUR' });
    expect(evidence.some((o) => o.code === 'BMK-EXAMPLE-ADULT')).toBe(true);

    const rec = recommendFee(evidence, { service: 'membership', currency: 'EUR', unit: PERSON_YEAR });
    expect(rec.cautions.join(' ')).toMatch(/flagged for review/);

    // Put it back so the snapshot cases below start from a known store.
    await setBenchmarkStatus(db, ctx as any, row.id, 'included', null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SNAPSHOTS — the evidence a recommendation was made from, frozen
// ═══════════════════════════════════════════════════════════════════════════

describe('a snapshot makes a past recommendation re-examinable', () => {
  it('reproduces the same figures after the live store has moved', async () => {
    const query = { service: 'membership', currency: 'USD', unit: PERSON_YEAR };
    const before = await listBenchmarks(db, finance, {});
    const original = recommendFee(before, query as any);
    expect(original.sampleSize).toBe(2);

    const snap = await takeSnapshot(db, ctx as any, {
      title: 'Individual membership, USD, per person per year',
      query, observations: before, recommendation: original,
    });
    expect(snap.code).toMatch(/^MMAKF-BMS-\d{4}-\d{6}$/);
    expect(snap.observationCount).toBe(before.length);

    // Now the store moves: a figure is excluded.
    const [usa] = await db.select().from(s.feeBenchmarks)
      .where(eq(s.feeBenchmarks.code, 'BMK-USA-KARATE-MEMBERSHIP-COACH-OFFICIAL')).limit(1);
    await setBenchmarkStatus(db, ctx as any, usa.id, 'excluded', 'Withdrawn by the source.');

    // The live answer changes — correctly.
    const live = recommendFee(await listBenchmarks(db, finance, {}), query as any);
    expect(live.sampleSize).toBe(1);
    expect(live.median!.amountMinor).toBe(6000);

    // The snapshot does not. That is what makes "was the advice wrong, or did
    // the evidence move?" an answerable question.
    const stored = await readSnapshot(db, finance, snap.code);
    const replayed = recommendFromSnapshot(stored as any, query as any);
    expect(replayed.sampleSize).toBe(2);
    expect(replayed.median!.amountMinor).toBe(original.median!.amountMinor);
    expect(replayed.reasons).toEqual(original.reasons);

    // Restore, so nothing after this depends on ordering.
    await setBenchmarkStatus(db, ctx as any, usa.id, 'included', null);
  });

  it('records no approval, because a snapshot is evidence and not a decision', async () => {
    const [row] = await db.select().from(s.feeBenchmarkSnapshots).limit(1);
    expect(Object.keys(row)).not.toContain('approvedAt');
    expect(Object.keys(row)).not.toContain('feeRuleId');
    const recent = await recentSnapshots(db, auditor);
    expect(recent.length).toBeGreaterThan(0);
  });

  it('lists the citations behind the whole store', async () => {
    const sources = await listBenchmarkSources(db, auditor);
    expect(sources.map((x: any) => x.organisation)).toContain('WUKF');
    expect(sources.every((x: any) => x.title && x.sourceType)).toBe(true);
  });
});
