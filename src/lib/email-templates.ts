// Transactional messages.
//
// ─────────────────────────────────────────────────────────────────────────────
// THERE IS NO TRANSPORT YET, AND THIS FILE SAYS SO
// ─────────────────────────────────────────────────────────────────────────────
//
// MMAKF has no outbound mail provider configured. Rather than pretend
// otherwise, rendering and sending are separated: this module RENDERS a message
// and the notification row it produces sits in the queue with status 'queued'.
// The moment a provider exists, the drain job sends what is already there.
//
// The alternative — a `sendEmail()` that logs to the console and returns
// success — produces a system that reports every message delivered and delivers
// none, which is worse than one that plainly has nothing to send with.
//
// ─────────────────────────────────────────────────────────────────────────────
// A MISSING VARIABLE IS AN ERROR
// ─────────────────────────────────────────────────────────────────────────────
//
// render() throws when a template references a value nobody supplied. Silently
// substituting an empty string produces "Dear ," and "your programme at
// starts on ." — sent to a school principal, over the federation's name. A
// failed render is caught by the workflow, recorded and retried; a bad one is
// read by a customer.
//
// ─────────────────────────────────────────────────────────────────────────────
// NOTHING HERE PROMISES A TURNAROUND
// ─────────────────────────────────────────────────────────────────────────────
//
// No template says "we will respond within 48 hours". The federation has not
// published a service standard, and a template is exactly where an invented one
// would hide.

export interface RenderedMessage {
  subject: string;
  text: string;
  /** The topic these belong to, for notification preferences. */
  topic: string;
}

export interface TemplateSpec {
  key: string;
  topic: string;
  /** Names that must be present in the values object. */
  requires: readonly string[];
  subject: string;
  body: string;
}

const SIGNATURE = `
—
Modern Martial Arts Karate-Do Federation of India
admin@mmakf.in · https://www.mmakf.in`;

/**
 * The catalogue.
 *
 * Written as plain text with {{name}} placeholders. Plain text rather than HTML
 * because these are short operational notes that must survive every client,
 * and because an HTML template is a place for a tracking pixel to appear later
 * without anyone deciding it should.
 */
export const TEMPLATES: Record<string, TemplateSpec> = {
  // ── Institutional lifecycle ──
  application_received: {
    key: 'application_received', topic: 'institution',
    requires: ['contactName', 'institutionName', 'ref', 'statusUrl'],
    subject: 'MMAKF has your application — {{ref}}',
    body: `Dear {{contactName}},

MMAKF has received the training application for {{institutionName}}.

Your reference is {{ref}}. You can follow it here:
{{statusUrl}}

The training office will be in touch about the next step.${SIGNATURE}`,
  },

  application_information_requested: {
    key: 'application_information_requested', topic: 'institution',
    requires: ['contactName', 'institutionName', 'ref', 'question', 'statusUrl'],
    subject: 'MMAKF needs one more detail — {{ref}}',
    body: `Dear {{contactName}},

Before MMAKF can take the application for {{institutionName}} forward, we need
one more thing:

{{question}}

You can reply to this message, or open {{statusUrl}}.${SIGNATURE}`,
  },

  application_approved: {
    key: 'application_approved', topic: 'institution',
    requires: ['contactName', 'institutionName', 'ref', 'statusUrl'],
    subject: 'Your MMAKF programme is approved — {{ref}}',
    body: `Dear {{contactName}},

MMAKF has approved the programme for {{institutionName}}.

Scheduling begins now, and you will receive the session calendar and the name
of your assigned instructor as they are confirmed.

{{statusUrl}}${SIGNATURE}`,
  },

  application_declined: {
    key: 'application_declined', topic: 'institution',
    requires: ['contactName', 'institutionName', 'ref', 'reason'],
    subject: 'About your MMAKF application — {{ref}}',
    body: `Dear {{contactName}},

MMAKF is not able to take forward the application for {{institutionName}}.

{{reason}}

If circumstances change, you are welcome to apply again.${SIGNATURE}`,
  },

  // ── The individual and parent path ──
  //
  // Addressed to whoever filled the form in. Where that is a parent, it is the
  // PARENT who is written to and the child is not named — the message would
  // otherwise put a child's name in a mailbox the federation cannot vouch for,
  // and nothing here needs the name to be useful.
  //
  // It carries no status link because an individual enquiry has no status page
  // to link to. A URL to a page that does not exist is worse than no URL.
  training_enquiry_received: {
    key: 'training_enquiry_received', topic: 'training',
    requires: ['contactName', 'ref', 'summary'],
    subject: 'MMAKF has your training enquiry — {{ref}}',
    body: `Dear {{contactName}},

MMAKF has received your enquiry about training.

Your reference is {{ref}}, and this is what the federation has understood:

{{summary}}

If any of that is wrong, reply to this message and say so. The training office
will be in touch about what is available near you and what it would cost.${SIGNATURE}`,
  },

  quote_ready: {
    key: 'quote_ready', topic: 'institution',
    requires: ['contactName', 'institutionName', 'quoteRef', 'validUntil', 'portalUrl'],
    subject: 'Your MMAKF quotation — {{quoteRef}}',
    body: `Dear {{contactName}},

The quotation for {{institutionName}} is ready.

Reference: {{quoteRef}}
Valid until: {{validUntil}}

It sets out how the figure was arrived at, line by line:
{{portalUrl}}${SIGNATURE}`,
  },

  proposal_ready: {
    key: 'proposal_ready', topic: 'institution',
    requires: ['contactName', 'institutionName', 'proposalRef', 'portalUrl'],
    subject: 'Your MMAKF proposal — {{proposalRef}}',
    body: `Dear {{contactName}},

The proposal for {{institutionName}} is ready to read:

{{portalUrl}}

It covers the programme, the schedule, the instructors and the fee.${SIGNATURE}`,
  },

  booking_confirmed: {
    key: 'booking_confirmed', topic: 'booking',
    requires: ['contactName', 'what', 'when', 'where', 'ref'],
    subject: 'Confirmed: {{what}} — {{when}}',
    body: `Dear {{contactName}},

This is confirmed.

What:  {{what}}
When:  {{when}}
Where: {{where}}
Ref:   {{ref}}${SIGNATURE}`,
  },

  schedule_changed: {
    key: 'schedule_changed', topic: 'calendar',
    requires: ['contactName', 'what', 'previously', 'now', 'reason'],
    subject: 'Changed: {{what}}',
    body: `Dear {{contactName}},

A session has moved.

What:       {{what}}
Was:        {{previously}}
Now:        {{now}}
Why:        {{reason}}

Nothing else about the programme has changed.${SIGNATURE}`,
  },

  session_cancelled: {
    key: 'session_cancelled', topic: 'calendar',
    requires: ['contactName', 'what', 'when', 'reason'],
    subject: 'Cancelled: {{what}} on {{when}}',
    body: `Dear {{contactName}},

{{what}} on {{when}} will not take place.

{{reason}}

If a replacement session is arranged you will be told separately.${SIGNATURE}`,
  },

  program_started: {
    key: 'program_started', topic: 'institution',
    requires: ['contactName', 'institutionName', 'programTitle', 'portalUrl'],
    subject: '{{programTitle}} has begun at {{institutionName}}',
    body: `Dear {{contactName}},

{{programTitle}} has started.

Attendance, session records and reports appear here as they are entered:
{{portalUrl}}${SIGNATURE}`,
  },

  report_ready: {
    key: 'report_ready', topic: 'institution',
    requires: ['contactName', 'institutionName', 'period', 'portalUrl'],
    subject: 'Your MMAKF report — {{period}}',
    body: `Dear {{contactName}},

The report for {{institutionName}} covering {{period}} is ready:

{{portalUrl}}${SIGNATURE}`,
  },

  renewal_due: {
    key: 'renewal_due', topic: 'institution',
    requires: ['contactName', 'institutionName', 'programTitle', 'endsOn', 'portalUrl'],
    subject: '{{programTitle}} ends on {{endsOn}}',
    body: `Dear {{contactName}},

{{programTitle}} at {{institutionName}} finishes on {{endsOn}}.

If you would like it to continue, you can start the renewal here:
{{portalUrl}}${SIGNATURE}`,
  },

  // ── Coach lifecycle ──
  coach_application_received: {
    key: 'coach_application_received', topic: 'coach',
    requires: ['fullName', 'ref'],
    subject: 'MMAKF has your application to teach — {{ref}}',
    body: `Dear {{fullName}},

MMAKF has your application to teach.

Your reference is {{ref}}. Applications are screened, and candidates who go
forward are invited to an interview and a technical review.${SIGNATURE}`,
  },

  coach_interview_invitation: {
    key: 'coach_interview_invitation', topic: 'coach',
    requires: ['fullName', 'ref', 'when', 'where'],
    subject: 'MMAKF interview — {{when}}',
    body: `Dear {{fullName}},

MMAKF would like to meet you about application {{ref}}.

When:  {{when}}
Where: {{where}}

Please bring your grade certificates and any coaching qualifications.${SIGNATURE}`,
  },

  coach_assignment_offer: {
    key: 'coach_assignment_offer', topic: 'coach',
    requires: ['fullName', 'programTitle', 'when', 'where', 'respondUrl'],
    subject: 'Teaching offer: {{programTitle}}',
    body: `Dear {{fullName}},

You have been put forward for:

Programme: {{programTitle}}
When:      {{when}}
Where:     {{where}}

Please accept or decline here so the schedule can be settled:
{{respondUrl}}${SIGNATURE}`,
  },

  coach_session_reminder: {
    key: 'coach_session_reminder', topic: 'coach',
    requires: ['fullName', 'what', 'when', 'where'],
    subject: 'Tomorrow: {{what}}',
    body: `Dear {{fullName}},

A reminder.

What:  {{what}}
When:  {{when}}
Where: {{where}}${SIGNATURE}`,
  },

  // ── Individual ──
  certificate_issued: {
    key: 'certificate_issued', topic: 'certificate',
    requires: ['fullName', 'certificateTitle', 'verifyUrl'],
    subject: 'Your MMAKF certificate — {{certificateTitle}}',
    body: `Dear {{fullName}},

Your certificate for {{certificateTitle}} has been issued.

Anyone can confirm it is genuine here:
{{verifyUrl}}${SIGNATURE}`,
  },

  grading_scheduled: {
    key: 'grading_scheduled', topic: 'grading',
    requires: ['fullName', 'when', 'where', 'grade'],
    subject: 'Your grading — {{when}}',
    body: `Dear {{fullName}},

You are entered for grading to {{grade}}.

When:  {{when}}
Where: {{where}}${SIGNATURE}`,
  },

  event_registered: {
    key: 'event_registered', topic: 'competition',
    requires: ['fullName', 'eventTitle', 'when', 'where', 'ref'],
    subject: 'Entered: {{eventTitle}}',
    body: `Dear {{fullName}},

Your entry to {{eventTitle}} is recorded.

When:  {{when}}
Where: {{where}}
Ref:   {{ref}}${SIGNATURE}`,
  },

  booking_reminder: {
    key: 'booking_reminder', topic: 'booking',
    requires: ['contactName', 'what', 'when', 'where'],
    subject: 'Tomorrow: {{what}}',
    body: `Dear {{contactName}},

A reminder.

What:  {{what}}
When:  {{when}}
Where: {{where}}${SIGNATURE}`,
  },
};

export class TemplateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
  }
}

export function isTemplateError(err: unknown): err is TemplateError {
  return !!err && typeof err === 'object' && (err as any).name === 'TemplateError';
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Every placeholder a template actually uses. Used by the catalogue test. */
export function placeholdersIn(spec: TemplateSpec): string[] {
  const found = new Set<string>();
  for (const src of [spec.subject, spec.body]) {
    for (const m of src.matchAll(PLACEHOLDER)) found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * Render a template.
 *
 * Throws on an unknown template and on any missing value. See the header: a
 * message that renders "Dear ," is worse than one that fails loudly, because
 * the failure is caught by the workflow and the bad message is read by a
 * customer.
 */
export function render(templateKey: string, values: Record<string, unknown>): RenderedMessage {
  const spec = TEMPLATES[templateKey];
  if (!spec) throw new TemplateError('unknown_template', `No message template "${templateKey}".`);

  const needed = placeholdersIn(spec);
  const missing = needed.filter((k) => {
    const v = values[k];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length) {
    throw new TemplateError(
      'missing_values',
      `Template "${templateKey}" needs ${missing.join(', ')}, which was not supplied.`
    );
  }

  const fill = (src: string) => src.replace(PLACEHOLDER, (_, k) => String(values[k]));

  return {
    subject: fill(spec.subject).trim(),
    text: fill(spec.body).trim(),
    topic: spec.topic,
  };
}
