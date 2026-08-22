// Institutional applications — schools, corporates, universities, government,
// NGOs and community bodies asking MMAKF to run a programme.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FEDERATION'S ACTUAL COMPLAINT
// ─────────────────────────────────────────────────────────────────────────────
//
// "DO NOT REQUIRE AN ADMINISTRATOR TO MANUALLY COPY DATA BETWEEN SYSTEMS."
//
// So a submission does all of this, in one transaction-per-step run that can be
// replayed safely: institution record, contact, lead, training request, owner,
// task, timeline, acknowledgement, SLA clock. The administrator's first sight
// of the application is a task in their queue with everything already in place.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE STEPS ARE DATA
// ─────────────────────────────────────────────────────────────────────────────
//
// WIZARD_STEPS below is the single definition of the twenty steps. The wizard
// UI renders from it, the server validates against it, and the progress
// indicator counts it. Three copies of "which fields are on step 4" is three
// chances for the form to accept something the server rejects, which the
// applicant experiences as the form losing their work.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS NOT INVENTED
// ─────────────────────────────────────────────────────────────────────────────
//
// No fee is quoted here. No turnaround time is promised unless the federation
// has set one — `slaDueAt` stays NULL and the applicant is told the application
// is received, not that somebody will call within 48 hours. No programme is
// described as available that is not published.

import { and, asc, desc, eq, inArray, isNull, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as o from './operations.schema';
import * as e from './engagement.schema';
// The federation's own geography, for resolving a typed state name onto the
// unit that would answer an individual's enquiry.
import { stateUnits } from './schema';
import { allocateFederationId, writeAudit, type AuditContext } from './federation';
import { activeFramework, computeFee } from './fees';
// The federation has FINISHED with these. One definition, in the module that
// wrote the reasoning down — an application the office has declined is not an
// application waiting for a quotation, and two lists that drifted apart would
// have one screen chasing schools another screen had already answered.
import { CLOSED_APPLICATION_STATUSES } from './auto-quote';
import {
  captureLead, resolveInstitution, submitTrainingRequest, isEngagementError,
  type Audience, type LeadSource, AUDIENCES,
} from './engagement';
import { isUniqueViolation } from './pgerror';
import {
  assertCanAnywhere, canAnywhere, visibleScopes,
  type Principal, type Role,
} from '@/lib/rbac';

type DB = any;

export class ApplicationError extends Error {
  readonly code: string;
  readonly field?: string;
  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.field = field;
  }
}

/** Shape check, not `instanceof` — see the note in src/lib/workflow.ts. */
export function isApplicationError(err: unknown): err is ApplicationError {
  return !!err && typeof err === 'object' && (err as any).name === 'ApplicationError'
    && typeof (err as any).code === 'string';
}

// ─── The system actor ───────────────────────────────────────────────────────

/**
 * Who the federation is acting as when it processes a public submission.
 *
 * A school filling in the wizard is not signed in and holds no authority, but
 * creating an institution record demands 'engagement:write'. Rather than
 * loosening that check — which would leave the endpoint able to write federation
 * records on an anonymous caller's say-so — the intake path acts explicitly AS
 * THE FEDERATION, under a label that says so in every audit row it writes.
 *
 * The important property: this principal is constructed here and never derived
 * from a request. No header, cookie or body field can cause a caller to be
 * treated as the system.
 */
export function systemIntakePrincipal(): Principal {
  return {
    userId: null,
    label: 'system:application-intake',
    bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
  };
}

export function systemIntakeContext(requestId?: string | null): AuditContext {
  return {
    principal: systemIntakePrincipal(),
    requestId: requestId ?? null,
    reason: 'Automatic processing of a public institutional application.',
    authority: 'MMAKF application intake',
  };
}

// ─── The twenty steps ───────────────────────────────────────────────────────

export interface WizardField {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'email' | 'tel' | 'date' | 'select' | 'multiselect' | 'boolean';
  required?: boolean;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
}

export interface WizardStep {
  step: number;
  key: string;
  title: string;
  intro?: string;
  fields: WizardField[];
}

const AGE_BAND_OPTIONS = [
  { value: '4-6', label: '4 to 6' },
  { value: '7-9', label: '7 to 9' },
  { value: '10-12', label: '10 to 12' },
  { value: '13-15', label: '13 to 15' },
  { value: '16-18', label: '16 to 18' },
  { value: 'adult', label: 'Adults' },
];

const MODE_OPTIONS = [
  { value: 'on_site', label: 'At our premises' },
  { value: 'at_dojo', label: 'At an MMAKF centre' },
  { value: 'online', label: 'Online' },
  { value: 'hybrid', label: 'A combination' },
];

/**
 * The twenty steps, in order.
 *
 * `required` is used sparingly and on purpose. An institution that does not yet
 * know how many batches it wants must still be able to finish the form — an
 * enquiry blocked on a field the enquirer cannot answer is an enquiry the
 * federation never receives. Only the four things without which the application
 * cannot be acted on at all are mandatory: who you are, where you are, what you
 * want, and how to reach you.
 */
export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    step: 1, key: 'identity', title: 'Your institution',
    fields: [
      { name: 'institutionName', label: 'Institution name', kind: 'text', required: true },
      { name: 'institutionType', label: 'Type of institution', kind: 'select', required: true, options: [
        { value: 'school', label: 'School' },
        { value: 'university', label: 'University or college' },
        { value: 'corporate', label: 'Company' },
        { value: 'government', label: 'Government or public body' },
        { value: 'ngo', label: 'NGO or trust' },
        { value: 'club', label: 'Club or sports body' },
        { value: 'community', label: 'Community organisation' },
        { value: 'other', label: 'Something else' },
      ]},
      { name: 'website', label: 'Website', kind: 'text' },
    ],
  },
  {
    step: 2, key: 'campus', title: 'Where the training would happen',
    fields: [
      { name: 'campusName', label: 'Campus or branch name', kind: 'text' },
      { name: 'addressLine', label: 'Address', kind: 'textarea' },
      { name: 'city', label: 'City or town', kind: 'text', required: true },
      { name: 'stateName', label: 'State', kind: 'text', required: true },
      { name: 'postcode', label: 'PIN code', kind: 'text' },
      { name: 'campusCount', label: 'How many campuses would take part?', kind: 'number', min: 1 },
    ],
  },
  {
    step: 3, key: 'population', title: 'Your community',
    intro: 'This helps size the programme. An estimate is fine.',
    fields: [
      { name: 'populationCount', label: 'Total students or employees', kind: 'number', min: 0 },
    ],
  },
  {
    step: 4, key: 'ages', title: 'Who would take part',
    fields: [
      { name: 'ageBands', label: 'Age groups', kind: 'multiselect', options: AGE_BAND_OPTIONS },
    ],
  },
  {
    step: 5, key: 'participants', title: 'How many participants',
    fields: [
      { name: 'participantCount', label: 'Expected participants', kind: 'number', min: 1,
        help: 'The number who would actually train, not the whole institution.' },
    ],
  },
  {
    step: 6, key: 'batches', title: 'Batches',
    fields: [
      { name: 'batchCount', label: 'How many separate batches?', kind: 'number', min: 1,
        help: 'Leave blank if you would like MMAKF to advise.' },
    ],
  },
  {
    step: 7, key: 'requirements', title: 'What you are looking for',
    fields: [
      { name: 'requirements', label: 'Describe what you need', kind: 'textarea', required: true },
      { name: 'programTemplateSlug', label: 'A published programme, if one fits', kind: 'select' },
    ],
  },
  {
    step: 8, key: 'frequency', title: 'How often',
    fields: [
      { name: 'frequencyPerWeek', label: 'Sessions per week', kind: 'number', min: 1, max: 14 },
    ],
  },
  {
    step: 9, key: 'duration', title: 'For how long',
    fields: [
      { name: 'durationWeeks', label: 'Duration in weeks', kind: 'number', min: 1 },
      { name: 'preferredStart', label: 'Preferred start date', kind: 'date' },
    ],
  },
  {
    step: 10, key: 'mode', title: 'Where and how',
    fields: [
      { name: 'mode', label: 'Delivery', kind: 'select', options: MODE_OPTIONS },
    ],
  },
  {
    step: 11, key: 'infrastructure', title: 'Your facilities',
    intro: 'Karate needs a clear, safe floor. Tell us what you have.',
    fields: [
      { name: 'hasHall', label: 'An indoor hall or covered space', kind: 'boolean' },
      { name: 'hasMats', label: 'Mats', kind: 'boolean' },
      { name: 'hasChangingRooms', label: 'Changing rooms', kind: 'boolean' },
      { name: 'floorArea', label: 'Approximate floor area', kind: 'text' },
      { name: 'infrastructureNotes', label: 'Anything else about the space', kind: 'textarea' },
    ],
  },
  {
    step: 12, key: 'instructors', title: 'Instructors',
    fields: [
      { name: 'instructorsRequired', label: 'How many instructors do you expect to need?', kind: 'number', min: 1 },
      { name: 'instructorRequirement', label: 'Any specific requirement', kind: 'textarea',
        help: 'For example a female instructor for a girls-only batch, or a particular language.' },
    ],
  },
  {
    step: 13, key: 'assessment', title: 'Assessment',
    fields: [
      { name: 'wantsAssessment', label: 'Include periodic assessment', kind: 'boolean' },
      { name: 'wantsGrading', label: 'Include MMAKF grading examinations', kind: 'boolean' },
    ],
  },
  {
    step: 14, key: 'certification', title: 'Certification',
    fields: [
      { name: 'wantsCertification', label: 'Include MMAKF certificates for participants', kind: 'boolean' },
    ],
  },
  {
    step: 15, key: 'competition', title: 'Competition',
    fields: [
      { name: 'wantsCompetition', label: 'Prepare participants for competition', kind: 'boolean' },
    ],
  },
  {
    step: 16, key: 'special', title: 'Anything else',
    fields: [
      { name: 'specialRequirements', label: 'Special requirements', kind: 'textarea',
        help: 'Accessibility, medical considerations, timings, anything we should know.' },
    ],
  },
  {
    step: 17, key: 'contact', title: 'Who we should speak to',
    fields: [
      { name: 'contactName', label: 'Full name', kind: 'text', required: true },
      { name: 'contactRole', label: 'Role at the institution', kind: 'text' },
      { name: 'contactEmail', label: 'Email', kind: 'email', required: true },
      { name: 'contactPhone', label: 'Telephone', kind: 'tel' },
    ],
  },
  {
    step: 18, key: 'decision', title: 'Who approves this',
    intro: 'If it is you, say so — it saves a round of emails.',
    fields: [
      { name: 'decisionMakerName', label: 'Name', kind: 'text' },
      { name: 'decisionMakerRole', label: 'Role', kind: 'text' },
      { name: 'decisionMakerEmail', label: 'Email', kind: 'email' },
    ],
  },
  { step: 19, key: 'review', title: 'Check your answers', fields: [] },
  { step: 20, key: 'submit', title: 'Send to MMAKF', fields: [] },
];

export const TOTAL_STEPS = WIZARD_STEPS.length;

export function stepByKey(key: string): WizardStep | null {
  return WIZARD_STEPS.find((s) => s.key === key) ?? null;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface FieldProblem { field: string; message: string; step: number }

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Validate a payload against the step definitions.
 *
 * Returns EVERY problem rather than the first. A twenty-step form that reports
 * one error at a time is a form people abandon, and an abandoned application is
 * a school the federation never hears from again.
 */
export function validateSubmission(payload: Record<string, unknown>): FieldProblem[] {
  const problems: FieldProblem[] = [];

  for (const step of WIZARD_STEPS) {
    for (const f of step.fields) {
      const v = payload[f.name];

      if (f.required && isBlank(v)) {
        problems.push({ field: f.name, message: `${f.label} is needed.`, step: step.step });
        continue;
      }
      if (isBlank(v)) continue;

      if (f.kind === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          problems.push({ field: f.name, message: `${f.label} must be a number.`, step: step.step });
        } else if (f.min !== undefined && n < f.min) {
          problems.push({ field: f.name, message: `${f.label} cannot be below ${f.min}.`, step: step.step });
        } else if (f.max !== undefined && n > f.max) {
          problems.push({ field: f.name, message: `${f.label} cannot be above ${f.max}.`, step: step.step });
        }
      }

      if (f.kind === 'email' && typeof v === 'string' && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v.trim())) {
        problems.push({ field: f.name, message: `${f.label} does not look like an email address.`, step: step.step });
      }

      if (f.kind === 'date' && typeof v === 'string' && Number.isNaN(Date.parse(v))) {
        problems.push({ field: f.name, message: `${f.label} is not a date we can read.`, step: step.step });
      }

      if (f.kind === 'select' && f.options && typeof v === 'string'
          && !f.options.some((opt) => opt.value === v)) {
        problems.push({ field: f.name, message: `${f.label} is not one of the choices.`, step: step.step });
      }

      if (f.kind === 'multiselect' && f.options) {
        const arr = Array.isArray(v) ? v : [v];
        for (const item of arr) {
          if (!f.options.some((opt) => opt.value === item)) {
            problems.push({ field: f.name, message: `"${String(item)}" is not one of the choices for ${f.label}.`, step: step.step });
          }
        }
      }
    }
  }

  // Cross-field: participants cannot exceed the institution's own population.
  const pop = Number(payload.populationCount);
  const part = Number(payload.participantCount);
  if (Number.isFinite(pop) && Number.isFinite(part) && pop > 0 && part > pop) {
    problems.push({
      field: 'participantCount',
      message: `You have said ${part} participants out of a community of ${pop}. One of those is probably a typing slip.`,
      step: 5,
    });
  }

  return problems;
}

// ─── Lead scoring ───────────────────────────────────────────────────────────

export interface LeadScore { score: number; reasons: string[] }

/**
 * Triage, and nothing more.
 *
 * This orders a queue. It does not decide whether the federation works with an
 * institution, and nothing in this file lets it: `score` is stored beside the
 * application and read by the sort, never by a gate.
 *
 * Every component is stated in `reasons`, so an administrator can see why one
 * enquiry is above another and disagree with it. A score nobody can explain is
 * a score nobody should act on.
 */
export function scoreApplication(app: {
  participantCount?: number | null;
  campusCount?: number | null;
  populationCount?: number | null;
  audience?: string | null;
  decisionMakerEmail?: string | null;
  preferredStart?: string | null;
  durationWeeks?: number | null;
  wantsCertification?: boolean | null;
  requirements?: string | null;
}, now: Date = new Date()): LeadScore {
  let score = 0;
  const reasons: string[] = [];

  const p = Number(app.participantCount);
  if (Number.isFinite(p) && p > 0) {
    const band = p >= 500 ? 30 : p >= 200 ? 25 : p >= 100 ? 20 : p >= 50 ? 15 : p >= 20 ? 10 : 5;
    score += band;
    reasons.push(`${p} participants (+${band})`);
  } else {
    reasons.push('participant count not stated (+0)');
  }

  const c = Number(app.campusCount);
  if (Number.isFinite(c) && c > 1) {
    const band = Math.min(15, c * 3);
    score += band;
    reasons.push(`${c} campuses (+${band})`);
  }

  const w = Number(app.durationWeeks);
  if (Number.isFinite(w) && w >= 24) { score += 15; reasons.push(`${w}-week commitment (+15)`); }
  else if (Number.isFinite(w) && w >= 12) { score += 10; reasons.push(`${w}-week commitment (+10)`); }

  if (app.decisionMakerEmail) {
    score += 10;
    reasons.push('the approver is named (+10)');
  }

  if (app.preferredStart) {
    const days = (Date.parse(app.preferredStart) - now.getTime()) / 86_400_000;
    if (Number.isFinite(days) && days >= 0 && days <= 60) {
      score += 10;
      reasons.push(`wants to start within ${Math.round(days)} days (+10)`);
    }
  }

  if (app.wantsCertification) { score += 5; reasons.push('wants MMAKF certification (+5)'); }

  const detail = (app.requirements ?? '').trim().length;
  if (detail >= 200) { score += 10; reasons.push('detailed requirements (+10)'); }
  else if (detail >= 60) { score += 5; reasons.push('some detail given (+5)'); }

  return { score: Math.min(100, score), reasons };
}

// ─── Routing ────────────────────────────────────────────────────────────────

export interface RoutingDecision {
  ruleId: number | null;
  targetRole: string | null;
  targetUserId: number | null;
  department: string | null;
  /** Says what happened, including when nothing matched. */
  explanation: string;
}

/**
 * Decide who owns an application.
 *
 * MOST SPECIFIC WINS. Specificity is the number of conditions a rule actually
 * states — a rule naming audience AND district beats one naming audience alone,
 * whatever their priorities. Priority only breaks ties between rules of equal
 * specificity, and the lowest id breaks ties after that, so the outcome is
 * deterministic and does not depend on row order.
 *
 * NO MATCH IS NOT AN ERROR AND NOT A GUESS. The application stays unowned and
 * appears in the unassigned queue. Assigning it to an arbitrary administrator
 * would look like routing while producing work nobody has agreed to do.
 */
export async function routeApplication(
  db: DB,
  app: {
    audience: string;
    stateUnitId?: number | null;
    districtUnitId?: number | null;
    serviceId?: number | null;
    participantCount?: number | null;
  }
): Promise<RoutingDecision> {
  const rules = await db.select().from(o.routingRules)
    .where(eq(o.routingRules.active, true))
    .orderBy(desc(o.routingRules.priority), asc(o.routingRules.id));

  const participants = Number(app.participantCount);

  const matches = rules
    .map((r: any) => {
      let specificity = 0;
      const check = (stated: boolean, ok: boolean) => {
        if (!stated) return true;      // an unstated condition constrains nothing
        if (!ok) return false;
        specificity++;
        return true;
      };

      if (!check(r.audience != null, r.audience === app.audience)) return null;
      if (!check(r.stateUnitId != null, r.stateUnitId === app.stateUnitId)) return null;
      if (!check(r.districtUnitId != null, r.districtUnitId === app.districtUnitId)) return null;
      if (!check(r.serviceId != null, r.serviceId === app.serviceId)) return null;
      if (!check(r.minParticipants != null, Number.isFinite(participants) && participants >= r.minParticipants)) return null;
      if (!check(r.maxParticipants != null, Number.isFinite(participants) && participants <= r.maxParticipants)) return null;

      return { rule: r, specificity };
    })
    .filter(Boolean) as Array<{ rule: any; specificity: number }>;

  if (!matches.length) {
    return {
      ruleId: null, targetRole: null, targetUserId: null, department: null,
      explanation: 'No routing rule matched, so the application is unassigned and waiting in the national queue.',
    };
  }

  matches.sort((a, b) =>
    b.specificity - a.specificity ||
    b.rule.priority - a.rule.priority ||
    a.rule.id - b.rule.id
  );

  const winner = matches[0];
  return {
    ruleId: winner.rule.id,
    targetRole: winner.rule.targetRole ?? null,
    targetUserId: winner.rule.targetUserId ?? null,
    department: winner.rule.department ?? null,
    explanation:
      `Matched "${winner.rule.label}" on ${winner.specificity} condition(s)` +
      (matches.length > 1 ? `, ahead of ${matches.length - 1} less specific rule(s).` : '.'),
  };
}

// ─── The applicant's key ────────────────────────────────────────────────────
//
// One application, one secret. It is the ONLY thing standing between a school's
// submission and anybody who can count — refs are sequence-allocated
// (MMAKF-APP-2026-000001) so the next one along is always guessable, and what
// it would unlock is another institution's contact details, participant numbers
// and requirements.
//
// Three properties, and all three are needed:
//
//   1. UNGUESSABLE. 32 random bytes from the CSPRNG, base64url. Not a hash of
//      the ref, not a counter, not a timestamp — anything derived from data the
//      applicant can see is not a secret.
//   2. COMPARED IN CONSTANT TIME. See tokensMatch().
//   3. LOOKED UP THE SAME WAY EVERYWHERE. Every path that accepts a token —
//      resuming a draft, submitting a resumed draft, reading the status page —
//      goes through applicationByRefAndToken() below. A second copy of this
//      comparison is a second chance to write `===`.

const ACCESS_TOKEN_BYTES = 32;

/** A fresh key. The only place one is minted. */
function newAccessToken(): string {
  return crypto.randomBytes(ACCESS_TOKEN_BYTES).toString('base64url');
}

/**
 * Compare the key on file with the key presented, without leaking it.
 *
 * `===` on strings stops at the first differing byte. That difference is
 * measurable over enough requests, and it lets an attacker recover the token
 * one character at a time rather than guessing 256 bits at once.
 *
 * Both sides are hashed BEFORE the comparison so timingSafeEqual always gets
 * two buffers of identical length. The obvious alternative — test the lengths,
 * then compare — puts the length itself on the fast path, and the length is
 * information the holder of the real token never volunteered.
 */
function tokensMatch(stored: string | null | undefined, supplied: string | null | undefined): boolean {
  if (!stored || !supplied) return false;
  const a = crypto.createHash('sha256').update(String(stored), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(supplied), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * A value that matches nothing, compared against when the reference itself is
 * unknown.
 *
 * Without it, "no such application" returns before any hashing happens and
 * "wrong key" returns after it. That difference turns the status page into an
 * oracle for which references exist, which is exactly what the page's single
 * shared failure message was written to prevent.
 */
const NO_SUCH_APPLICATION = crypto.randomBytes(ACCESS_TOKEN_BYTES).toString('base64url');

/**
 * Load one application by reference AND key, or nothing.
 *
 * The reference selects the row and the key authorises it. Note that the key is
 * NOT part of the WHERE clause: a SQL string comparison is the database's
 * business to optimise, and `=` on a text column is free to stop early. The row
 * comes back on the reference — which is guessable and guards nothing — and the
 * secret is checked here, once, in constant time.
 *
 * Returns null for every failure. The caller cannot tell an unknown reference
 * from a wrong key, and neither can the person holding it.
 */
async function applicationByRefAndToken(db: DB, ref: unknown, suppliedToken: unknown) {
  const r = String(ref ?? '').trim();
  const t = String(suppliedToken ?? '');
  if (!r || !t) return null;

  const [app] = await db.select().from(o.institutionApplications)
    .where(eq(o.institutionApplications.ref, r)).limit(1);

  if (!app) {
    tokensMatch(NO_SUCH_APPLICATION, t);
    return null;
  }
  if (!tokensMatch(app.accessToken, t)) return null;
  return app;
}

// ─── Drafts ─────────────────────────────────────────────────────────────────

function toNumberOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toBoolOrNull(v: unknown): boolean | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'on' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === 'off' || v === '0' || v === 'no') return false;
  return null;
}

function normaliseAudience(v: unknown): Audience {
  const s = String(v ?? '').trim().toLowerCase();
  return (AUDIENCES as readonly string[]).includes(s) ? (s as Audience) : 'other';
}

/** Map the flat wizard payload onto the application columns. */
function columnsFromPayload(payload: Record<string, unknown>) {
  const ageBands = payload.ageBands === undefined || payload.ageBands === null
    ? null
    : Array.isArray(payload.ageBands) ? payload.ageBands : [payload.ageBands];

  return {
    audience: normaliseAudience(payload.institutionType),
    institutionName: String(payload.institutionName ?? '').trim(),
    campusName: (payload.campusName as string) || null,
    addressLine: (payload.addressLine as string) || null,
    city: (payload.city as string) || null,
    postcode: (payload.postcode as string) || null,
    stateName: (payload.stateName as string) || null,
    populationCount: toNumberOrNull(payload.populationCount),
    participantCount: toNumberOrNull(payload.participantCount),
    batchCount: toNumberOrNull(payload.batchCount),
    campusCount: toNumberOrNull(payload.campusCount),
    ageBands: ageBands as any,
    requirements: (payload.requirements as string) || null,
    frequencyPerWeek: toNumberOrNull(payload.frequencyPerWeek),
    durationWeeks: toNumberOrNull(payload.durationWeeks),
    mode: (['on_site', 'at_dojo', 'online', 'hybrid'].includes(String(payload.mode))
      ? String(payload.mode) : null) as any,
    infrastructure: {
      hasHall: toBoolOrNull(payload.hasHall),
      hasMats: toBoolOrNull(payload.hasMats),
      hasChangingRooms: toBoolOrNull(payload.hasChangingRooms),
      floorArea: (payload.floorArea as string) || null,
      notes: (payload.infrastructureNotes as string) || null,
    } as any,
    instructorRequirement: (payload.instructorRequirement as string) || null,
    instructorsRequired: toNumberOrNull(payload.instructorsRequired),
    wantsAssessment: toBoolOrNull(payload.wantsAssessment),
    wantsGrading: toBoolOrNull(payload.wantsGrading),
    wantsCertification: toBoolOrNull(payload.wantsCertification),
    wantsCompetition: toBoolOrNull(payload.wantsCompetition),
    specialRequirements: (payload.specialRequirements as string) || null,
    contactName: (payload.contactName as string) || null,
    contactRole: (payload.contactRole as string) || null,
    contactEmail: (payload.contactEmail as string) || null,
    contactPhone: (payload.contactPhone as string) || null,
    decisionMakerName: (payload.decisionMakerName as string) || null,
    decisionMakerRole: (payload.decisionMakerRole as string) || null,
    decisionMakerEmail: (payload.decisionMakerEmail as string) || null,
    preferredStart: (payload.preferredStart as string) || null,
  };
}

export interface DraftInput {
  /** Continue an existing draft. Requires the token issued when it was started. */
  ref?: string | null;
  accessToken?: string | null;
  payload: Record<string, unknown>;
  stepReached?: number;
  source?: Record<string, unknown> | null;
  now?: Date;
}

/**
 * Start or continue a draft.
 *
 * Drafts exist because the form is twenty steps long and people are
 * interrupted. Resuming needs the token, not just the reference, for the same
 * reason the status page does.
 */
export async function saveDraft(db: DB, input: DraftInput) {
  const now = input.now ?? new Date();
  const cols = columnsFromPayload(input.payload);

  if (!cols.institutionName) {
    throw new ApplicationError('no_name', 'The institution needs a name before the draft can be saved.', 'institutionName');
  }

  if (input.ref) {
    if (!input.accessToken) {
      throw new ApplicationError('token_required', 'Resuming a draft needs the link that was issued with it.');
    }
    const existing = await applicationByRefAndToken(db, input.ref, input.accessToken);

    if (!existing) throw new ApplicationError('not_found', 'No draft matches that link.');
    if (existing.status !== 'draft') {
      throw new ApplicationError('already_submitted', 'That application has already been sent to MMAKF.');
    }

    const [updated] = await db.update(o.institutionApplications).set({
      ...cols,
      payload: input.payload as any,
      stepReached: Math.max(existing.stepReached ?? 1, input.stepReached ?? 1),
      updatedAt: now,
    }).where(eq(o.institutionApplications.id, existing.id)).returning();

    return { ref: updated.ref, accessToken: updated.accessToken, stepReached: updated.stepReached, id: updated.id };
  }

  const ref = await allocateFederationId(db, 'APP', now.getFullYear());
  const accessToken = newAccessToken();

  const [row] = await db.insert(o.institutionApplications).values({
    ref,
    accessToken,
    status: 'draft',
    ...cols,
    payload: input.payload as any,
    source: (input.source ?? null) as any,
    stepReached: input.stepReached ?? 1,
  }).returning();

  return { ref: row.ref, accessToken: row.accessToken, stepReached: row.stepReached, id: row.id };
}

/**
 * The answers already given on a draft the applicant is resuming, or null.
 *
 * Exported so the wizard page does not have to hold its own query — and, far
 * more importantly, does not have to hold its own token comparison. It did:
 * src/pages/learn/apply.astro put `eq(accessToken, k)` straight into a WHERE
 * clause, which is the string equality this module went to some trouble to get
 * out of the resume and status paths. One page keeping its own copy is the
 * whole mechanism defeated, because an applicant only needs one door.
 *
 * Null covers every failure — unknown reference, wrong key, and an application
 * that has already been sent — because the caller's answer to all three is the
 * same: this link does not open a draft.
 */
export async function draftPayload(
  db: DB, ref: unknown, accessToken: unknown
): Promise<Record<string, unknown> | null> {
  const app = await applicationByRefAndToken(db, ref, accessToken);
  if (!app) return null;
  // A sent application is no longer editable. Returning its payload would let
  // the wizard reopen it and quietly overwrite what MMAKF is already reviewing.
  if (app.status !== 'draft') return null;
  return (app.payload ?? {}) as Record<string, unknown>;
}

// ─── Submission ─────────────────────────────────────────────────────────────

export interface SubmitInput {
  payload: Record<string, unknown>;
  /** Present when the applicant used the save-and-resume flow. */
  ref?: string | null;
  accessToken?: string | null;
  source?: Record<string, unknown> | null;
  leadSource?: LeadSource;
  landingPath?: string | null;
  now?: Date;
}

export interface SubmitResult {
  applicationId: number;
  ref: string;
  accessToken: string;
  institutionId: number | null;
  leadId: number | null;
  requestId: number | null;
  ownerRole: string | null;
  ownerUserId: number | null;
  routing: RoutingDecision;
  score: LeadScore;
  duplicateOf: string | null;
}

/**
 * Store the application and derive everything that follows from it.
 *
 * Ordering matters and is deliberate: the APPLICATION IS STORED FIRST, before
 * any derived record. If institution creation fails, the school's submission is
 * still on file with its payload intact and can be completed by hand — the
 * opposite order loses the submission and leaves a half-built institution.
 *
 * The derived records are created here rather than in the workflow engine
 * because they are not optional: an application without a lead is invisible to
 * the pipeline. The workflow handles what comes AFTER — tasks, notifications,
 * acknowledgements — which are the things that can fail and be retried without
 * the application being wrong.
 */
export async function submitApplication(db: DB, input: SubmitInput): Promise<SubmitResult> {
  const now = input.now ?? new Date();
  const payload = input.payload ?? {};

  const problems = validateSubmission(payload);
  if (problems.length) {
    throw new ApplicationError(
      'invalid',
      problems.map((p) => p.message).join(' '),
      problems[0].field
    );
  }

  const cols = columnsFromPayload(payload);
  const ctx = systemIntakeContext();

  // ── 1. The application itself ──
  let app: any;
  if (input.ref && input.accessToken) {
    const existing = await applicationByRefAndToken(db, input.ref, input.accessToken);
    if (!existing) throw new ApplicationError('not_found', 'No draft matches that link.');
    if (existing.status !== 'draft') {
      throw new ApplicationError('already_submitted', 'That application has already been sent to MMAKF.');
    }
    [app] = await db.update(o.institutionApplications).set({
      ...cols,
      payload: payload as any,
      status: 'submitted',
      submittedAt: now,
      stepReached: TOTAL_STEPS,
      updatedAt: now,
    }).where(eq(o.institutionApplications.id, existing.id)).returning();
  } else {
    const ref = await allocateFederationId(db, 'APP', now.getFullYear());
    const accessToken = newAccessToken();
    [app] = await db.insert(o.institutionApplications).values({
      ref,
      accessToken,
      status: 'submitted',
      submittedAt: now,
      stepReached: TOTAL_STEPS,
      ...cols,
      payload: payload as any,
      source: (input.source ?? null) as any,
    }).returning();
  }

  await db.insert(o.applicationEvents).values({
    applicationId: app.id, at: now, kind: 'submitted',
    summary: 'Application received by MMAKF.',
    visibleToApplicant: true,
  });

  // ── 2. Duplicate detection ──
  // Same institution name, same city, still live. Reported, never merged
  // automatically: two campuses of one trust legitimately apply separately, and
  // silently folding them together loses one school's requirements.
  const duplicate = await findDuplicate(db, app);

  // ── 3. Institution ──
  let institutionId: number | null = null;
  try {
    const resolved = await resolveInstitution(db, ctx, {
      name: app.institutionName,
      kind: app.audience as Audience,
      city: app.city,
      stateUnitId: app.stateUnitId,
      districtUnitId: app.districtUnitId,
      campusCount: app.campusCount,
      populationCount: app.populationCount,
    });
    institutionId = resolved.institutionId;
  } catch (err: any) {
    await db.insert(o.applicationEvents).values({
      applicationId: app.id, at: now, kind: 'institution_failed',
      summary: 'The institution record could not be created automatically.',
      detail: { error: String(err?.message ?? err) } as any,
      visibleToApplicant: false,
    });
  }

  // ── 4. Lead ──
  let leadId: number | null = null;
  try {
    const lead = await captureLead(db, ctx, {
      audience: app.audience as Audience,
      contactName: app.contactName,
      contactEmail: app.contactEmail,
      contactPhone: app.contactPhone,
      institutionName: app.institutionName,
      city: app.city,
      stateUnitId: app.stateUnitId,
      districtUnitId: app.districtUnitId,
      source: input.leadSource ?? 'direct',
      landingPath: input.landingPath ?? null,
      utm: (input.source ?? null) as any,
    });
    leadId = lead.leadId;
  } catch (err: any) {
    await db.insert(o.applicationEvents).values({
      applicationId: app.id, at: now, kind: 'lead_failed',
      summary: 'The lead record could not be created automatically.',
      detail: { error: String(err?.message ?? err) } as any,
      visibleToApplicant: false,
    });
  }

  // ── 5. Training request ──
  let requestId: number | null = null;
  if (app.participantCount != null) {
    try {
      const req = await submitTrainingRequest(db, ctx, {
        audience: app.audience as Audience,
        leadId,
        institutionId,
        mode: app.mode,
        parameters: {
          participants: app.participantCount,
          ageGroups: app.ageBands ?? [],
          batches: app.batchCount,
          sessionsPerWeek: app.frequencyPerWeek,
          durationWeeks: app.durationWeeks,
          campuses: app.campusCount,
          instructors: app.instructorsRequired,
          assessment: app.wantsAssessment,
          grading: app.wantsGrading,
          certification: app.wantsCertification,
          competition: app.wantsCompetition,
        },
        preferredStartOn: app.preferredStart,
        notes: app.requirements,
      });
      requestId = (req as any)?.id ?? (req as any)?.requestId ?? null;
    } catch (err: any) {
      // Not fatal. A request that cannot be built yet — usually because the
      // participant count is missing — is exactly what the reviewing
      // administrator is for.
      await db.insert(o.applicationEvents).values({
        applicationId: app.id, at: now, kind: 'request_deferred',
        summary: 'A structured training request will be created during review.',
        detail: { reason: String(err?.message ?? err) } as any,
        visibleToApplicant: false,
      });
    }
  }

  // ── 6. Routing and score ──
  const routing = await routeApplication(db, {
    audience: app.audience,
    stateUnitId: app.stateUnitId,
    districtUnitId: app.districtUnitId,
    serviceId: app.serviceId,
    participantCount: app.participantCount,
  });
  const score = scoreApplication(app, now);

  const [updated] = await db.update(o.institutionApplications).set({
    institutionId,
    leadId,
    requestId,
    ownerRole: routing.targetRole,
    ownerUserId: routing.targetUserId,
    leadScore: score.score,
    supersededByApplicationId: null,
    updatedAt: now,
  }).where(eq(o.institutionApplications.id, app.id)).returning();

  await db.insert(o.applicationEvents).values({
    applicationId: app.id, at: now, kind: 'routed',
    summary: routing.explanation,
    detail: { routing, score } as any,
    visibleToApplicant: false,
  });

  if (duplicate) {
    await db.insert(o.applicationEvents).values({
      applicationId: app.id, at: now, kind: 'possible_duplicate',
      summary: `Possibly the same institution as ${duplicate.ref}. Not merged — check before acting.`,
      detail: { otherRef: duplicate.ref, otherId: duplicate.id } as any,
      visibleToApplicant: false,
    });
  }

  await writeAudit(db, ctx, {
    entityType: 'institution_application', entityId: app.id, action: 'create',
    newValue: {
      ref: app.ref, audience: app.audience, institutionId, leadId,
      ownerRole: routing.targetRole, score: score.score,
    },
  });

  return {
    applicationId: app.id,
    ref: app.ref,
    accessToken: app.accessToken,
    institutionId,
    leadId,
    requestId,
    ownerRole: routing.targetRole,
    ownerUserId: routing.targetUserId,
    routing,
    score,
    duplicateOf: duplicate?.ref ?? null,
  };
}

/**
 * Is this the same institution applying twice?
 *
 * Name and city, case-folded, among applications that are still live. A trust
 * with several campuses legitimately submits more than once, so this REPORTS
 * and does not merge — the reviewer decides.
 */
async function findDuplicate(db: DB, app: any): Promise<{ id: number; ref: string } | null> {
  if (!app.institutionName) return null;
  const rows = await db
    .select({ id: o.institutionApplications.id, ref: o.institutionApplications.ref })
    .from(o.institutionApplications)
    .where(and(
      sql`lower(${o.institutionApplications.institutionName}) = lower(${app.institutionName})`,
      app.city
        ? sql`lower(coalesce(${o.institutionApplications.city}, '')) = lower(${app.city})`
        : sql`true`,
      sql`${o.institutionApplications.id} <> ${app.id}`,
      inArray(o.institutionApplications.status, [
        'submitted', 'acknowledged', 'under_review', 'information_requested',
        'program_design', 'awaiting_quotation', 'quoted', 'proposed', 'approved', 'contracted',
      ])
    ))
    .orderBy(desc(o.institutionApplications.id))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Review ─────────────────────────────────────────────────────────────────

export const REVIEW_STATUSES = [
  'acknowledged', 'under_review', 'information_requested', 'program_design',
  // Reachable by a human as well as by the automation (migration 0040). An
  // administrator who has read an application and knows only the training
  // office can price it should be able to say so in the same word the engine
  // uses — two vocabularies for one state is how a queue ends up half visible.
  'awaiting_quotation',
  'quoted', 'proposed', 'approved', 'contracted', 'declined', 'expired',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * What an applicant is told at each stage.
 *
 * Written out rather than generated from the status name, because "quoted" is
 * an internal word and the school should read a sentence. Note what these do
 * NOT say: no dates, no promises of a call, no turnaround. The federation has
 * not set a service standard, so the system does not invent one on its behalf.
 */
const APPLICANT_WORDING: Record<ReviewStatus, string> = {
  acknowledged: 'MMAKF has your application and it is with the training office.',
  under_review: 'MMAKF is reviewing your requirements.',
  information_requested: 'MMAKF needs a little more information from you.',
  program_design: 'MMAKF is designing a programme for your institution.',
  // NO FIGURE, NO DATE, and both omissions are deliberate. There is no amount
  // to give — that is what this state means — and the federation has published
  // no turnaround, so the sentence says who has it and stops.
  awaiting_quotation:
    'MMAKF has your requirements and the training office is preparing your quotation.',
  quoted: 'A quotation has been prepared for your institution.',
  proposed: 'A proposal has been sent to your institution.',
  approved: 'Your programme has been approved.',
  contracted: 'The agreement is in place and scheduling has begun.',
  declined: 'MMAKF is not able to take this forward.',
  expired: 'This application has lapsed. You are welcome to apply again.',
};

export async function reviewApplication(
  db: DB,
  ctx: AuditContext,
  applicationId: number,
  decision: { status: ReviewStatus; note?: string | null; reason?: string | null },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'engagement:write');

  const [app] = await db.select().from(o.institutionApplications)
    .where(eq(o.institutionApplications.id, applicationId)).limit(1);
  if (!app) throw new ApplicationError('not_found', `No application ${applicationId}.`);

  if (!REVIEW_STATUSES.includes(decision.status)) {
    throw new ApplicationError('bad_status', `${decision.status} is not a review outcome.`);
  }
  if (app.status === 'draft') {
    throw new ApplicationError('not_submitted', 'That application has not been submitted yet.');
  }
  if (decision.status === 'declined' && !decision.reason?.trim()) {
    // A refusal somebody has to stand behind. The applicant may ask why, and
    // "no reason recorded" is not an answer the federation should have to give.
    throw new ApplicationError('reason_required', 'Say why the application is being declined.', 'reason');
  }

  const patch: Record<string, unknown> = { status: decision.status, updatedAt: now };
  if (decision.status === 'acknowledged' && !app.acknowledgedAt) patch.acknowledgedAt = now;
  if (!app.firstContactAt) patch.firstContactAt = now;
  if (decision.status === 'declined' || decision.status === 'approved' || decision.status === 'contracted') {
    patch.decidedAt = now;
    patch.decidedByUserId = ctx.principal.userId ?? null;
    patch.decisionReason = decision.reason ?? null;
  }

  const [updated] = await db.update(o.institutionApplications)
    .set(patch)
    .where(and(eq(o.institutionApplications.id, applicationId), eq(o.institutionApplications.status, app.status)))
    .returning();

  if (!updated) throw new ApplicationError('conflict', 'The application changed while you were working on it.');

  await db.insert(o.applicationEvents).values({
    applicationId, at: now, kind: decision.status,
    summary: APPLICANT_WORDING[decision.status],
    detail: decision.note ? { note: decision.note } as any : null,
    actorUserId: ctx.principal.userId ?? null,
    visibleToApplicant: true,
  });

  if (decision.note) {
    await db.insert(o.applicationEvents).values({
      applicationId, at: now, kind: 'note',
      summary: decision.note,
      actorUserId: ctx.principal.userId ?? null,
      visibleToApplicant: false,
    });
  }

  await writeAudit(db, { ...ctx, reason: decision.reason ?? ctx.reason }, {
    entityType: 'institution_application', entityId: applicationId, action:
      decision.status === 'approved' ? 'approve' : decision.status === 'declined' ? 'reject' : 'update',
    oldValue: { status: app.status },
    newValue: { status: decision.status },
  });

  return updated;
}

/** Hand an application to a named administrator. */
export async function assignApplication(
  db: DB, ctx: AuditContext, applicationId: number,
  target: { userId?: number | null; role?: string | null }, now = new Date()
) {
  assertCanAnywhere(ctx.principal, 'engagement:write');
  const [updated] = await db.update(o.institutionApplications).set({
    ownerUserId: target.userId ?? null,
    ownerRole: target.role ?? null,
    updatedAt: now,
  }).where(eq(o.institutionApplications.id, applicationId)).returning();

  if (!updated) throw new ApplicationError('not_found', `No application ${applicationId}.`);

  await db.insert(o.applicationEvents).values({
    applicationId, at: now, kind: 'assigned',
    summary: `Assigned to ${target.role ?? 'a named administrator'}.`,
    actorUserId: ctx.principal.userId ?? null,
    visibleToApplicant: false,
  });
  return updated;
}

// ─── Reading ────────────────────────────────────────────────────────────────

export const MAX_QUEUE_ROWS = 200;

export interface ApplicationQueueOptions {
  status?: ReviewStatus | 'submitted' | 'draft' | Array<ReviewStatus | 'submitted' | 'draft'>;
  audience?: Audience;
  ownerUserId?: number;
  unassignedOnly?: boolean;
  limit?: number;
}

export async function applicationQueue(
  db: DB, principal: Principal, opts: ApplicationQueueOptions = {}
) {
  assertCanAnywhere(principal, 'engagement:read');
  const scopes = visibleScopes(principal, 'engagement:read');
  if (scopes.kind === 'none') return [];

  const where: any[] = [
    // Drafts are the applicant's unfinished business and are not the
    // federation's to read until they are sent.
    opts.status ? sql`true` : sql`${o.institutionApplications.status} <> 'draft'`,
  ];

  if (scopes.kind === 'scoped') {
    const clauses: any[] = [];
    if (scopes.states.length) clauses.push(inArray(o.institutionApplications.stateUnitId, scopes.states));
    if (scopes.districts.length) clauses.push(inArray(o.institutionApplications.districtUnitId, scopes.districts));
    if (scopes.institutions.length) clauses.push(inArray(o.institutionApplications.institutionId, scopes.institutions));
    if (!clauses.length) return [];
    where.push(or(...clauses));
  }

  if (opts.status) {
    where.push(Array.isArray(opts.status)
      ? inArray(o.institutionApplications.status, opts.status as any)
      : eq(o.institutionApplications.status, opts.status as any));
  }
  if (opts.audience) where.push(eq(o.institutionApplications.audience, opts.audience as any));
  if (opts.ownerUserId != null) where.push(eq(o.institutionApplications.ownerUserId, opts.ownerUserId));
  if (opts.unassignedOnly) where.push(isNull(o.institutionApplications.ownerUserId));

  return db.select().from(o.institutionApplications)
    .where(and(...where))
    .orderBy(desc(o.institutionApplications.leadScore), desc(o.institutionApplications.submittedAt))
    .limit(Math.min(opts.limit ?? 50, MAX_QUEUE_ROWS));
}

export interface AwaitingQuotationRow {
  id: number;
  ref: string;
  institutionName: string;
  status: string;
  submittedAt: unknown;
  city: string | null;
  stateName: string | null;
  participantCount: number | null;
  ownerRole: string | null;
  /** False when the application produced no training request at all. */
  hasRequest: boolean;
}

export interface AwaitingQuotation {
  /** What this account can reach. 'none' is not the same statement as "there are none". */
  scope: 'all' | 'scoped' | 'none';
  /** The WHOLE queue in scope, counted in the same predicate that listed it. */
  total: number;
  /** The first `limit` of them, oldest first. */
  rows: AwaitingQuotationRow[];
  limit: number;
  /** True when `total` exceeds what `rows` holds. */
  truncated: boolean;
}

/**
 * THE NEGATIVE JOIN: open applications that have reached no quotation at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS A FUNCTION AND NOT A QUERY IN THE PAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * applicationQueue() answers "what is in this table?". It cannot answer this,
 * because the answer is about a row that DOES NOT EXIST — an application with no
 * quotation is invisible on /admin/quotes and indistinguishable on
 * /admin/applications from one that has been quoted. /admin/pipeline wrote the
 * query itself, which meant the federation's scope predicate for institutional
 * applications lived in two places and a change to one would silently not reach
 * the other. It lives here now, beside the queue it belongs with, and the page
 * calls it.
 *
 * It is also the single number that says what today's federation is waiting on.
 * With no fee framework published, computeFee() can price nothing, so every open
 * application lands here — and that claim is only worth making if a test can
 * make it, publish a framework, and watch the number move with no code change.
 * tests/loop-visible.test.ts does exactly that.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE PREDICATE IS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A LEFT JOIN from the application's training request to `quotes`, kept where
 * `quotes.id IS NULL`. That also catches an application which produced no
 * training request at all — that one has no quotation either, and for a worse
 * reason, so `hasRequest` says which it is rather than merging the two.
 *
 * Drafts are excluded because they are the applicant's unfinished business.
 * Declined, withdrawn and expired applications are excluded because they have
 * been ANSWERED: counting them would inflate the only figure on that page
 * anybody acts on, and hand somebody a list of schools to chase that the
 * federation has already replied to.
 */
export async function applicationsAwaitingQuotation(
  db: DB, principal: Principal, opts: { limit?: number } = {}
): Promise<AwaitingQuotation> {
  assertCanAnywhere(principal, 'engagement:read');
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), MAX_QUEUE_ROWS);
  const scopes = visibleScopes(principal, 'engagement:read');

  if (scopes.kind === 'none') {
    return { scope: 'none', total: 0, rows: [], limit, truncated: false };
  }

  const where: any[] = [
    sql`${o.institutionApplications.status} <> 'draft'`,
    notInArray(o.institutionApplications.status, CLOSED_APPLICATION_STATUSES as any),
    isNull(e.quotes.id),
  ];

  if (scopes.kind === 'scoped') {
    const clauses: any[] = [];
    if (scopes.states.length) clauses.push(inArray(o.institutionApplications.stateUnitId, scopes.states));
    if (scopes.districts.length) clauses.push(inArray(o.institutionApplications.districtUnitId, scopes.districts));
    if (scopes.institutions.length) clauses.push(inArray(o.institutionApplications.institutionId, scopes.institutions));
    // A dojo binding lands here with nothing to contribute: an institutional
    // application does not sit inside a dojo. Refusing is the fail-closed
    // reading; an empty or() would be no WHERE at all, which widens to every row.
    if (!clauses.length) return { scope: 'none', total: 0, rows: [], limit, truncated: false };
    where.push(or(...clauses));
  }

  const rows = await db
    .select({
      id: o.institutionApplications.id,
      ref: o.institutionApplications.ref,
      institutionName: o.institutionApplications.institutionName,
      status: o.institutionApplications.status,
      submittedAt: o.institutionApplications.submittedAt,
      city: o.institutionApplications.city,
      stateName: o.institutionApplications.stateName,
      participantCount: o.institutionApplications.participantCount,
      ownerRole: o.institutionApplications.ownerRole,
      hasRequest: sql<boolean>`${o.institutionApplications.requestId} is not null`,
    })
    .from(o.institutionApplications)
    .leftJoin(e.quotes, eq(e.quotes.requestId, o.institutionApplications.requestId))
    .where(and(...where))
    .orderBy(asc(o.institutionApplications.submittedAt), asc(o.institutionApplications.id))
    .limit(limit);

  // Counted separately and in the SAME predicate, so the headline figure is the
  // whole queue and not the length of the page of it that was listed.
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(o.institutionApplications)
    .leftJoin(e.quotes, eq(e.quotes.requestId, o.institutionApplications.requestId))
    .where(and(...where));

  const total = Number(counted?.n ?? 0);
  return {
    scope: scopes.kind === 'all' ? 'all' : 'scoped',
    total,
    rows: rows as AwaitingQuotationRow[],
    limit,
    truncated: total > rows.length,
  };
}

export async function applicationDetail(db: DB, principal: Principal, applicationId: number) {
  assertCanAnywhere(principal, 'engagement:read');

  const [app] = await db.select().from(o.institutionApplications)
    .where(eq(o.institutionApplications.id, applicationId)).limit(1);
  if (!app) throw new ApplicationError('not_found', `No application ${applicationId}.`);

  const scopes = visibleScopes(principal, 'engagement:read');
  if (scopes.kind === 'none') throw new ApplicationError('forbidden', 'Not permitted.');
  if (scopes.kind === 'scoped') {
    const ok =
      (app.stateUnitId != null && scopes.states.includes(app.stateUnitId)) ||
      (app.districtUnitId != null && scopes.districts.includes(app.districtUnitId)) ||
      (app.institutionId != null && scopes.institutions.includes(app.institutionId));
    if (!ok) throw new ApplicationError('forbidden', 'That application is outside your scope.');
  }

  // Every event, internal ones included — and in EXACTLY the order
  // applicantStatus() uses, `at` then `id`. The applicant's timeline is a
  // subset of this one, and a subset taken in a different order is not the same
  // case seen from two sides, it is two accounts of it.
  const events = await db.select().from(o.applicationEvents)
    .where(eq(o.applicationEvents.applicationId, applicationId))
    .orderBy(asc(o.applicationEvents.at), asc(o.applicationEvents.id));

  const tasks = await db.select().from(o.tasks)
    .where(and(eq(o.tasks.subjectKind, 'institution_application'), eq(o.tasks.subjectId, applicationId)))
    .orderBy(desc(o.tasks.id));

  // The access token is the applicant's private key to their own status page.
  // Never returned to staff: an administrator has no reason to hold it, and a
  // value nobody needs is a value that leaks from a screenshot.
  const { accessToken, ...safe } = app;

  return { application: safe, events, tasks, score: scoreApplication(app) };
}

/**
 * The applicant's own view.
 *
 * Requires the token, returns only entries marked visible, and never exposes
 * routing, scoring, internal notes or the owner's identity. What a school is
 * shown is what MMAKF has chosen to tell it.
 *
 * THE FILTER IS THE `WHERE` CLAUSE, not a `.filter()` on the way out. An
 * internal note that reaches this process and is discarded in JavaScript has
 * already been in a response body's worth of memory on a page that renders to
 * an unauthenticated reader; the row never leaves Postgres instead.
 *
 * The ORDER matters as much as the set. Several events are written inside one
 * submission and share `at` to the millisecond, so `at` alone leaves ties for
 * the database to break however it likes — and it need not break them the same
 * way twice, or the same way here as on the administrator's screen. `id`
 * settles them in the order they were actually recorded. See applicationDetail,
 * which orders identically and for the same reason: two views of one case that
 * disagree about sequence are two cases.
 */
export async function applicantStatus(db: DB, ref: string, accessToken: string) {
  const app = await applicationByRefAndToken(db, ref, accessToken);
  if (!app) throw new ApplicationError('not_found', 'No application matches that link.');

  const events = await db.select({
    at: o.applicationEvents.at,
    kind: o.applicationEvents.kind,
    summary: o.applicationEvents.summary,
  }).from(o.applicationEvents)
    .where(and(
      eq(o.applicationEvents.applicationId, app.id),
      eq(o.applicationEvents.visibleToApplicant, true)
    ))
    .orderBy(asc(o.applicationEvents.at), asc(o.applicationEvents.id));

  return {
    ref: app.ref,
    status: app.status,
    institutionName: app.institutionName,
    submittedAt: app.submittedAt,
    stepReached: app.stepReached,
    /**
     * When the federation last told this applicant something.
     *
     * The last VISIBLE entry, not `updatedAt`. A school that is shown "last
     * updated today" and then reads a timeline whose newest line is three weeks
     * old has been told the federation did something it has not been told
     * about, which is worse than being told nothing.
     */
    lastUpdateAt: events.length ? events[events.length - 1].at : null,
    // NULL unless the federation has actually undertaken a response time. The
    // page renders nothing rather than a promise nobody made.
    respondBy: app.slaDueAt,
    timeline: events,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// THE INDIVIDUAL AND PARENT PATH
// ════════════════════════════════════════════════════════════════════════════
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS IN THIS FILE AND NOT A NEW MODULE
// ─────────────────────────────────────────────────────────────────────────────
//
// Because a second intake module is how a federation ends up with two records
// for one person. This file is the intake; an individual is a different
// AUDIENCE, not a different system, so the individual path is a sibling of
// submitApplication() sharing its actors, its routing and its lead capture.
// Nothing below inserts into leads, institutions or training_requests by hand:
// it calls captureLead() and submitTrainingRequest() in src/db/engagement.ts,
// which are the only functions allowed to create those rows.
//
// ─────────────────────────────────────────────────────────────────────────────
// AN INDIVIDUAL IS NOT AN INSTITUTION, AND IS NOT YET A MEMBER
// ─────────────────────────────────────────────────────────────────────────────
//
// So NO institution row is created — resolveInstitution() is never called from
// here. One person is not an organisation, and an institution row per enquiry
// would be counted in the federation's own register and reported to a state
// unit as a client that does not exist. NO person row is created either: the
// persons table is the register /verify answers from, and filling it with
// people who have not trained makes every verification answer less true.
// Promotion to either is identifyLead(), which somebody performs deliberately.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS COLLECTED ABOUT A CHILD, AND WHAT IS DELIBERATELY NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// This is a real decision and it is written down rather than implied.
//
// COLLECTED when the participant is a minor:
//   · an age BAND, not a date of birth — "7 to 9" answers every question the
//     federation has at enquiry stage, and a date of birth answers none of them
//     any better while being the single most useful field to anybody who should
//     not have it;
//   · the fact that the participant is a minor, so no reply is ever addressed
//     to the child;
//   · the responsible adult: their name, their relationship to the child, and
//     their own email or telephone. The contact IS the guardian — the form does
//     not ask for a second name, because there is not a second person;
//   · an explicit affirmation, ticked by that adult, that they are the parent
//     or legal guardian and are enquiring on the child's behalf;
//   · optionally one emergency contact. See the note below.
//
// DELIBERATELY NOT COLLECTED: the child's name, their date of birth, their
// school, their gender, a photograph, any medical or dietary information, or a
// street address. None of them is needed to answer "can my seven-year-old train
// in Ranchi twice a week?", and every one of them is a liability the federation
// would be holding for an enquiry that may go nowhere. If the child actually
// starts training, the delivery side records a display name and an age band on
// programParticipants — the minimum a register needs — and that is a later,
// consented step.
//
// THE EMERGENCY CONTACT IS OPTIONAL, AND THAT IS THE HONEST ANSWER. It is not
// needed to reply to an enquiry; it is needed on the first day the child stands
// on a mat. Asking for it here is a convenience, so the field says so and an
// empty answer costs the enquirer nothing.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO DRAFT ROW IS WRITTEN, AND THAT IS ALSO A DECISION
// ─────────────────────────────────────────────────────────────────────────────
//
// The twenty-step institutional wizard saves a draft after every step, because
// a school principal filling in twenty screens on a phone must be able to close
// the tab. This path is short, and the trade runs the other way: writing a row
// the moment somebody answers "my child" would leave the federation holding
// half-finished enquiries about children from people who never pressed send.
// So the answers travel with the form and NOTHING is stored until the enquirer
// submits. The steps are still rendered by the server, one page load each, and
// the form works with JavaScript switched off — which is the property that
// mattered, not the draft row.

/** The answers given so far. Flat, because the form is flat. */
export type IndividualAnswers = Record<string, unknown>;

export interface IndividualOption { value: string; label: string }

export interface IndividualField {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'email' | 'tel' | 'select' | 'multiselect' | 'boolean';
  required?: boolean;
  help?: string;
  autocomplete?: string;
  options?: readonly IndividualOption[];
  /**
   * Options that depend on the answers already given.
   *
   * This is what stops the form offering "Adults" as an age for a child. It is
   * a function rather than a second field definition so there is still ONE
   * definition of `ageBand` — two would be two things to keep in step.
   */
  optionsFor?: (a: IndividualAnswers) => readonly IndividualOption[];
  /** Ask this field only when the answers so far make it relevant. */
  when?: (a: IndividualAnswers) => boolean;
}

export interface IndividualStep {
  key: string;
  title: string;
  intro?: string;
  /** Ask this step only when the answers so far make it relevant. */
  when?: (a: IndividualAnswers) => boolean;
  fields: readonly IndividualField[];
}

// ─── Reading answers ────────────────────────────────────────────────────────

function text(a: IndividualAnswers, key: string): string {
  const v = a[key];
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function many(a: IndividualAnswers, key: string): string[] {
  const v = a[key];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  const one = text(a, key);
  return one ? [one] : [];
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 'on' || v === '1' || v === 'yes';
}

// ─── The vocabulary ─────────────────────────────────────────────────────────

/**
 * The age bands that make somebody a minor.
 *
 * Derived from AGE_BAND_OPTIONS above rather than restated, so a band added to
 * the institutional form cannot quietly become an adult band here.
 */
export const MINOR_AGE_BANDS: readonly string[] =
  AGE_BAND_OPTIONS.filter((o) => o.value !== 'adult').map((o) => o.value);

/** True when the person who would train is under eighteen. */
export function participantIsMinor(a: IndividualAnswers): boolean {
  return MINOR_AGE_BANDS.includes(text(a, 'ageBand'));
}

const PARTICIPANT_OPTIONS: readonly IndividualOption[] = [
  { value: 'me', label: 'Myself' },
  { value: 'child', label: 'A child I am the parent or guardian of' },
];

/**
 * Delivery, worded for one person rather than for an institution.
 *
 * The VALUES are the `delivery_mode` enum the training request stores, so the
 * two cannot drift; only the labels differ from MODE_OPTIONS, because "At our
 * premises" is a sentence a school writes and not one an individual does.
 */
const INDIVIDUAL_MODE_OPTIONS: readonly IndividualOption[] = [
  { value: 'at_dojo', label: 'At an MMAKF centre' },
  { value: 'online', label: 'Online' },
  { value: 'on_site', label: 'Where I am — one-to-one at my own place' },
];

const EXPERIENCE_OPTIONS: readonly IndividualOption[] = [
  { value: 'none', label: 'Never trained in karate' },
  { value: 'trained_before', label: 'Trained before, not training now' },
  { value: 'training_now', label: 'Training now, somewhere else' },
];

/**
 * What somebody is asking for.
 *
 * "Online" is NOT on this list although it is a thing people ask for, because
 * it is a delivery choice and it is asked once, on the delivery step. Asking it
 * in two places lets the two answers contradict each other, and then somebody
 * has to decide which of the enquirer's own words to believe.
 */
const OBJECTIVE_OPTIONS: readonly IndividualOption[] = [
  { value: 'shotokan', label: 'The graded Shotokan syllabus' },
  { value: 'kihon', label: 'Kihon — the basics' },
  { value: 'kata', label: 'Kata' },
  { value: 'kumite', label: 'Kumite — sparring' },
  { value: 'self_defence', label: 'Self-defence' },
  { value: 'competition', label: 'Competition' },
  { value: 'grading', label: 'Grading and belt examinations' },
  { value: 'childrens', label: 'Children’s karate' },
  { value: 'womens', label: 'Women’s karate' },
  { value: 'personal_coaching', label: 'One-to-one personal coaching' },
];

const COMPETITION_OPTIONS: readonly IndividualOption[] = [
  { value: 'none', label: 'Has not competed' },
  { value: 'club_district', label: 'Club or district level' },
  { value: 'state', label: 'State level' },
  { value: 'national_or_above', label: 'National level or above' },
];

const FREQUENCY_OPTIONS: readonly IndividualOption[] = [
  { value: '1', label: 'Once a week' },
  { value: '2', label: 'Twice a week' },
  { value: '3', label: 'Three times a week' },
  { value: '4', label: 'Four times a week' },
  { value: '5', label: 'Five or more times a week' },
  { value: 'unsure', label: 'Not sure yet' },
];

const TIME_OPTIONS: readonly IndividualOption[] = [
  { value: 'weekday_morning', label: 'Weekday mornings' },
  { value: 'weekday_afternoon', label: 'Weekday afternoons' },
  { value: 'weekday_evening', label: 'Weekday evenings' },
  { value: 'weekend_morning', label: 'Weekend mornings' },
  { value: 'weekend_afternoon', label: 'Weekend afternoons' },
  { value: 'weekend_evening', label: 'Weekend evenings' },
];

const GUARDIAN_RELATIONSHIP_OPTIONS: readonly IndividualOption[] = [
  { value: 'parent', label: 'Parent' },
  { value: 'legal_guardian', label: 'Legal guardian' },
  { value: 'other_carer', label: 'Another adult with care of the child' },
];

// ─── The steps ──────────────────────────────────────────────────────────────

/**
 * The intake, as data.
 *
 * Same principle as WIZARD_STEPS: the page renders from this, the server
 * validates against it, and the progress indicator counts it, so the form
 * cannot accept something the server will reject.
 *
 * The `when` predicates ARE the intelligent questioning. They are here, beside
 * the questions, rather than in the page — a relevance rule that lives in a
 * template is a rule the validator does not know about, and then the server
 * rejects a submission for missing an answer it never asked for.
 */
export const INDIVIDUAL_STEPS: readonly IndividualStep[] = [
  {
    key: 'who',
    title: 'Who would be training?',
    intro: 'Everything after this depends on the answer, so it is asked first.',
    fields: [
      { name: 'participantIs', label: 'The training is for', kind: 'select', required: true, options: PARTICIPANT_OPTIONS },
    ],
  },
  {
    key: 'age_self',
    title: 'Your age',
    when: (a) => text(a, 'participantIs') === 'me',
    fields: [
      {
        name: 'ageBand', label: 'Age', kind: 'select', required: true, options: AGE_BAND_OPTIONS,
        help: 'If you are under eighteen, the next question asks for a parent or guardian — MMAKF answers an enquiry about a minor to the responsible adult, not to the minor.',
      },
    ],
  },
  {
    key: 'age_child',
    title: 'The child’s age',
    // A child is under eighteen by definition, so "Adults" is not offered. This
    // is the smallest visible piece of the relevance rule and the clearest.
    when: (a) => text(a, 'participantIs') === 'child',
    fields: [
      {
        name: 'ageBand', label: 'Age group', kind: 'select', required: true,
        optionsFor: () => AGE_BAND_OPTIONS.filter((o) => o.value !== 'adult'),
        help: 'A band, not a date of birth. MMAKF does not need the exact date to answer an enquiry.',
      },
    ],
  },
  {
    key: 'guardian',
    title: 'You, as the responsible adult',
    intro:
      'The person training is under eighteen, so MMAKF deals with you. The federation does not ask for the child’s name at this stage and does not need it to answer you.',
    when: participantIsMinor,
    fields: [
      {
        name: 'guardianRelationship', label: 'Your relationship to the child', kind: 'select',
        required: true, options: GUARDIAN_RELATIONSHIP_OPTIONS,
      },
      {
        name: 'guardianConfirmed',
        label: 'I am the parent or legal guardian, and I am enquiring on the child’s behalf',
        kind: 'boolean', required: true,
      },
      {
        name: 'emergencyContactName', label: 'Emergency contact name', kind: 'text',
        help: 'Optional. Not needed to answer your enquiry — it is asked here only so it is not asked again on a first day at a centre. Leave it blank if you would rather.',
      },
      { name: 'emergencyContactPhone', label: 'Emergency contact telephone', kind: 'tel' },
    ],
  },
  {
    key: 'experience',
    title: 'Karate so far',
    fields: [
      {
        name: 'experience', label: 'Experience', kind: 'select', required: true,
        options: EXPERIENCE_OPTIONS,
        optionsFor: (a) => participantIsMinor(a)
          ? EXPERIENCE_OPTIONS.map((o) =>
              o.value === 'none' ? { value: 'none', label: 'Has never trained in karate' } : o)
          : EXPERIENCE_OPTIONS,
      },
    ],
  },
  {
    key: 'grade',
    title: 'Current grade',
    // Never asked of a beginner. This is the case the federation named: nobody
    // arranging a first lesson for a seven-year-old is asked what belt they hold.
    when: (a) => ['trained_before', 'training_now'].includes(text(a, 'experience')),
    fields: [
      {
        name: 'currentGrade', label: 'Grade held, if any', kind: 'text',
        // Free text, deliberately. A dropdown here would have to list a grade
        // ladder, and MMAKF's published syllabus is not this form's to restate —
        // nor is another federation's, which is what somebody transferring in
        // would be choosing from.
        help: 'In your own words — the belt or grade, and who awarded it. Leave blank if you hold none.',
      },
      { name: 'yearsTrained', label: 'Roughly how long, in years', kind: 'text' },
    ],
  },
  {
    key: 'objectives',
    title: 'What you are looking for',
    intro: 'Choose as many as apply. This is what shapes what the federation offers you.',
    fields: [
      {
        name: 'objectives', label: 'Objectives', kind: 'multiselect', required: true,
        // Children's karate is offered only where the participant is a child.
        options: OBJECTIVE_OPTIONS,
        optionsFor: (a) => participantIsMinor(a)
          ? OBJECTIVE_OPTIONS
          : OBJECTIVE_OPTIONS.filter((o) => o.value !== 'childrens'),
      },
    ],
  },
  {
    key: 'competition',
    title: 'Competition',
    when: (a) => many(a, 'objectives').includes('competition'),
    fields: [
      {
        name: 'competitionLevel', label: 'Competition experience so far', kind: 'select',
        options: COMPETITION_OPTIONS,
      },
    ],
  },
  {
    key: 'mode',
    title: 'Where the training would happen',
    fields: [
      { name: 'mode', label: 'Delivery', kind: 'select', required: true, options: INDIVIDUAL_MODE_OPTIONS },
    ],
  },
  {
    key: 'location',
    title: 'Where you are',
    intro: 'So the enquiry reaches the unit that would actually answer it.',
    fields: [
      { name: 'city', label: 'City or town', kind: 'text', required: true, autocomplete: 'address-level2' },
      {
        name: 'stateName', label: 'State or union territory', kind: 'text',
        autocomplete: 'address-level1',
        help: 'Without it the enquiry can only be seen nationally, which usually means it is answered more slowly.',
      },
      {
        name: 'preferredArea', label: 'Which part of town suits you', kind: 'text',
        // Not asked of somebody training online: the whole point of the answer
        // is which centre is reachable, and online has no centre.
        when: (a) => text(a, 'mode') !== 'online',
        help: 'A locality or a landmark is enough. It decides which centre is suggested.',
      },
    ],
  },
  {
    key: 'schedule',
    title: 'How often, and when',
    fields: [
      { name: 'sessionsPerWeek', label: 'Sessions a week', kind: 'select', required: true, options: FREQUENCY_OPTIONS },
      { name: 'preferredTimes', label: 'Times that would work', kind: 'multiselect', options: TIME_OPTIONS },
    ],
  },
  {
    key: 'contact',
    title: 'How MMAKF reaches you',
    intro: 'One of an email address or a telephone number is needed. An enquiry with neither cannot be answered.',
    fields: [
      { name: 'contactName', label: 'Your full name', kind: 'text', required: true, autocomplete: 'name' },
      { name: 'contactEmail', label: 'Email address', kind: 'email', autocomplete: 'email' },
      { name: 'contactPhone', label: 'Telephone', kind: 'tel', autocomplete: 'tel' },
      {
        name: 'notes', label: 'Anything else MMAKF should know', kind: 'textarea',
        help: 'Optional, and in your own words.',
      },
    ],
  },
  { key: 'review', title: 'Check and send', fields: [] },
];

/** The steps this particular set of answers actually reaches. */
export function relevantIndividualSteps(a: IndividualAnswers): IndividualStep[] {
  return INDIVIDUAL_STEPS.filter((s) => !s.when || s.when(a));
}

/** The fields of one step that this particular set of answers actually reaches. */
export function relevantFields(step: IndividualStep, a: IndividualAnswers): IndividualField[] {
  return step.fields.filter((f) => !f.when || f.when(a));
}

/** The options a field offers given the answers so far. */
export function optionsOf(field: IndividualField, a: IndividualAnswers): readonly IndividualOption[] {
  return field.optionsFor ? field.optionsFor(a) : (field.options ?? []);
}

/**
 * Drop answers to questions the enquirer is no longer being asked.
 *
 * Somebody who chooses a centre, names a locality, then goes back and chooses
 * online has left a locality behind. Nothing asks for it any more and nothing
 * validates it, so without this it would be stored on the request and an
 * administrator would read "online, near Lalpur" — a contradiction the enquirer
 * never wrote.
 *
 * Applied at submission as well as in the form, so the JSON endpoint cannot be
 * used to store an answer to a question its answers made irrelevant.
 */
export function pruneIndividual(a: IndividualAnswers): IndividualAnswers {
  const keep = new Set<string>();
  for (const step of relevantIndividualSteps(a)) {
    for (const field of relevantFields(step, a)) keep.add(field.name);
  }
  const out: IndividualAnswers = {};
  for (const [k, v] of Object.entries(a)) {
    if (keep.has(k)) out[k] = v;
  }
  return out;
}

/**
 * The next or previous relevant step.
 *
 * Steps are addressed BY KEY and never by number, because the number of a step
 * changes as branches appear: answering "a child" inserts the guardian step and
 * would otherwise renumber every step after it, so a Back button carrying a
 * number would send somebody to a different question than the one they came
 * from.
 */
export function stepAfter(a: IndividualAnswers, key: string, direction: 1 | -1): string | null {
  const steps = relevantIndividualSteps(a);
  const i = steps.findIndex((s) => s.key === key);
  if (i < 0) return steps.length ? steps[0].key : null;
  const next = steps[i + direction];
  return next ? next.key : null;
}

/** The step to render for a requested key, falling back to the first relevant one. */
export function individualStep(a: IndividualAnswers, key: string | null | undefined): IndividualStep {
  const steps = relevantIndividualSteps(a);
  return steps.find((s) => s.key === key) ?? steps[0];
}

// ─── The running summary ────────────────────────────────────────────────────

function labelOf(options: readonly IndividualOption[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * What the federation has understood so far, in words.
 *
 * This is the difference between a form and a configuration: the enquirer reads
 * their own answers back as a sentence and can see, before sending, that the
 * system has understood "a nine-year-old in Ranchi, twice a week, at a centre"
 * rather than hoping it did.
 *
 * It states ONLY what was answered. No phrase is produced from an assumption,
 * and an unanswered question contributes nothing rather than a default.
 */
export function summariseIndividual(a: IndividualAnswers): string[] {
  const out: string[] = [];

  const band = text(a, 'ageBand');
  if (band === 'adult') out.push('Adult');
  else if (band) {
    out.push(participantIsMinor(a) && text(a, 'participantIs') === 'child'
      ? `Child, ${labelOf(AGE_BAND_OPTIONS, band).toLowerCase()}`
      : `Aged ${labelOf(AGE_BAND_OPTIONS, band).toLowerCase()}`);
  }

  const city = text(a, 'city');
  const state = text(a, 'stateName');
  if (city && state) out.push(`${city}, ${state}`);
  else if (city) out.push(city);
  else if (state) out.push(state);

  const exp = text(a, 'experience');
  if (exp === 'none') out.push('beginner');
  else if (exp === 'trained_before') out.push('trained before');
  else if (exp === 'training_now') out.push('training now');

  const grade = text(a, 'currentGrade');
  if (grade) out.push(grade);

  const objectives = many(a, 'objectives');
  if (objectives.length) {
    out.push(objectives.map((v) => labelOf(OBJECTIVE_OPTIONS, v).toLowerCase()).join(' and '));
  }

  const freq = text(a, 'sessionsPerWeek');
  if (freq && freq !== 'unsure') {
    const words: Record<string, string> = {
      '1': 'once a week', '2': 'twice a week', '3': 'three times a week',
      '4': 'four times a week', '5': 'five or more times a week',
    };
    out.push(words[freq] ?? `${freq} times a week`);
  } else if (freq === 'unsure') {
    out.push('frequency not decided');
  }

  const mode = text(a, 'mode');
  if (mode === 'at_dojo') out.push(text(a, 'preferredArea') ? `at a centre near ${text(a, 'preferredArea')}` : 'at a centre');
  else if (mode === 'online') out.push('online');
  else if (mode === 'on_site') out.push('one-to-one where they are');

  const times = many(a, 'preferredTimes');
  if (times.length) out.push(times.map((v) => labelOf(TIME_OPTIONS, v).toLowerCase()).join(', '));

  if (participantIsMinor(a)) {
    const rel = text(a, 'guardianRelationship');
    if (rel) out.push(`arranged by the ${labelOf(GUARDIAN_RELATIONSHIP_OPTIONS, rel).toLowerCase()}`);
  }

  return out;
}

/** The same summary as one line, for a message body or a stored parameter. */
export function describeIndividual(a: IndividualAnswers): string {
  const parts = summariseIndividual(a);
  return parts.length ? parts.join(', ') : 'Nothing answered yet.';
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface IndividualProblem { field: string; message: string; stepKey: string }

/**
 * Validate against the steps the answers actually reach.
 *
 * A field on a step this enquirer never sees is never required of them — which
 * is the whole reason the relevance rules live beside the questions. Every
 * problem is returned, not the first, for the same reason as the institutional
 * form: one error at a time is how a form gets abandoned.
 */
export function validateIndividual(a: IndividualAnswers): IndividualProblem[] {
  const problems: IndividualProblem[] = [];

  for (const step of relevantIndividualSteps(a)) {
    for (const field of relevantFields(step, a)) {
      const raw = a[field.name];
      const value = field.kind === 'multiselect' ? many(a, field.name) : text(a, field.name);
      const blank = field.kind === 'boolean'
        ? !truthy(raw)
        : Array.isArray(value) ? value.length === 0 : value === '';

      if (field.required && blank) {
        problems.push({
          field: field.name,
          stepKey: step.key,
          message: field.kind === 'boolean'
            ? `${field.label} — this has to be ticked.`
            : `${field.label} is needed.`,
        });
        continue;
      }
      if (blank) continue;

      const options = optionsOf(field, a);
      if (field.kind === 'select' && options.length && !options.some((o) => o.value === value)) {
        problems.push({ field: field.name, stepKey: step.key, message: `${field.label} is not one of the choices.` });
      }
      if (field.kind === 'multiselect' && options.length) {
        for (const item of value as string[]) {
          if (!options.some((o) => o.value === item)) {
            problems.push({ field: field.name, stepKey: step.key, message: `"${item}" is not one of the choices for ${field.label}.` });
          }
        }
      }
      if (field.kind === 'email' && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value as string)) {
        problems.push({ field: field.name, stepKey: step.key, message: `${field.label} does not look like an email address.` });
      }
    }
  }

  // Cross-field: an enquiry nobody can answer is refused here, where it can
  // still be explained, rather than by captureLead() after the person has left.
  if (!text(a, 'contactEmail') && !text(a, 'contactPhone')) {
    problems.push({
      field: 'contactEmail',
      stepKey: 'contact',
      message: 'An email address or a telephone number is needed — without one MMAKF cannot reply at all.',
    });
  }
  if (text(a, 'contactPhone') && text(a, 'contactPhone').replace(/\D+/g, '').length < 10) {
    problems.push({
      field: 'contactPhone',
      stepKey: 'contact',
      message: 'That telephone number is too short to dial. Ten digits, with or without the country code.',
    });
  }

  return problems;
}

// ─── The fee preview ────────────────────────────────────────────────────────

export type IndividualFeePreview =
  | { kind: 'unavailable'; message: string }
  | { kind: 'no_framework'; message: string }
  | { kind: 'quotation_required'; message: string; frameworkCode?: string }
  | {
      kind: 'estimate';
      message: string;
      frameworkCode: string;
      currency: string;
      totalMinor: number;
      lines: Array<{ label: string; amountMinor: number; because: string | null }>;
    };

/**
 * What this configuration would cost, if the federation has said.
 *
 * NO FIGURE IS PRODUCED HERE. Every number comes out of computeFee() against a
 * published framework version, and when no rule prices the request the answer
 * is the engine's own sentence about why. Today MMAKF has published no fee
 * rules at all, so this returns `no_framework` or `quotation_required` on every
 * call — and the surface says a quotation is needed, which is true.
 *
 * `sessions` is NOT supplied. The form knows sessions per WEEK and not how many
 * weeks, and handing a weekly figure to a per-session rule would multiply a
 * unit price by the wrong number and print the result as money. A per-session
 * rule is skipped and says so instead.
 */
export async function individualFeePreview(
  db: DB,
  a: IndividualAnswers,
  asAt: string = new Date().toISOString().slice(0, 10)
): Promise<IndividualFeePreview> {
  const framework = await activeFramework(db, asAt);
  if (!framework) {
    return {
      kind: 'no_framework',
      message:
        'MMAKF has not published a fee framework, so there is no figure to show you. Your enquiry goes to ' +
        'the federation office as a request for a quotation, and the quotation is what carries the amount.',
    };
  }

  const freq = text(a, 'sessionsPerWeek');
  const perWeek = freq && freq !== 'unsure' ? Number(freq) : undefined;

  try {
    const computation = await computeFee(db, framework.id, {
      audience: 'individual',
      mode: text(a, 'mode') || undefined,
      participants: 1,
      // Extra keys a rule's conditions may read. They are the enquirer's own
      // answers, passed through unchanged.
      sessionsPerWeek: perWeek,
      experience: text(a, 'experience') || undefined,
      ageBand: text(a, 'ageBand') || undefined,
      objectives: many(a, 'objectives'),
      stateName: text(a, 'stateName') || undefined,
    });

    if (computation.requiresManualQuote) {
      return {
        kind: 'quotation_required',
        frameworkCode: computation.frameworkCode,
        message: computation.manualReason
          ?? 'No published fee rule covers this combination, so the federation office prepares a quotation for it.',
      };
    }

    return {
      kind: 'estimate',
      frameworkCode: computation.frameworkCode,
      currency: computation.currency,
      totalMinor: computation.totalMinor,
      lines: computation.lines.map((l) => ({ label: l.label, amountMinor: l.amountMinor, because: l.because })),
      message:
        'An ESTIMATE, computed from the published fee framework against the answers on this page. It is not a ' +
        'quotation and it is not an offer — a quotation is issued by the federation office and is the figure that binds.',
    };
  } catch (err: any) {
    // A framework whose rules are incomplete must not produce a number. Saying
    // a quotation is needed is the only safe reading of a broken rule.
    return {
      kind: 'quotation_required',
      frameworkCode: framework.code,
      message:
        'The published fee rules could not be applied to this configuration, so the federation office prepares ' +
        'a quotation for it.',
    };
  }
}

// ─── Submission ─────────────────────────────────────────────────────────────

export interface IndividualSubmitInput {
  answers: IndividualAnswers;
  /**
   * The identifier the form carried from its first step.
   *
   * It is stored on the training request and looked up before anything is
   * written, so a double-clicked Send or a retried POST folds onto the enquiry
   * that already exists instead of creating a second one.
   */
  formNonce: string;
  leadSource?: LeadSource;
  landingPath?: string | null;
  utm?: Record<string, unknown> | null;
  now?: Date;
}

export interface IndividualSubmitResult {
  ref: string;
  requestId: number;
  leadId: number | null;
  leadRef: string | null;
  /** True when this submission had already been recorded under the same nonce. */
  alreadyRecorded: boolean;
  matchedExistingLead: boolean;
  involvesMinor: boolean;
  summary: string;
  routing: RoutingDecision;
  stateUnitId: number | null;
}

/**
 * Resolve a typed state name onto the federation's own unit.
 *
 * By name, case-insensitively, against the units that exist. NO fuzzy matching
 * and no guess: a wrong match routes a Jharkhand enquiry to Kerala, which is
 * worse than leaving it national — and national is exactly where leadPipeline()
 * puts a lead with no unit.
 */
async function resolveStateUnitByName(db: DB, name: string): Promise<number | null> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  try {
    const rows = await db.select({ id: stateUnits.id, state: stateUnits.state, name: stateUnits.name })
      .from(stateUnits);
    const hit = rows.find((r: any) =>
      String(r.state ?? '').trim().toLowerCase() === wanted ||
      String(r.name ?? '').trim().toLowerCase() === wanted);
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}

/**
 * Record an individual's enquiry.
 *
 * THE ORDER IS DELIBERATE, AND DIFFERENT FROM submitApplication(). There, the
 * application row is stored first and a failed lead is a recorded warning,
 * because the application itself is the record of the submission. Here there is
 * no such row: the LEAD IS the record. So a lead that cannot be written is a
 * failed submission and says so, rather than returning a reference for an
 * enquiry that reached nobody.
 */
export async function submitIndividualEnquiry(
  db: DB,
  input: IndividualSubmitInput
): Promise<IndividualSubmitResult> {
  const now = input.now ?? new Date();
  // Pruned first, so an answer to a question this enquirer stopped being asked
  // cannot reach the stored request.
  const a = pruneIndividual(input.answers ?? {});

  const problems = validateIndividual(a);
  if (problems.length) {
    throw new ApplicationError('invalid', problems.map((p) => p.message).join(' '), problems[0].field);
  }
  if (!input.formNonce) {
    throw new ApplicationError('no_nonce', 'This form was submitted without its identifier. Start again from the first question.');
  }

  const minor = participantIsMinor(a);
  const summary = describeIndividual(a);

  // ── Idempotency, before anything is written ──
  const [seen] = await db
    .select({ id: e.trainingRequests.id, ref: e.trainingRequests.ref, leadId: e.trainingRequests.leadId })
    .from(e.trainingRequests)
    .where(sql`${e.trainingRequests.parameters}->>'formNonce' = ${input.formNonce}`)
    .limit(1);

  if (seen) {
    return {
      ref: seen.ref, requestId: seen.id, leadId: seen.leadId ?? null, leadRef: null,
      alreadyRecorded: true, matchedExistingLead: true, involvesMinor: minor,
      summary, stateUnitId: null,
      routing: {
        ruleId: null, targetRole: null, targetUserId: null, department: null,
        // Not re-run. Routing was decided when the enquiry was first recorded,
        // and deciding it again here would report a different owner than the
        // one the enquiry actually has.
        explanation: 'This enquiry was already recorded; nothing was created a second time.',
      },
    };
  }

  const ctx = systemIntakeContext();
  const stateUnitId = await resolveStateUnitByName(db, text(a, 'stateName'));

  // ── 1. The lead. Not optional — it is the record. ──
  let lead;
  try {
    lead = await captureLead(db, ctx, {
      audience: 'individual',
      contactName: text(a, 'contactName') || null,
      contactEmail: text(a, 'contactEmail') || null,
      contactPhone: text(a, 'contactPhone') || null,
      city: text(a, 'city') || null,
      stateUnitId,
      source: input.leadSource ?? 'direct',
      landingPath: input.landingPath ?? null,
      utm: (input.utm ?? null) as any,
    });
  } catch (err: any) {
    if (isEngagementError(err)) {
      throw new ApplicationError('invalid', err.message, 'contactEmail');
    }
    throw err;
  }

  // ── 2. The training request ──
  //
  // `participants: 1`. An individual enquiry is one participant even when a
  // parent is arranging it — the parent is the contact, not a second trainee —
  // and submitTrainingRequest() refuses a request it could not price without it.
  const request = await submitTrainingRequest(db, ctx, {
    audience: 'individual',
    leadId: lead.leadId,
    // Explicitly null. Stated rather than omitted, because this is the line
    // somebody will one day be tempted to fill in.
    institutionId: null,
    personId: null,
    mode: (text(a, 'mode') || null) as any,
    parameters: {
      participants: 1,
      formNonce: input.formNonce,
      participantIs: text(a, 'participantIs'),
      ageBand: text(a, 'ageBand'),
      involvesMinor: minor,
      experience: text(a, 'experience'),
      currentGrade: text(a, 'currentGrade') || null,
      yearsTrained: text(a, 'yearsTrained') || null,
      objectives: many(a, 'objectives'),
      competitionLevel: text(a, 'competitionLevel') || null,
      sessionsPerWeek: text(a, 'sessionsPerWeek') || null,
      preferredTimes: many(a, 'preferredTimes'),
      city: text(a, 'city'),
      stateName: text(a, 'stateName') || null,
      preferredArea: text(a, 'preferredArea') || null,
      // The responsible adult, and nothing about the child beyond the band
      // already recorded above. See the note at the head of this section.
      guardian: minor
        ? {
            relationship: text(a, 'guardianRelationship'),
            confirmedAt: now.toISOString(),
            emergencyContactName: text(a, 'emergencyContactName') || null,
            emergencyContactPhone: text(a, 'emergencyContactPhone') || null,
          }
        : null,
      summary,
    },
    notes: text(a, 'notes') || null,
  });

  // ── 3. Routing ──
  //
  // The SAME rule engine the institutional path uses. A separate one would be a
  // second place for the federation to configure who answers what, and the two
  // would disagree within a month.
  const routing = await routeApplication(db, {
    audience: 'individual',
    stateUnitId,
    districtUnitId: null,
    serviceId: null,
    participantCount: 1,
  });

  if (routing.targetUserId) {
    await db.update(e.leads)
      .set({ ownerUserId: routing.targetUserId, updatedAt: now })
      .where(eq(e.leads.id, lead.leadId));
  }

  await db.insert(e.leadActivities).values({
    leadId: lead.leadId,
    kind: 'status_change',
    summary: routing.explanation,
    detail: { routing, requestRef: request.ref, involvesMinor: minor } as any,
  });

  // ── 4. Audit ──
  //
  // captureLead() and submitTrainingRequest() write none of their own, so
  // without this the federation could not answer "who created this record and
  // on whose authority?" for an individual enquiry. The authority named is the
  // intake actor, which is the truth: nobody was signed in.
  await writeAudit(db, ctx, {
    entityType: 'training_request',
    entityId: request.id,
    action: 'create',
    newValue: {
      ref: request.ref,
      audience: 'individual',
      leadRef: lead.ref,
      involvesMinor: minor,
      // The summary, not the answers. An audit row is read by more people than
      // the record it describes.
      summary,
    },
  });

  return {
    ref: request.ref,
    requestId: request.id,
    leadId: lead.leadId,
    leadRef: lead.ref,
    alreadyRecorded: false,
    matchedExistingLead: lead.matchedExisting,
    involvesMinor: minor,
    summary,
    routing,
    stateUnitId,
  };
}
