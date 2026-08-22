// THE RULE, MADE STRUCTURAL.
//
//     A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT.
//
// What a student buys is TRAINING. An account, a profile, an enrolment and a
// place in a class are not products — they are what having a student means.
// There is no student subscription, no junior membership, no registration fee,
// no platform fee and no account fee, and access is decided by a valid TRAINING
// ENTITLEMENT rather than by membership.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL — DELETION WAS NOT ENOUGH
// ─────────────────────────────────────────────────────────────────────────────
//
// MEM-JUNIOR and MEM-ATHLETE were removed from src/data/proposed-fees.ts on the
// federation's instruction. That deletion is real and it is correct, and it
// stops nothing. A data file is a suggestion to whoever edits it next. The rules
// come back the moment somebody:
//
//   · clones the framework in /admin/fees and "restores" a category that looks
//     conspicuously missing beside MEM-COACH and MEM-OFFICIAL;
//   · writes a seed script that inserts what another federation charges;
//   · writes a migration that back-fills a framework from an old price list;
//   · reads the WITHDRAWN comment as a description of a gap rather than a
//     decision.
//
// Each of those is a person acting in good faith on incomplete information, and
// none of them is prevented by care. So the ENGINE refuses. A rule that cannot
// be created cannot be displayed, exported, cloned, quoted, invoiced or seeded,
// because every one of those reads rows that this guard would not let exist.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HARD PART: A COACH MEMBERSHIP IS LEGITIMATE
// ─────────────────────────────────────────────────────────────────────────────
//
// MMAKF does charge a membership. MEM-COACH, MEM-OFFICIAL, MEM-EXAMINER,
// MEM-DOJO and MEM-INSTITUTION are all real and all must stay creatable. So a
// predicate that matches the word "membership" is worse than useless: it blocks
// the federation's actual revenue while looking like a safety feature, and the
// first person it inconveniences deletes it.
//
// The predicate therefore turns on TWO questions, and refuses only when both
// answers point the same way:
//
//   1. WHAT IS BEING CHARGED FOR — standing with the federation (membership,
//      subscription, dues, registration, an account, a platform), or a thing
//      the federation DELIVERS (a class, a camp, a grading, a competition
//      entry, a certificate)?
//
//   2. WHO PAYS, and in what relationship — somebody who RECEIVES TRAINING
//      (a student, an athlete, a junior, a participant), somebody who ACTS ON
//      THE FEDERATION'S BEHALF (a coach, an official, an examiner), or an
//      ORGANISATION (a dojo, a club, a school)?
//
// Only "standing" × "receives training" is refused. A coach membership is
// standing × acts-for-federation and passes. A monthly training fee is delivery
// × receives-training and passes. A dojo affiliation is standing × organisation
// and passes.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHAT IT DOES WHEN A RULE DOES NOT SAY WHO PAYS
// ─────────────────────────────────────────────────────────────────────────────
//
// It refuses, and this is the decision most likely to be argued with, so:
//
// A standing charge whose audience is `individual` (or null, which computeFee()
// reads as "applies to everybody") and which names no role AT ALL is reachable
// by a student. "Annual membership, ₹500, individual" charges the child in
// Patratu exactly as surely as a rule that says so out loud. Passing it because
// nobody typed the word "athlete" would make the guard depend on the phrasing
// somebody chose, which is precisely the kind of protection this file exists to
// replace.
//
// The refusal is cheap to satisfy and names its own cure: say who it is for.
// `conditions: { category: 'instructor' }` — one line — and the rule is created.
// A membership category the federation cannot name is one it should not charge.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE DELIBERATELY DOES NOT TOUCH
// ─────────────────────────────────────────────────────────────────────────────
//
// HISTORY. Not one function here reads or writes an order, an order line, an
// invoice, a payment, a ledger entry or a quote line. If a payment taken in 2019
// genuinely contained a student membership charge, THAT RECORD STAYS AND STAYS
// EXACTLY AS IT IS. The federation's rule governs what may be charged from now
// on; a ledger edited to make a new policy look tidy is a falsified ledger, and
// the tests in tests/student-not-a-member.test.ts assert that an existing record
// is still readable and unchanged after every guard in this file has run.
//
// It also takes NO DATABASE HANDLE. Every function is pure — a candidate in, a
// verdict out — for the same reason src/db/fee-recommendation.ts takes none:
// there is nothing here to write with, so there is no path to guard.
//
// ─────────────────────────────────────────────────────────────────────────────
// THERE ARE TWO FEE REGISTERS, AND GUARDING ONE GUARDED NOTHING
// ─────────────────────────────────────────────────────────────────────────────
//
// This file was written against `fee_rules`, and `fee_rules` is not the table
// anybody is charged from. The figure a surface SHOWS comes from
// fee_frameworks/fee_rules through feeFor() -> computeFee(). The figure
// createOrder() CHARGES comes from the flat `fee_schedule` table, which nothing
// in src/ writes and which therefore only ever receives rows from a seed, a
// migration, a restored backup or an operator's INSERT — precisely the four
// authors listed at the top of this file as the reason deletion was not enough.
//
// So a row of
//
//   { code: 'membership.junior.annual', label: 'Junior membership (annual)',
//     kind: 'membership', amountPaise: 50000 }
//
// went straight past every guard here into an order line, a payment and an
// INVOICE, through the anonymous POST /api/payments/checkout, without ever
// touching a fee framework. classifyScheduledFee() below is that hole closed.
//
// The FOUR enforcement points, in the order money reaches them:
//
//   1. addRule()          src/db/fees.ts        — an author writing a rule
//   2. publishFramework() src/db/fees.ts        — a seed or migration, at the
//                                                 moment a framework gains the
//                                                 power to price anything
//   3. createOrder()      src/db/orders.ts      — the fee_schedule register, at
//                                                 the moment somebody is
//                                                 CHARGED. The last gate before
//                                                 an invoice exists.
//   4. configureTerm()    src/db/entitlements.ts — what a fee BUYS, so a fee
//                                                 named for a coach cannot be
//                                                 configured to issue a student
//                                                 membership behind the name.

// ─── What a candidate rule looks like ───────────────────────────────────────

/**
 * Enough of a fee rule to judge it.
 *
 * Every field optional, because this is called on three different shapes: the
 * argument to addRule() before anything is written, a `fee_rules` row read back
 * during publishFramework(), and a plain object in a seed script. A field that
 * is absent simply contributes no evidence.
 */
export interface RuleCandidate {
  code?: string | null;
  label?: string | null;
  kind?: string | null;
  audience?: string | null;
  conditions?: unknown;
  amountMinor?: number | null;
  /** Resolved by the caller when the rule names a service. See fees.ts. */
  serviceCode?: string | null;
  serviceTitle?: string | null;
  serviceCategory?: string | null;
  description?: string | null;
  /**
   * The `order_line_kind` a `fee_schedule` row carries — 'membership',
   * 'affiliation', 'grading', 'course', 'program'.
   *
   * The SECOND fee register (see classifyScheduledFee below) states what a fee
   * IS in a column rather than in its name, so a row can be a membership
   * without the word appearing anywhere a reader would see it:
   *
   *   { code: 'annual.junior', label: 'Junior annual', kind: 'membership' }
   *
   * Scanned as ordinary text, so 'membership' is standing evidence exactly as
   * it would be in a label and 'grading' is delivery context exactly as it
   * would be in a code. A candidate that does not set it contributes nothing,
   * which is why adding it changed no verdict fees.ts already gave.
   */
  lineKind?: string | null;
}

export type ChargeShape =
  /** Paid for STANDING — being a member, being registered, holding an account. */
  | 'standing'
  /** Paid for something DELIVERED — a class, a camp, a grading, an entry. */
  | 'delivery';

export type PayerRelationship =
  | 'receives_training'
  | 'acts_for_federation'
  | 'organisation'
  | 'unstated';

export interface Evidence {
  signal: 'standing' | 'delivery_context' | 'student' | 'federation_role' | 'organisation';
  /** The term that matched, as this file spells it. */
  term: string;
  /** Where it was found — 'label', 'code', 'conditions.category', 'audience'. */
  field: string;
}

export interface StudentRuleVerdict {
  /** The answer. True means the rule may not exist. */
  studentCharge: boolean;
  shape: ChargeShape;
  payer: PayerRelationship;
  /** Every term that decided it, so the refusal can be argued with. */
  evidence: Evidence[];
  /** Null when permitted. Otherwise the message the domain refuses with. */
  refusal: string | null;
  /** A stable machine code for the refusal, so a surface can branch on it. */
  refusalCode: StudentRefusalCode | null;
}

export type StudentRefusalCode =
  /** The rule names a person who receives training. */
  | 'student_standing_charge'
  /** A standing charge levied per trainee head inside a programme. */
  | 'per_trainee_standing_charge'
  /** A standing charge on individuals that never says which individuals. */
  | 'unattributed_standing_charge';

/** The error `assertNoStudentCharge()` throws. Identified by shape — see below. */
export class StudentChargeRefused extends Error {
  readonly code: StudentRefusalCode;
  readonly verdict: StudentRuleVerdict;
  constructor(verdict: StudentRuleVerdict) {
    super(verdict.refusal ?? 'This rule levies a fee on a student for being a student.');
    this.name = 'StudentChargeRefused';
    this.code = verdict.refusalCode as StudentRefusalCode;
    this.verdict = verdict;
  }
}

/** By shape, not `instanceof` — two module instances would break the latter. */
export function isStudentChargeRefused(err: unknown): err is StudentChargeRefused {
  return Boolean(err) && (err as any).name === 'StudentChargeRefused';
}

// ─── The vocabulary ─────────────────────────────────────────────────────────
//
// Terms, not regular expressions over the raw string. `/member/` matches
// "remember" and "membership" alike, and a guard that fires on a substring is a
// guard somebody eventually disables. Everything below is matched as a WHOLE
// TOKEN or a run of consecutive whole tokens, against text that has been split
// on punctuation and camelCase — so 'MEM-COACH', 'memCoach' and 'MEM_COACH' all
// tokenise identically, and no amount of renaming evades the check.

/**
 * Words that mean STANDING and cannot mean anything else.
 *
 * A strong term is not neutralised by delivery context. "Training membership"
 * is still a membership: if the charge is for training, it should be called a
 * training fee, and the federation's objection to the word is exactly that a
 * family reads "membership" as a second charge for the first one.
 *
 * 'mem' and 'aff' are here because codes abbreviate. MEM-ATHLETE must not walk
 * past a guard that only knows the spelled-out word.
 */
const STANDING_STRONG: readonly string[] = [
  'membership', 'memberships', 'member', 'members', 'mem',
  'dues', 'affiliation', 'affiliations', 'affiliated', 'aff',
  'joining', 'joining fee', 'sign up', 'signup', 'onboarding fee',
  'account', 'platform', 'portal',
];

/**
 * Words that mean standing UNLESS they are attached to something delivered.
 *
 * "Competition registration" is an entry to a tournament; "student
 * registration" is a charge for existing. Same word, opposite meanings, and the
 * difference is the noun beside it. 'subscription' behaves the same way: a
 * monthly training subscription is a way of paying for training, while a
 * student subscription is the banned thing.
 */
const STANDING_WEAK: readonly string[] = [
  'subscription', 'subscriptions', 'subscriber', 'subscribers',
  'registration', 'registrations', 'register', 'reg',
  'enrolment', 'enrolments', 'enrollment', 'enrollments', 'enrol', 'enroll',
  'admission', 'admissions', 'intake',
  'licence', 'license', 'licensing',
  'renewal', 'renewals', 'renew',
  'annual fee', 'yearly fee', 'standing',
];

/**
 * The things the federation DELIVERS.
 *
 * Presence of one of these neutralises a WEAK standing term and nothing else.
 * The list is deliberately generous: a false "this is a delivered service"
 * costs a rule that should have been renamed, while a false "this is a standing
 * charge" costs the federation a fee it legitimately charges — and the second
 * failure is the one that gets the guard removed.
 */
const DELIVERY_CONTEXT: readonly string[] = [
  'competition', 'competitions', 'championship', 'championships',
  'tournament', 'tournaments', 'event', 'events', 'meet', 'league',
  'festival', 'trial', 'trials', 'selection', 'squad',
  // NOT 'category'. It is the key of `{ category: 'athlete' }` — the very
  // condition that says a rule is for students — and admitting it as evidence
  // of a delivered service would let "student registration fee, category:
  // student" neutralise its own standing term. The rules that genuinely price a
  // competition category say 'entry' as well, so nothing is lost.
  'entry', 'entries', 'team', 'teams',
  'grading', 'gradings', 'examination', 'examinations', 'exam', 'exams',
  'dan', 'kyu', 'syllabus', 'belt',
  'course', 'courses', 'seminar', 'seminars', 'camp', 'camps',
  'workshop', 'workshops', 'clinic', 'clinics', 'accreditation',
  'protest', 'appeal', 'match', 'matches', 'kata', 'kumite', 'shiai',
  'training', 'tuition', 'coaching', 'instruction', 'lesson', 'lessons',
  'class', 'classes', 'session', 'sessions', 'practice',
  'programme', 'program', 'certificate', 'certification', 'equipment',
  'travel', 'venue', 'insurance',
];

/**
 * People who RECEIVE training.
 *
 * The federation's own test, from src/data/proposed-fees.ts: "does this person
 * RECEIVE training from the federation, or ACT on its behalf?" Everything here
 * is the first answer.
 */
const STUDENT_TERMS: readonly string[] = [
  'student', 'students', 'stu', 'pupil', 'pupils', 'scholar', 'scholars',
  'athlete', 'athletes', 'ath', 'competitor', 'competitors',
  'junior', 'juniors', 'jr', 'jnr', 'sub junior', 'subjunior',
  'cadet', 'cadets', 'child', 'children', 'kid', 'kids',
  'youth', 'youths', 'minor', 'minors', 'infant', 'infants', 'toddler',
  'boy', 'boys', 'girl', 'girls', 'schoolchild', 'schoolchildren',
  'trainee', 'trainees', 'learner', 'learners',
  'beginner', 'beginners', 'novice', 'novices',
  'participant', 'participants', 'attendee', 'attendees', 'enrollee',
  'karateka', 'practitioner', 'practitioners', 'disciple', 'disciples',
  'white belt', 'under 18', 'u18',
];

/**
 * People who act ON THE FEDERATION'S BEHALF.
 *
 * NOTE what is absent: 'coaching'. Personal coaching is training DELIVERED TO a
 * student, and reading it as evidence that a coach is the payer would let
 * "Coaching membership, individual" through — which is the student subscription
 * wearing the payer's job title.
 */
const FEDERATION_ROLE_TERMS: readonly string[] = [
  'coach', 'coaches', 'instructor', 'instructors', 'sensei', 'shihan',
  'kyoshi', 'renshi', 'hanshi', 'teacher', 'teachers', 'trainer', 'trainers',
  'official', 'officials', 'officiating', 'referee', 'referees',
  'judge', 'judges', 'examiner', 'examiners', 'adjudicator',
  'technical', 'administrator', 'administrators', 'staff', 'volunteer',
  'volunteers', 'secretary', 'treasurer', 'delegate', 'delegates',
  'panel', 'director', 'directors', 'manager', 'managers',
  'organiser', 'organizer', 'scorer', 'timekeeper', 'commissioner',
];

/** Bodies, not people. A club pays an affiliation; that has always been fine. */
const ORGANISATION_TERMS: readonly string[] = [
  'club', 'clubs', 'dojo', 'dojos', 'school', 'schools', 'college',
  'colleges', 'university', 'universities', 'institution', 'institutions',
  'institutional', 'institute', 'corporate', 'corporation', 'company',
  'organisation', 'organization', 'ngo', 'government', 'department',
  'association', 'federation', 'unit', 'units', 'chapter', 'branch',
  'campus', 'academy', 'centre', 'center', 'affiliate', 'society', 'trust',
];

/** `audience_kind` values that are a BODY rather than a person. */
const ORGANISATION_AUDIENCES = new Set([
  'school', 'university', 'corporate', 'government', 'ngo', 'club', 'community',
]);

/**
 * Rule kinds that multiply by a count of TRAINEES.
 *
 * `per_instructor` is deliberately absent: instructors act for the federation,
 * and a per-instructor licence is a legitimate charge. `per_participant` is the
 * one that turns an institutional line into a per-head charge on children.
 */
const PER_TRAINEE_KINDS = new Set(['per_participant']);

// ─── Tokenising ─────────────────────────────────────────────────────────────

/**
 * Split text into whole lowercase tokens.
 *
 * camelCase is broken first ('ageBand' → 'age band') and digits are kept apart
 * from letters ('u18' → 'u 18'), so a condition key and a hyphenated code both
 * reduce to the same vocabulary as a sentence.
 */
function tokenise(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** 'u18' tokenises to ['u','18'], so the phrase 'u18' must too. */
const PHRASE_CACHE = new Map<string, string[]>();
function phraseTokens(term: string): string[] {
  let t = PHRASE_CACHE.get(term);
  if (!t) {
    t = tokenise(term);
    PHRASE_CACHE.set(term, t);
  }
  return t;
}

function containsPhrase(tokens: string[], term: string): boolean {
  const want = phraseTokens(term);
  if (!want.length) return false;
  for (let i = 0; i + want.length <= tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < want.length; j += 1) {
      if (tokens[i + j] !== want[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * `scan` is what separates a condition's KEY from its VALUE, and the
 * distinction is not cosmetic.
 *
 * A key is STRUCTURAL — it names what the engine matches on. `participants` in
 * `{ participants: { min: 50 } }` is a size threshold on an institution, not a
 * statement that participants are the payer, and reading it as one refuses a
 * perfectly legitimate "institutional affiliation for bodies with 50 or more
 * participants". A VALUE is descriptive: `{ category: 'athlete' }` really does
 * say who pays.
 *
 * So keys contribute DELIVERY CONTEXT only — `{ course: 'coach' }` and
 * `{ examination: 'kyu' }` genuinely name a delivered thing — and values are
 * scanned for everything.
 */
interface Fragment { field: string; tokens: string[]; scan: 'all' | 'delivery_only' }

/**
 * Flatten a rule's `conditions` into readable fragments.
 *
 * Nested objects (the `{ min, max }` form) keep their path, so the field a
 * refusal names is the field an author can go and edit.
 */
function flattenConditions(value: unknown, path: string, out: Fragment[]): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) flattenConditions(v, path, out);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = path ? `${path}.${k}` : k;
      const tokens = tokenise(k);
      if (tokens.length) out.push({ field: next, tokens, scan: 'delivery_only' });
      flattenConditions(v, next, out);
    }
    return;
  }
  const tokens = tokenise(String(value));
  if (tokens.length) out.push({ field: path || 'conditions', tokens, scan: 'all' });
}

function fragmentsFor(rule: RuleCandidate): Fragment[] {
  const out: Fragment[] = [];
  const push = (field: string, text: unknown) => {
    if (text == null) return;
    const tokens = tokenise(String(text));
    if (tokens.length) out.push({ field, tokens, scan: 'all' });
  };
  push('code', rule.code);
  push('label', rule.label);
  push('description', rule.description);
  push('serviceCode', rule.serviceCode);
  push('serviceTitle', rule.serviceTitle);
  push('serviceCategory', rule.serviceCategory);
  push('lineKind', rule.lineKind);
  push('audience', rule.audience);
  flattenConditions(rule.conditions, 'conditions', out);
  return out;
}

function findAll(
  fragments: Fragment[],
  terms: readonly string[],
  signal: Evidence['signal']
): Evidence[] {
  const found: Evidence[] = [];
  const seen = new Set<string>();
  for (const f of fragments) {
    if (f.scan === 'delivery_only' && signal !== 'delivery_context') continue;
    for (const term of terms) {
      if (!containsPhrase(f.tokens, term)) continue;
      const key = `${signal}:${term}:${f.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ signal, term, field: f.field });
    }
  }
  return found;
}

// ─── The predicate ──────────────────────────────────────────────────────────

const quote = (v: unknown) => (v == null || v === '' ? '(unnamed)' : String(v));

function listTerms(evidence: Evidence[]): string {
  const parts = evidence.map((e) => `"${e.term}" in ${e.field}`);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Decide whether a fee rule levies a charge on somebody for being a student.
 *
 * Pure, total, and deterministic: the same candidate always yields the same
 * verdict, which is what lets the refusal be quoted back to whoever wrote the
 * rule. It never throws — a malformed candidate simply produces little evidence
 * — because a guard that can crash is a guard somebody wraps in a try/catch
 * that swallows it.
 */
export function classifyFeeRule(rule: RuleCandidate): StudentRuleVerdict {
  const fragments = fragmentsFor(rule);

  const strong = findAll(fragments, STANDING_STRONG, 'standing');
  const weak = findAll(fragments, STANDING_WEAK, 'standing');
  const delivery = findAll(fragments, DELIVERY_CONTEXT, 'delivery_context');

  // A weak standing term beside a delivered service is describing the service.
  // A strong one is not.
  const standingEvidence = strong.length ? strong : (delivery.length ? [] : weak);
  const shape: ChargeShape = standingEvidence.length ? 'standing' : 'delivery';

  const students = findAll(fragments, STUDENT_TERMS, 'student');
  const roles = findAll(fragments, FEDERATION_ROLE_TERMS, 'federation_role');
  const orgs = findAll(fragments, ORGANISATION_TERMS, 'organisation');

  const audience = (rule.audience ?? '').trim().toLowerCase();
  const orgAudience = ORGANISATION_AUDIENCES.has(audience);

  // STUDENT EVIDENCE WINS OVER A ROLE, and that ordering is load-bearing.
  // "Athlete and coach membership" charges athletes. Reading the presence of
  // 'coach' as permission would let one extra word re-open the whole category.
  let payer: PayerRelationship;
  let payerEvidence: Evidence[];
  if (students.length) {
    payer = 'receives_training';
    payerEvidence = students;
  } else if (roles.length) {
    payer = 'acts_for_federation';
    payerEvidence = roles;
  } else if (orgs.length || orgAudience) {
    payer = 'organisation';
    payerEvidence = orgs;
  } else {
    payer = 'unstated';
    payerEvidence = [];
  }

  const evidence = [...standingEvidence, ...delivery, ...payerEvidence];
  const name = quote(rule.code) === '(unnamed)' ? quote(rule.label) : quote(rule.code);
  const label = quote(rule.label);

  const allow = (): StudentRuleVerdict => ({
    studentCharge: false, shape, payer, evidence, refusal: null, refusalCode: null,
  });
  const refuse = (refusalCode: StudentRefusalCode, refusal: string): StudentRuleVerdict => ({
    studentCharge: true, shape, payer, evidence, refusal, refusalCode,
  });

  // ── 1. Is anything being charged for STANDING? ──
  //
  // No: it is a charge for something delivered, and a student paying for what
  // the federation delivers is the entire point. Nothing to refuse.
  if (shape !== 'standing') return allow();

  const because = listTerms(standingEvidence);

  // ── 2. Who pays? ──
  if (payer === 'receives_training') {
    return refuse(
      'student_standing_charge',
      `Fee rule ${name} ("${label}") is refused: it charges somebody for STANDING with the federation — ` +
      `${because} — and the payer is somebody who RECEIVES TRAINING (${listTerms(payerEvidence)}). ` +
      'A student does not pay a membership fee for being a student. They pay for TRAINING, and an account, ' +
      'a profile, an enrolment and a place in a class are what having a student means rather than products ' +
      'to be sold. If this rule prices something the federation actually delivers — a class, a camp, a ' +
      'grading, an entry — name it for that, and it will be created. If it prices standing, it must not exist.'
    );
  }

  if (payer === 'acts_for_federation') {
    // The coach, official and examiner memberships. Standing is exactly what
    // they are for, and the federation charges them deliberately.
    return allow();
  }

  if (payer === 'organisation') {
    if (PER_TRAINEE_KINDS.has(String(rule.kind ?? ''))) {
      return refuse(
        'per_trainee_standing_charge',
        `Fee rule ${name} ("${label}") is refused: it is a ${rule.kind} rule — one charge per TRAINEE — ` +
        `for standing rather than for delivery (${because}). Billing the institution does not change who ` +
        'the charge is levied on: a school programme creates no per-child membership and a corporate ' +
        'programme creates no per-employee membership. Price the programme, or price the training; ' +
        'do not price each participant\'s standing.'
      );
    }
    // A dojo affiliation, a club membership, an institutional charter. A body,
    // not a person receiving training.
    return allow();
  }

  // ── 3. It does not say who pays ──
  //
  // Which means it applies to individuals, which includes students. See the
  // header: this is the fail-closed reading and the cure is one line.
  if (PER_TRAINEE_KINDS.has(String(rule.kind ?? ''))) {
    return refuse(
      'per_trainee_standing_charge',
      `Fee rule ${name} ("${label}") is refused: it charges for standing (${because}) once per ` +
      'participant, and a participant is somebody receiving training. Price the training itself.'
    );
  }

  const audienceSaid = audience
    ? `its audience is '${audience}'`
    : 'it sets no audience, so computeFee() applies it to every request';
  return refuse(
    'unattributed_standing_charge',
    `Fee rule ${name} ("${label}") is refused: it charges for STANDING with the federation ` +
    `(${because}), ${audienceSaid}, and it never says which people it is for. ` +
    'A rule like this is reachable by a student, and a student does not pay a membership fee for being ' +
    'a student. Say who pays and it will be created — a coach, an official, an examiner, a dojo or an ' +
    "institution, e.g. conditions: { category: 'instructor' }. " +
    'A membership category the federation cannot name is one it should not charge.'
  );
}

/** The predicate on its own, for a caller that only wants the yes or no. */
export function isStudentCharge(rule: RuleCandidate): boolean {
  return classifyFeeRule(rule).studentCharge;
}

/**
 * Refuse loudly.
 *
 * Exported for seeds, migration scripts and any future authoring path, so the
 * rule does not depend on those callers going through addRule(). fees.ts uses
 * classifyFeeRule() directly and raises its own FeeError, which is what its
 * existing callers already know how to render.
 */
export function assertNoStudentCharge(rule: RuleCandidate): StudentRuleVerdict {
  const verdict = classifyFeeRule(rule);
  if (verdict.studentCharge) throw new StudentChargeRefused(verdict);
  return verdict;
}

/**
 * Judge a whole framework at once.
 *
 * The second enforcement point, and the more important of the two. addRule()
 * catches an author; this catches a SEED, a MIGRATION or a hand-written INSERT
 * that never went through addRule() at all — because publishing is the moment a
 * framework starts pricing real requests, and nothing may be frozen into force
 * without being read.
 */
export function findStudentCharges(rules: readonly RuleCandidate[]): Array<{
  rule: RuleCandidate;
  verdict: StudentRuleVerdict;
}> {
  const out: Array<{ rule: RuleCandidate; verdict: StudentRuleVerdict }> = [];
  for (const rule of rules) {
    const verdict = classifyFeeRule(rule);
    if (verdict.studentCharge) out.push({ rule, verdict });
  }
  return out;
}

// ─── The fee_schedule register ──────────────────────────────────────────────

/** A `fee_schedule` row, reduced to what decides whether it may charge anyone. */
export interface ScheduledFeeCandidate {
  /** `fee_schedule.code` — 'membership.athlete.annual'. */
  code?: string | null;
  /** `fee_schedule.label` — what the order line and the receipt will say. */
  label?: string | null;
  /** `fee_schedule.kind`, an `order_line_kind`: 'membership', 'grading', … */
  kind?: string | null;
}

/**
 * Judge a row of the SECOND fee register — the one people are actually charged
 * from.
 *
 * Same predicate, same vocabulary, same refusals; only the field names differ,
 * and `kind` is carried across as `lineKind` so that a row whose name says
 * nothing is still judged on the column that says what it is. Deliberately the
 * same function underneath rather than a parallel one: two predicates for one
 * rule drift, and the one that drifts is always the one nobody is reading.
 */
export function classifyScheduledFee(fee: ScheduledFeeCandidate): StudentRuleVerdict {
  return classifyFeeRule({
    code: fee.code ?? null,
    label: fee.label ?? null,
    lineKind: fee.kind ?? null,
  });
}

/** Refuse loudly. For seeds and migrations that write `fee_schedule` directly. */
export function assertNoStudentFee(fee: ScheduledFeeCandidate): StudentRuleVerdict {
  const verdict = classifyScheduledFee(fee);
  if (verdict.studentCharge) throw new StudentChargeRefused(verdict);
  return verdict;
}

// ─── The membership register ────────────────────────────────────────────────

/**
 * The `membership_category` values that name somebody who RECEIVES TRAINING.
 *
 * The enum is athlete | instructor | dojo | official. Exactly one of those is a
 * person the federation teaches; the other three act for it or are a body. The
 * set is stated once, here, because src/db/revenue.ts had its own private copy
 * saying that an athlete membership was "withdrawn on 17 August 2026" and that
 * "nothing can create another" — while configureTerm() would still record that
 * a fee BUYS one and renew() would still issue it. A rule asserted in the
 * reporting layer and nowhere else is a caption, not a control.
 *
 * NOT REMOVED FROM THE ENUM, and that is deliberate. Athlete memberships issued
 * before the withdrawal are real rows that /verify, the member's own page and
 * every revenue report must keep reading exactly as they are. What is refused
 * is CREATING another, which is a different thing from erasing the last one.
 */
export const STUDENT_MEMBERSHIP_CATEGORIES: ReadonlySet<string> = new Set(['athlete']);

export function isStudentMembershipCategory(category: unknown): boolean {
  return typeof category === 'string' && STUDENT_MEMBERSHIP_CATEGORIES.has(category);
}
