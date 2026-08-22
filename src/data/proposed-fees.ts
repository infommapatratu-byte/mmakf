// A PROPOSED MMAKF fee framework — a recommendation, not a decision.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHO DECIDED THIS, AND WHAT IT IS NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// The federation asked, on 17 August 2026: "you itself decide the price as a CEO
// and make it editable from admin section."
//
// So these figures are MINE, not MMAKF's. That distinction is not pedantry and
// it is why this file exists rather than a migration inserting rows:
//
//   · Loading it creates a framework with status DRAFT. A draft framework
//     prices nothing. activeFramework() will not return it, computeFee() will
//     not use it, and no quotation can be issued from it.
//   · It becomes MMAKF's fee framework at the moment an authorised person
//     presses publish at /admin/fees, and not one second before.
//   · Every figure can be edited before that, and publishing is irreversible
//     by design — after it, a change means a new version.
//
// If the federation publishes it unchanged, these become MMAKF's fees by the
// federation's decision, taken with the figures in front of them. That is a
// completely different thing from software having invented a price and started
// charging it, which is what every other line of this codebase is built to
// prevent.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW THE FIGURES WERE REACHED
// ─────────────────────────────────────────────────────────────────────────────
//
// Three inputs, in this order.
//
// 1. THE BENCHMARKS THE FEDERATION SUPPLIED. USA Karate at $60 for an athlete
//    and $200 for a club; IBF Great Britain at £25 adult and £15 junior; WUKF
//    at €250 federation, €45 individual entry, €50 coach, €100 Dan
//    homologation, €200 protest. They are stored in `fee_benchmarks` with their
//    sources.
//
// 2. INDIA. Those are the crucial correction. USA Karate's $60 is roughly
//    ₹5,000, and a ₹5,000 annual membership would exclude most of the children
//    MMAKF actually teaches — in Patratu, in Ramgarh, in Hazaribagh. A national
//    federation whose fee decides who may join is not a national federation.
//    So the STRUCTURE is taken from the benchmarks and the LEVEL is set for the
//    market MMAKF operates in.
//
// 3. INTERNAL COHERENCE. Every ratio below is deliberate and defensible out
//    loud, which matters more than any single number:
//      · someone who EARNS from the federation — a coach, an examiner, an
//        official — pays a membership. SOMEBODY WHO TRAINS DOES NOT: they pay
//        for training, and nothing else is charged for being a student
//      · a Dan examination costs more than a kyu examination
//      · a club pays more than a person, and an institution more than a club
//      · a protest fee is high enough to deter a frivolous one and is REFUNDED
//        when upheld, so it never penalises being right
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHAT I WOULD CHANGE FIRST
// ─────────────────────────────────────────────────────────────────────────────
//
// The institutional figures are the least certain. A school programme's real
// cost is dominated by what MMAKF pays a coach to be in a room for twelve weeks,
// and I do not know that number. The per-participant rate below is set so that
// a 300-child school programme lands near ₹1,50,000 for a term — which is
// plausible and is a guess. Ask the training office what a coach costs before
// publishing this section.
//
// Everything is INTEGER PAISE. ₹500 is 50000. See applyFactor() in
// src/db/fees.ts for why nothing here is a float.

export interface ProposedRule {
  code: string;
  label: string;
  kind:
    | 'base' | 'per_participant' | 'per_session' | 'per_batch' | 'per_campus'
    | 'per_instructor' | 'per_km' | 'multiplier' | 'fixed_add' | 'discount' | 'tax';
  /** Integer paise. Null where the rule is a multiplier. */
  amountMinor?: number;
  /** Parts-per-million. 1_000_000 is ×1.0. */
  factorPpm?: number;
  audience?: string;
  conditions?: Record<string, unknown>;
  sortOrder: number;
  requiresApproval?: boolean;
  /** Why this figure, in one sentence an administrator can argue with. */
  basis: string;
}

const R = (rupees: number) => Math.round(rupees * 100);

/**
 * MEMBERSHIP — annual, and NOT for students.
 *
 * The anchor was the junior rate until the federation removed it. What remains
 * is priced against the coach rate, and the test of whether a category belongs
 * here at all is a single question: does this person RECEIVE training from the
 * federation, or ACT on its behalf? Only the second pays a membership.
 */
export const MEMBERSHIP: ProposedRule[] = [
  // ───────────────────────────────────────────────────────────────────────────
  // WITHDRAWN: MEM-JUNIOR (₹300/yr) AND MEM-ATHLETE (₹500/yr)
  //
  // I proposed both on 17 August 2026. The federation removed them the same
  // day, and the rule it gave is the correct one:
  //
  //     A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT.
  //
  // What a student buys is TRAINING. An account, a profile, an enrolment and a
  // place in a class are not a product — they are what having a student means.
  // Charging ₹500 a year for the right to then pay ₹800 a month is a second
  // charge for the first one, and a family reads it as exactly that.
  //
  // They are DELETED rather than commented out or hidden. A rule that still
  // exists can still be applied by a future edit, a seed, a migration or a
  // careless clone of the framework — the federation's instruction was
  // explicit that the commercial engine must lose the ABILITY to generate
  // these, not merely stop displaying them.
  //
  // The benchmarks that justified them are not deleted: USA Karate and IBF
  // Great Britain genuinely do charge an athlete membership, and those rows
  // stay in `fee_benchmarks` as facts about those organisations. MMAKF has
  // decided differently, which is a decision it is entitled to make and this
  // file should record rather than argue with.
  //
  // What survives below is membership for people whose RELATIONSHIP TO THE
  // FEDERATION is not "student": a coach who teaches under its authority, an
  // official who adjudicates in its name, an examiner who grades on its behalf,
  // a club that carries its charter. None of those is a person receiving
  // training, and none is reachable by being a student.
  // ───────────────────────────────────────────────────────────────────────────

  { code: 'MEM-COACH', label: 'Coach or instructor membership, annual', kind: 'base',
    amountMinor: R(1000), audience: 'individual', conditions: { category: 'instructor' }, sortOrder: 12,
    basis: 'A coach EARNS from the federation rather than receiving training from it, which is what makes this a membership and not a student charge. USA Karate and WUKF both price a coach above an athlete.' },

  { code: 'MEM-OFFICIAL', label: 'Referee, judge or technical official, annual', kind: 'base',
    amountMinor: R(1000), audience: 'individual', conditions: { category: 'official' }, sortOrder: 13,
    basis: 'Level with a coach: the same relationship to the federation — adjudicating in its name — and officials should not be priced out of officiating.' },

  { code: 'MEM-EXAMINER', label: 'Examiner, annual', kind: 'base',
    amountMinor: R(1500), audience: 'individual', conditions: { category: 'examiner' }, sortOrder: 14,
    basis: 'Above a coach. An examiner holds the federation\'s grading authority, which is its most consequential delegation.' },

  { code: 'MEM-DOJO', label: 'Dojo or club affiliation, annual', kind: 'base',
    amountMinor: R(3000), audience: 'club', sortOrder: 20,
    basis: 'USA Karate charges $200 for a club — roughly four times its athlete rate. This is six times, because a club bills its own students and can carry more than an individual.' },

  { code: 'MEM-INSTITUTION', label: 'Institutional affiliation, annual', kind: 'base',
    amountMinor: R(5000), audience: 'school', sortOrder: 21,
    basis: 'Above a club. A school or university carries an institutional budget rather than a teacher\'s income.' },
];

/**
 * GRADING.
 *
 * The certificate is INCLUDED in the examination fee. Charging separately for
 * the document that proves the result somebody has already paid to be assessed
 * for reads as a second charge for one thing.
 */
export const GRADING: ProposedRule[] = [
  { code: 'GRD-KYU', label: 'Kyu examination', kind: 'base',
    amountMinor: R(500), conditions: { examination: 'kyu' }, sortOrder: 30,
    basis: 'A kyu grading is a local event with a short panel. Priced at one athlete membership so a child may grade twice a year without it becoming the family\'s largest karate cost.' },

  { code: 'GRD-DAN-1-3', label: 'Dan examination, 1st to 3rd', kind: 'base',
    amountMinor: R(3000), conditions: { examination: 'dan', danLevel: { max: 3 } }, sortOrder: 31,
    basis: 'A Dan examination convenes a senior panel and issues a permanent national record. WUKF charges €100 for Dan homologation alone; this covers the whole examination.' },

  { code: 'GRD-DAN-4-PLUS', label: 'Dan examination, 4th and above', kind: 'base',
    amountMinor: R(5000), conditions: { examination: 'dan', danLevel: { min: 4 } }, sortOrder: 32,
    basis: 'Higher Dan grades are examined by the technical authority itself and are rare. The cost reflects the panel, not the paperwork.' },

  { code: 'GRD-CERT-REISSUE', label: 'Certificate reissue', kind: 'base',
    amountMinor: R(300), conditions: { document: 'certificate_reissue' }, sortOrder: 33,
    basis: 'Covers verification and re-issue. Deliberately low: somebody who lost a certificate in a flood should not be penalised for it.' },
];

/**
 * COMPETITION.
 *
 * The additional-category rate is DELIBERATELY LOWER than the first. The
 * federation wants athletes entering both kata and kumite, and pricing the
 * second entry at full rate discourages exactly the participation a national
 * championship exists to produce.
 */
export const COMPETITION: ProposedRule[] = [
  { code: 'CMP-ENTRY-FIRST', label: 'Athlete entry, first category', kind: 'base',
    amountMinor: R(500), sortOrder: 40,
    basis: 'WUKF charges €45 for an individual entry. ₹500 is the same structure at Indian levels and matches one athlete membership.' },

  { code: 'CMP-ENTRY-ADDITIONAL', label: 'Each additional category', kind: 'per_participant',
    amountMinor: R(300), conditions: { additionalCategory: true }, sortOrder: 41,
    basis: 'Lower than the first, on purpose. The marginal cost of a second category is small and the federation wants athletes in both kata and kumite.' },

  { code: 'CMP-ENTRY-TEAM', label: 'Team entry', kind: 'base',
    amountMinor: R(1200), conditions: { entryType: 'team' }, sortOrder: 42,
    basis: 'WUKF prices a team at roughly 1.8× an individual. This is 2.4×, still well under the cost of entering each member separately.' },

  { code: 'CMP-COACH-ACCRED', label: 'Coach accreditation, per event', kind: 'base',
    amountMinor: R(300), conditions: { role: 'coach' }, sortOrder: 43,
    basis: 'Covers accreditation and the coach\'s place at the tatami. Low, because a coach barred by cost means athletes competing unsupported.' },

  { code: 'CMP-LATE', label: 'Late entry surcharge', kind: 'fixed_add',
    amountMinor: R(200), conditions: { lateEntry: true }, sortOrder: 44,
    basis: 'A late entry forces a draw to be redone. Enough to matter, not enough to be a revenue line — if this earns much, the deadline is the problem.' },

  { code: 'CMP-PROTEST', label: 'Protest fee, refunded if upheld', kind: 'base',
    amountMinor: R(2000), conditions: { protest: true }, sortOrder: 45,
    basis: 'WUKF charges €200. High enough that a protest is considered, and REFUNDED WHEN UPHELD so it never penalises being right — that refund is the part that must not be dropped.' },
];

/**
 * EDUCATION.
 *
 * Priced near cost. Coach and referee education is how a federation grows its
 * own capacity, and a federation that profits from training its own officials
 * ends up with fewer officials.
 */
export const EDUCATION: ProposedRule[] = [
  { code: 'EDU-COACH-COURSE', label: 'Coach education course', kind: 'base',
    amountMinor: R(2500), conditions: { course: 'coach' }, sortOrder: 50,
    basis: 'Multi-day, with technical staff and materials. Priced near cost: this is capacity-building, not a product.' },

  { code: 'EDU-REFEREE-COURSE', label: 'Referee or judge education course', kind: 'base',
    amountMinor: R(2000), conditions: { course: 'referee' }, sortOrder: 51,
    basis: 'Slightly below the coach course. MMAKF needs officials more than it needs the margin.' },

  { code: 'EDU-SEMINAR-DAY', label: 'Technical seminar, per day', kind: 'per_session',
    amountMinor: R(800), conditions: { event: 'seminar' }, sortOrder: 52,
    basis: 'A day with a senior instructor. Comparable to a month of ordinary training, which is roughly the value of the day.' },

  { code: 'EDU-CAMP-DAY', label: 'Training camp, per day', kind: 'per_session',
    amountMinor: R(600), conditions: { event: 'camp' }, sortOrder: 53,
    basis: 'Below a seminar: a camp is longer, and the daily rate should fall as the commitment rises.' },
];

/**
 * INDIVIDUAL TRAINING.
 *
 * NOT the nine scattered monthly prices this project removed. These are rules
 * in one framework, and what somebody pays depends on their circumstances.
 */
export const INDIVIDUAL_TRAINING: ProposedRule[] = [
  { code: 'TRN-MONTHLY-CENTRE', label: 'Monthly training at an MMAKF centre', kind: 'base',
    amountMinor: R(800), audience: 'individual', conditions: { mode: 'at_dojo' }, sortOrder: 60,
    basis: 'Japan Karate-Do charges $185/month — about ₹15,000, which is not a comparable market. ₹800 is what regular dojo training sustainably costs in Jharkhand.' },

  { code: 'TRN-JUNIOR-DISCOUNT', label: 'Junior rate', kind: 'discount',
    amountMinor: -R(200), audience: 'individual', conditions: { ageBand: 'junior', mode: 'at_dojo' }, sortOrder: 61,
    basis: 'A quarter off for under-18s. Appears as its own line on the quotation so a family can see it was applied.' },

  { code: 'TRN-PERSONAL-SESSION', label: 'Personal coaching, per session', kind: 'per_session',
    amountMinor: R(1000), audience: 'individual', conditions: { mode: 'personal' }, sortOrder: 62,
    basis: 'One instructor, one student, one hour. Priced above a month of group training because it consumes an instructor entirely.' },
];

/**
 * INSTITUTIONAL TRAINING — schools, corporates, universities, government.
 *
 * THE LEAST CERTAIN SECTION IN THIS FILE, and the one to review before
 * publishing. See the note at the top: the real driver is what MMAKF pays a
 * coach for twelve weeks, and I do not know that figure.
 *
 * The shape is right regardless: a base that covers designing and administering
 * a programme, plus a per-participant rate, plus the things that genuinely add
 * cost — more batches, more campuses, travel, on-site delivery.
 */
export const INSTITUTIONAL: ProposedRule[] = [
  { code: 'INST-BASE', label: 'Programme base fee', kind: 'base',
    amountMinor: R(15000), audience: 'school', sortOrder: 70,
    basis: 'Covers programme design, coach assignment, scheduling, reporting and administration — the work that happens whether the school has 50 children or 500.' },

  { code: 'INST-PER-PARTICIPANT', label: 'Per participant', kind: 'per_participant',
    amountMinor: R(450), audience: 'school', sortOrder: 71,
    basis: 'THE FIGURE TO CHECK FIRST. Set so a 300-child term lands near ₹1,50,000. Plausible, and a guess until the training office states a coach cost.' },

  { code: 'INST-PER-BATCH', label: 'Each additional batch', kind: 'per_batch',
    amountMinor: R(3000), audience: 'school', conditions: { batches: { min: 2 } }, sortOrder: 72,
    basis: 'A second batch is a second block of coach time, not a second copy of the same session.' },

  { code: 'INST-PER-CAMPUS', label: 'Each additional campus', kind: 'per_campus',
    amountMinor: R(5000), audience: 'school', conditions: { campuses: { min: 2 } }, sortOrder: 73,
    basis: 'A second campus is travel, a second venue check and a second timetable to hold.' },

  { code: 'INST-ONSITE', label: 'On-site delivery', kind: 'multiplier',
    factorPpm: 1_250_000, audience: 'school', conditions: { mode: 'on_site' }, sortOrder: 80,
    basis: 'A quarter more. Coaches travel to the institution, work to its calendar, and cannot teach anybody else in that window.' },

  { code: 'INST-TRAVEL', label: 'Travel, per kilometre beyond the base district', kind: 'per_km',
    amountMinor: R(12), audience: 'school', conditions: { travelKm: { min: 1 } }, sortOrder: 81,
    basis: 'Ordinary road cost per kilometre. Charged only beyond the coach\'s own district.' },

  { code: 'INST-GRADING', label: 'Grading, per participant', kind: 'per_participant',
    amountMinor: R(200), audience: 'school', conditions: { wantsGrading: true }, sortOrder: 82,
    basis: 'Below the standalone kyu fee, because the panel assesses a whole cohort in one visit.' },

  { code: 'INST-CERTIFICATION', label: 'Certification, per participant', kind: 'per_participant',
    amountMinor: R(150), audience: 'school', conditions: { wantsCertification: true }, sortOrder: 83,
    basis: 'Covers issue, the verification record and the QR credential.' },

  { code: 'INST-VOLUME-300', label: 'Large cohort adjustment, 300 or more', kind: 'discount',
    amountMinor: -R(20000), audience: 'school', conditions: { participants: { min: 300 } },
    sortOrder: 90, requiresApproval: true,
    basis: 'Large cohorts are more efficient per child and the saving should be shared. REQUIRES APPROVAL — a discount of this size should never be applied without a second person seeing it.' },
];

/** Every proposed rule, in the order they apply. */
export const PROPOSED_RULES: ProposedRule[] = [
  ...MEMBERSHIP, ...GRADING, ...COMPETITION, ...EDUCATION,
  ...INDIVIDUAL_TRAINING, ...INSTITUTIONAL,
];

/**
 * DELIBERATELY ABSENT: TAX.
 *
 * No GST rule is proposed. Whether a federation membership, a grading fee or an
 * institutional training contract attracts GST — and at what rate — is a legal
 * and accounting question about MMAKF's own registration and the nature of each
 * supply. Guessing it would produce invoices that are wrong in a way the
 * federation, not the software, would answer for.
 *
 * src/db/tax.ts models it and ships empty. Ask MMAKF's accountant, then enter
 * the rules there.
 */
export const PROPOSED_FRAMEWORK = {
  code: 'MMAKF-FEE-2026-V1',
  title: 'MMAKF fee framework 2026 (proposed)',
  notes:
    'PROPOSED, NOT ADOPTED. Figures recommended on the federation\'s instruction of ' +
    '17 August 2026 and loaded as a DRAFT: they price nothing until an authorised ' +
    'person publishes them at /admin/fees, and every one can be edited first. ' +
    'Each rule records the reasoning behind its figure. The institutional ' +
    'per-participant rate is the least certain and should be checked against what ' +
    'MMAKF actually pays a coach. No tax rule is proposed — that is a question for ' +
    'the federation\'s accountant.',
} as const;
