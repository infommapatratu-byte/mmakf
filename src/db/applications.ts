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

import { and, asc, desc, eq, inArray, isNull, isNotNull, or, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as o from './operations.schema';
import * as e from './engagement.schema';
import { allocateFederationId, writeAudit, type AuditContext } from './federation';
import { captureLead, resolveInstitution, submitTrainingRequest, type Audience, type LeadSource, AUDIENCES } from './engagement';
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
    const [existing] = await db.select().from(o.institutionApplications)
      .where(and(
        eq(o.institutionApplications.ref, input.ref),
        eq(o.institutionApplications.accessToken, input.accessToken)
      )).limit(1);

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
  const accessToken = crypto.randomBytes(24).toString('base64url');

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
    const [existing] = await db.select().from(o.institutionApplications)
      .where(and(
        eq(o.institutionApplications.ref, input.ref),
        eq(o.institutionApplications.accessToken, input.accessToken)
      )).limit(1);
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
    const accessToken = crypto.randomBytes(24).toString('base64url');
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
        'program_design', 'quoted', 'proposed', 'approved', 'contracted',
      ])
    ))
    .orderBy(desc(o.institutionApplications.id))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Review ─────────────────────────────────────────────────────────────────

export const REVIEW_STATUSES = [
  'acknowledged', 'under_review', 'information_requested', 'program_design',
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

  const events = await db.select().from(o.applicationEvents)
    .where(eq(o.applicationEvents.applicationId, applicationId))
    .orderBy(asc(o.applicationEvents.at));

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
 */
export async function applicantStatus(db: DB, ref: string, accessToken: string) {
  if (!ref || !accessToken) throw new ApplicationError('not_found', 'No application matches that link.');

  const [app] = await db.select().from(o.institutionApplications)
    .where(and(
      eq(o.institutionApplications.ref, ref),
      eq(o.institutionApplications.accessToken, accessToken)
    )).limit(1);

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
    .orderBy(asc(o.applicationEvents.at));

  return {
    ref: app.ref,
    status: app.status,
    institutionName: app.institutionName,
    submittedAt: app.submittedAt,
    stepReached: app.stepReached,
    // NULL unless the federation has actually undertaken a response time. The
    // page renders nothing rather than a promise nobody made.
    respondBy: app.slaDueAt,
    timeline: events,
  };
}
