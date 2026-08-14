// The federation-wide status dictionary (§102).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// §102: "Never use Active / Enabled / Live / Running interchangeably unless
// they mean different states. Define a federation-wide status dictionary."
//
// Before this file, the codebase had twenty-eight separate status enums across
// ten schema files, and each surface invented its own colour and wording for
// them. `active` meant "this dojo holds a current charter", "this coach is
// available for assignment", "this membership is paid up" and "this competition
// is happening right now" — four different facts wearing one word, each painted
// whatever colour the page author reached for.
//
// This module does NOT replace those enums. The database is right to have
// distinct enums: a booking status and a coach status are genuinely different
// vocabularies, and collapsing them would let a coach be `rescheduled`. What it
// replaces is the twenty-eight private opinions about how each one LOOKS and
// what it MEANS to a reader.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MODEL
// ─────────────────────────────────────────────────────────────────────────────
//
// Every status in the federation maps onto one of eight TONES. A tone is a
// promise to the reader about what kind of fact they are looking at, and it is
// the only thing that decides colour. That is what stops `failed` being amber on
// one screen and red on another.
//
// The tones are deliberately few. Nine tones would mean nobody could remember
// which to use, and the distinctions that matter operationally are these:
//
//   neutral   — a fact with no charge. Draft. Archived.
//   progress  — something is underway and nobody is waiting on the reader.
//   waiting   — SOMEBODY MUST ACT. This is the one that earns its own tone:
//               "under review" and "in progress" look alike and are not, and a
//               queue that cannot distinguish them is a queue nobody works.
//   good      — the desired end state. Approved. Confirmed. Paid.
//   live      — happening NOW. Distinct from `good` because it decays: a live
//               match needs watching, a completed one does not.
//   warn      — recoverable, and the reader should look. Changes requested.
//   bad       — failed, rejected, cancelled. Terminal and unwanted.
//   stopped   — deliberately halted by a person. Suspended. Withdrawn. NOT the
//               same as `bad`: somebody CHOSE this, and the distinction matters
//               when the subject is a person's standing.

export type Tone =
  | 'neutral' | 'progress' | 'waiting' | 'good' | 'live' | 'warn' | 'bad' | 'stopped';

export interface StatusMeaning {
  /** Sentence case, for a reader. Never SCREAMING_SNAKE from the database. */
  label: string;
  tone: Tone;
  /**
   * What it means, in operational terms — the tooltip and the legend.
   *
   * §91 (design for trust): a federation's rankings, certificates and results
   * are consequential, and a status the reader cannot interpret is a status
   * they will guess at.
   */
  meaning?: string;
  /**
   * True when somebody must do something for this to move.
   *
   * Drives "needs attention" counters and the §19 dashboard question — "what
   * needs my attention?" — without every surface re-deciding which of its
   * twenty statuses count as pending.
   */
  actionable?: boolean;
  /** True when nothing follows. Used to grey out actions that cannot apply. */
  terminal?: boolean;
}

/**
 * The dictionary.
 *
 * Keyed by the RAW database value. Several enums share values (`draft` appears
 * in six), and that is exactly the point: they share a value because they mean
 * the same thing, so they should read and look the same.
 *
 * Where a value genuinely means different things in different domains, it is
 * disambiguated with a `domain:value` key and resolved by `statusOf(value,
 * domain)` below.
 */
const DICTIONARY: Record<string, StatusMeaning> = {
  // ── Lifecycle, shared by almost every entity (§88 approval engine) ────────
  draft:              { label: 'Draft', tone: 'neutral', meaning: 'Not yet submitted. Only visible to whoever is writing it.' },
  submitted:          { label: 'Submitted', tone: 'waiting', meaning: 'Received and waiting to be picked up.', actionable: true },
  under_review:       { label: 'Under review', tone: 'progress', meaning: 'Someone is looking at it now.' },
  changes_requested:  { label: 'Changes requested', tone: 'warn', meaning: 'Sent back with a reason. The applicant can correct it and resubmit.', actionable: true },
  approved:           { label: 'Approved', tone: 'good', meaning: 'Accepted. Not necessarily visible to the public yet.' },
  rejected:           { label: 'Rejected', tone: 'bad', meaning: 'Refused, with a recorded reason.', terminal: true },
  published:          { label: 'Published', tone: 'good', meaning: 'Approved and publicly visible.' },
  archived:           { label: 'Archived', tone: 'neutral', meaning: 'Kept for the record and no longer in use.', terminal: true },
  withdrawn:          { label: 'Withdrawn', tone: 'stopped', meaning: 'Taken back by whoever submitted it.', terminal: true },
  expired:            { label: 'Expired', tone: 'neutral', meaning: 'Passed its own deadline without a decision.', terminal: true },
  superseded:         { label: 'Superseded', tone: 'neutral', meaning: 'Replaced by a later version, which is kept intact.', terminal: true },
  cancelled:          { label: 'Cancelled', tone: 'bad', meaning: 'Called off.', terminal: true },

  // ── Institutional applications ───────────────────────────────────────────
  acknowledged:         { label: 'Acknowledged', tone: 'progress', meaning: 'MMAKF has confirmed receipt to the applicant.' },
  information_requested:{ label: 'Information requested', tone: 'warn', meaning: 'Waiting on the institution to supply something.', actionable: true },
  program_design:       { label: 'Programme design', tone: 'progress', meaning: 'Being configured into a deliverable programme.' },
  quoted:               { label: 'Quoted', tone: 'progress', meaning: 'A quotation has been issued and is with the institution.' },
  proposed:             { label: 'Proposed', tone: 'progress', meaning: 'A formal proposal is with the institution.' },
  contracted:           { label: 'Contracted', tone: 'good', meaning: 'Agreed and signed.' },
  declined:             { label: 'Declined', tone: 'bad', meaning: 'The institution did not proceed.', terminal: true },

  // ── Leads (§H) ───────────────────────────────────────────────────────────
  new:            { label: 'New', tone: 'waiting', meaning: 'Nobody has picked this up yet.', actionable: true },
  qualifying:     { label: 'Qualifying', tone: 'progress', meaning: 'Being assessed for fit and seriousness.' },
  qualified:      { label: 'Qualified', tone: 'progress', meaning: 'A real opportunity, being worked.' },
  won:            { label: 'Won', tone: 'good', terminal: true },
  lost:           { label: 'Lost', tone: 'bad', terminal: true },
  dormant:        { label: 'Dormant', tone: 'neutral', meaning: 'No contact for a long time. Not closed, not moving.' },
  disqualified:   { label: 'Disqualified', tone: 'stopped', meaning: 'Not a genuine enquiry.', terminal: true },

  // ── Tasks (§M) ───────────────────────────────────────────────────────────
  open:           { label: 'Open', tone: 'waiting', meaning: 'Assigned and not started.', actionable: true },
  in_progress:    { label: 'In progress', tone: 'progress', meaning: 'Somebody is working on it.' },
  blocked:        { label: 'Blocked', tone: 'warn', meaning: 'Cannot proceed until something else does.', actionable: true },
  done:           { label: 'Done', tone: 'good', terminal: true },

  // ── Support tickets (§L) ─────────────────────────────────────────────────
  assigned:         { label: 'Assigned', tone: 'waiting', meaning: 'With a named agent and not yet answered.', actionable: true },
  waiting_user:     { label: 'Waiting on requester', tone: 'neutral', meaning: 'MMAKF has replied. The clock is not running on us.' },
  waiting_internal: { label: 'Waiting internally', tone: 'warn', meaning: 'Needs another team before it can move.', actionable: true },
  escalated:        { label: 'Escalated', tone: 'warn', meaning: 'Raised because it passed its deadline or was asked to be.', actionable: true },
  resolved:         { label: 'Resolved', tone: 'good', meaning: 'Answered. The requester can still reopen it.' },
  closed:           { label: 'Closed', tone: 'neutral', terminal: true },

  // ── Coaches (§I) ─────────────────────────────────────────────────────────
  candidate:        { label: 'Candidate', tone: 'waiting', meaning: 'Applied. Screening has not started.', actionable: true },
  screening:        { label: 'Screening', tone: 'progress' },
  interview:        { label: 'Interview', tone: 'progress' },
  technical_review: { label: 'Technical review', tone: 'progress', meaning: 'Karate assessed by the technical authority.' },
  document_check:   { label: 'Document check', tone: 'progress', meaning: 'Grades, identity and clearances being verified.' },
  active:           { label: 'Active', tone: 'good', meaning: 'Approved and available for assignment.' },
  suspended:        { label: 'Suspended', tone: 'stopped', meaning: 'Standing halted by a decision. Not available for assignment.', actionable: true },
  inactive:         { label: 'Inactive', tone: 'neutral', meaning: 'Not currently taking work. No adverse finding.' },

  // ── Coach assignment ─────────────────────────────────────────────────────
  recommended: { label: 'Recommended', tone: 'waiting', meaning: 'Put forward by the assignment engine. Nobody has decided.', actionable: true },
  accepted:    { label: 'Accepted', tone: 'good' },
  confirmed:   { label: 'Confirmed', tone: 'good', meaning: 'Agreed by both sides and on the calendar.' },
  completed:   { label: 'Completed', tone: 'good', terminal: true },

  // ── Bookings and sessions ────────────────────────────────────────────────
  requested:              { label: 'Requested', tone: 'waiting', actionable: true },
  qualification_required: { label: 'Qualification required', tone: 'warn', meaning: 'Cannot be confirmed until something is established.', actionable: true },
  rescheduled:            { label: 'Rescheduled', tone: 'neutral', meaning: 'Moved. The replacement carries the detail.' },
  scheduled:              { label: 'Scheduled', tone: 'progress', meaning: 'On the calendar and not yet held.' },
  delivered:              { label: 'Delivered', tone: 'good', meaning: 'Held, with attendance recorded.' },
  no_show:                { label: 'No show', tone: 'bad', meaning: 'Nobody attended.', terminal: true },

  // ── Quotes and contracts (§G) ────────────────────────────────────────────
  awaiting_approval: { label: 'Awaiting approval', tone: 'waiting', meaning: 'Computed, and cannot be sent until somebody approves it.', actionable: true },
  issued:            { label: 'Issued', tone: 'progress', meaning: 'Sent to the institution.' },
  signed:            { label: 'Signed', tone: 'good' },
  terminated:        { label: 'Terminated', tone: 'stopped', meaning: 'Ended early by a decision.', terminal: true },

  // ── Payments (§46: "never show ambiguous payment states") ────────────────
  pending:            { label: 'Pending', tone: 'waiting', meaning: 'Started and not yet confirmed by the provider.', actionable: true },
  processing:         { label: 'Processing', tone: 'progress', meaning: 'With the payment provider. Do not retry.' },
  successful:         { label: 'Successful', tone: 'good', terminal: true },
  failed:             { label: 'Failed', tone: 'bad', meaning: 'Did not complete. No money moved.', actionable: true },
  refunded:           { label: 'Refunded', tone: 'neutral', terminal: true },
  partially_refunded: { label: 'Partially refunded', tone: 'warn' },

  // ── Competitions (§24) ───────────────────────────────────────────────────
  registration_open:         { label: 'Registration open', tone: 'live', meaning: 'Accepting entries now.' },
  registration_closing_soon: { label: 'Closing soon', tone: 'warn', meaning: 'Entries close shortly.', actionable: true },
  registration_closed:       { label: 'Registration closed', tone: 'neutral' },
  draw_pending:              { label: 'Draw pending', tone: 'waiting', meaning: 'Entries are in and the draw has not been made.', actionable: true },
  live:                      { label: 'Live', tone: 'live', meaning: 'Happening now.' },
  results_pending:           { label: 'Results pending', tone: 'waiting', meaning: 'Finished, and results are not published.', actionable: true },
  results_published:         { label: 'Results published', tone: 'good' },

  // ── Workflow runs (§AF) ──────────────────────────────────────────────────
  running:          { label: 'Running', tone: 'live' },
  succeeded:        { label: 'Succeeded', tone: 'good', terminal: true },
  partially_failed: { label: 'Partially failed', tone: 'warn', meaning: 'SOME EFFECTS ALREADY HAPPENED. Check what completed before re-running.', actionable: true },
  skipped:          { label: 'Skipped', tone: 'neutral', meaning: 'Its conditions were not met, so it did nothing.', terminal: true },

  // ── Memberships and standing ─────────────────────────────────────────────
  lapsed:    { label: 'Lapsed', tone: 'warn', meaning: 'Was current and has run out.', actionable: true },
  revoked:   { label: 'Revoked', tone: 'stopped', meaning: 'Withdrawn by a decision of the federation.', terminal: true },
  prospect:  { label: 'Prospect', tone: 'neutral', meaning: 'Known to the federation. No relationship yet.' },
  former:    { label: 'Former', tone: 'neutral', terminal: true },

  // ── Account and invitation ───────────────────────────────────────────────
  invited: { label: 'Invited', tone: 'waiting', meaning: 'Invitation sent and not yet accepted.', actionable: true },

  // ─────────────────────────────────────────────────────────────────────────
  // The 94 below were found by tests/status-dictionary.test.ts, which reads the
  // enum labels straight out of the migrations. Every one existed in the
  // database and rendered as an untoned grey chip. That is the exact failure the
  // guard was written to catch, and it caught it the first time it ran.
  // ─────────────────────────────────────────────────────────────────────────

  // ── Units and people ─────────────────────────────────────────────────────
  provisional: { label: 'Provisional', tone: 'progress', meaning: 'Recognised while its charter is completed.' },
  // Recorded with no adverse tone and no colour. A person is not a failure
  // state, and rendering this in red would be indefensible on a register a
  // family may read.
  deceased:    { label: 'Deceased', tone: 'neutral', terminal: true },

  // ── Grading candidates (§34) ─────────────────────────────────────────────
  applied:            { label: 'Applied', tone: 'waiting', meaning: 'Entered and not yet checked for eligibility.', actionable: true },
  eligibility_check:  { label: 'Eligibility check', tone: 'progress', meaning: 'Time in grade, attendance and standing being verified.' },
  eligible:           { label: 'Eligible', tone: 'good', meaning: 'May sit the examination.' },
  ineligible:         { label: 'Not eligible', tone: 'bad', meaning: 'Does not meet the requirement. The reason is recorded.', terminal: true },
  fee_pending:        { label: 'Fee pending', tone: 'waiting', meaning: 'Cannot proceed until the fee is settled.', actionable: true },
  absent:             { label: 'Absent', tone: 'bad', meaning: 'Did not attend.', terminal: true },
  examined:           { label: 'Examined', tone: 'progress', meaning: 'Sat the examination. The result is not yet decided.' },
  passed:             { label: 'Passed', tone: 'good', terminal: true },
  // NOT a failure, and deliberately not toned as one. In grading, referred
  // means the candidate may present again — telling somebody they failed when
  // the panel said "come back" is a real misrepresentation of a decision.
  referred:           { label: 'Referred', tone: 'warn', meaning: 'Not awarded on this occasion. The candidate may present again.' },

  // ── Grading events ───────────────────────────────────────────────────────
  scoring: { label: 'Scoring', tone: 'live', meaning: 'Panel is scoring now.' },
  locked:  { label: 'Locked', tone: 'good', meaning: 'Scores are final and can no longer be edited.' },

  // ── Certificates ─────────────────────────────────────────────────────────
  reissued: { label: 'Reissued', tone: 'neutral', meaning: 'Replaced by a new copy. The original number is retained.' },

  // ── Disciplinary and safeguarding cases ──────────────────────────────────
  received:            { label: 'Received', tone: 'waiting', meaning: 'Logged and not yet assessed.', actionable: true },
  triage:              { label: 'Triage', tone: 'progress', meaning: 'Being assessed for seriousness and route.' },
  under_investigation: { label: 'Under investigation', tone: 'progress' },
  hearing_scheduled:   { label: 'Hearing scheduled', tone: 'progress' },
  heard:               { label: 'Heard', tone: 'progress', meaning: 'The hearing has taken place. A decision is pending.' },
  decided:             { label: 'Decided', tone: 'good', meaning: 'A decision has been recorded.' },
  appealed:            { label: 'Appealed', tone: 'warn', meaning: 'The decision has been challenged.', actionable: true },
  appeal_heard:        { label: 'Appeal heard', tone: 'progress' },

  // ── Competition entries and events ───────────────────────────────────────
  checked_in:      { label: 'Checked in', tone: 'good', meaning: 'Present at the venue.' },
  weighed_in:      { label: 'Weighed in', tone: 'good' },
  check_in:        { label: 'Check-in', tone: 'live', meaning: 'Competitors are checking in now.' },
  postponed:       { label: 'Postponed', tone: 'warn', meaning: 'Moved. A new date may not be set yet.', actionable: true },
  results_final:   { label: 'Results final', tone: 'good', terminal: true },
  sanction_review: { label: 'Sanction review', tone: 'waiting', meaning: 'Awaiting federation sanction before it may be held.', actionable: true },

  // ── Matches (§28) ────────────────────────────────────────────────────────
  called:          { label: 'Called', tone: 'waiting', meaning: 'Competitors have been called to the tatami.', actionable: true },
  paused:          { label: 'Paused', tone: 'warn', meaning: 'Stopped and expected to resume.' },
  under_protest:   { label: 'Under protest', tone: 'warn', meaning: 'The result is contested and not final.', actionable: true },
  walkover:        { label: 'Walkover', tone: 'neutral', meaning: 'Won without a contest — the opponent did not appear.', terminal: true },
  disqualification:{ label: 'Disqualification', tone: 'bad', terminal: true },

  // ── Results ──────────────────────────────────────────────────────────────
  // §91: a federation result is consequential, so provisional must never read
  // as final. It is a different tone precisely so a glance can tell them apart.
  final:     { label: 'Final', tone: 'good', meaning: 'Confirmed. Rankings are computed from this.', terminal: true },
  corrected: { label: 'Corrected', tone: 'warn', meaning: 'Amended after publication. The change is on the record.' },
  voided:    { label: 'Voided', tone: 'bad', meaning: 'Struck. Does not count towards anything.', terminal: true },

  // ── Protests ─────────────────────────────────────────────────────────────
  lodged:    { label: 'Lodged', tone: 'waiting', meaning: 'Submitted and awaiting a decision.', actionable: true },
  upheld:    { label: 'Upheld', tone: 'good', meaning: 'The protest succeeded.', terminal: true },
  dismissed: { label: 'Dismissed', tone: 'neutral', meaning: 'The protest did not succeed. The original result stands.', terminal: true },

  // ── Meetings and motions (§43) ───────────────────────────────────────────
  notice_issued:    { label: 'Notice issued', tone: 'progress', meaning: 'Convened. Papers have gone out.' },
  held:             { label: 'Held', tone: 'good', meaning: 'The meeting took place.' },
  adjourned:        { label: 'Adjourned', tone: 'warn', meaning: 'Suspended, to continue later.' },
  minutes_draft:    { label: 'Minutes in draft', tone: 'progress', meaning: 'Not yet an official record.' },
  minutes_approved: { label: 'Minutes approved', tone: 'good', meaning: 'The official record of the meeting.' },
  carried:          { label: 'Carried', tone: 'good', meaning: 'The motion passed.', terminal: true },
  defeated:         { label: 'Defeated', tone: 'bad', meaning: 'The motion did not pass.', terminal: true },
  deferred:         { label: 'Deferred', tone: 'neutral', meaning: 'Held over to a later meeting.' },

  // ── Orders, payments and fulfilment ──────────────────────────────────────
  awaiting_payment: { label: 'Awaiting payment', tone: 'waiting', actionable: true },
  paid:             { label: 'Paid', tone: 'good' },
  fulfilled:        { label: 'Fulfilled', tone: 'good', terminal: true },
  created:          { label: 'Created', tone: 'neutral', meaning: 'Recorded. Nothing has been attempted yet.' },
  authorized:       { label: 'Authorised', tone: 'progress', meaning: 'Funds are held and NOT yet taken.' },
  captured:         { label: 'Captured', tone: 'good', meaning: 'Funds taken.' },
  not_required:     { label: 'Not required', tone: 'neutral', meaning: 'Nothing to send — a digital or in-person item.' },
  packed:           { label: 'Packed', tone: 'progress' },
  dispatched:       { label: 'Dispatched', tone: 'progress', meaning: 'On its way.' },
  returned:         { label: 'Returned', tone: 'warn', meaning: 'Came back. A reason should be recorded.', actionable: true },
  out_of_stock:     { label: 'Out of stock', tone: 'warn', actionable: true },
  discontinued:     { label: 'Discontinued', tone: 'neutral', terminal: true },

  // ── Marketplace ──────────────────────────────────────────────────────────
  delisted: { label: 'Delisted', tone: 'stopped', meaning: 'Taken down by the federation.', terminal: true },

  // ── Enrolments and courses ───────────────────────────────────────────────
  pending_payment: { label: 'Payment pending', tone: 'waiting', actionable: true },
  review:          { label: 'In review', tone: 'progress' },

  // ── Broadcast and media ──────────────────────────────────────────────────
  upcoming:             { label: 'Upcoming', tone: 'neutral', meaning: 'Scheduled and not started.' },
  recording_processing: { label: 'Processing', tone: 'progress', meaning: 'The recording is being prepared.' },
  recorded:             { label: 'Recorded', tone: 'good', meaning: 'A recording is available.' },
  ended:                { label: 'Ended', tone: 'neutral', terminal: true },
  missing:              { label: 'Missing', tone: 'bad', meaning: 'Expected and not found at the source.', actionable: true },

  // ── Media rights ─────────────────────────────────────────────────────────
  // These carry legal weight. `not_cleared` must never be mistaken for
  // `permission_pending`: one means somebody asked and was refused.
  federation_owned:   { label: 'Federation owned', tone: 'good', meaning: 'MMAKF holds the rights outright.' },
  licensed:           { label: 'Licensed', tone: 'good', meaning: 'Used under a licence. Terms apply.' },
  permission_pending: { label: 'Permission pending', tone: 'waiting', meaning: 'Asked for, not yet granted. Do not publish.', actionable: true },
  cleared:            { label: 'Cleared', tone: 'good', meaning: 'Cleared for publication.' },
  not_cleared:        { label: 'Not cleared', tone: 'bad', meaning: 'MUST NOT be published.', terminal: true },
  restricted:         { label: 'Restricted', tone: 'warn', meaning: 'Publishable only in the stated circumstances.' },

  // ── Calendar connections and sync ────────────────────────────────────────
  connected:         { label: 'Connected', tone: 'good' },
  error:             { label: 'Error', tone: 'bad', meaning: 'The connection is failing. Events are not syncing.', actionable: true },
  synced:            { label: 'Synced', tone: 'good' },
  conflict:          { label: 'Conflict', tone: 'warn', meaning: 'Changed in both places. MMAKF is the system of record.', actionable: true },
  deleted_remotely:  { label: 'Deleted remotely', tone: 'warn', meaning: 'Removed from the external calendar. The MMAKF booking stands.', actionable: true },

  // ── Push delivery ────────────────────────────────────────────────────────
  // The three suppressions are `neutral`, not `bad`. Nothing went wrong: the
  // system honoured a preference or a quiet hour, which is the behaviour asked
  // for. Painting them as failures would push somebody to "fix" them.
  queued:                     { label: 'Queued', tone: 'progress' },
  sent:                       { label: 'Sent', tone: 'good' },
  suppressed_quiet_hours:     { label: 'Held — quiet hours', tone: 'neutral', meaning: 'Not sent because it fell inside the recipient’s quiet hours.' },
  suppressed_preference:      { label: 'Held — preference', tone: 'neutral', meaning: 'Not sent because the recipient does not want this topic.' },
  suppressed_duplicate:       { label: 'Held — duplicate', tone: 'neutral', meaning: 'Not sent because an identical notice had just gone out.' },
  unsubscribed:               { label: 'Unsubscribed', tone: 'stopped', terminal: true },

  // ── Support ──────────────────────────────────────────────────────────────
  awaiting_member: { label: 'Waiting on member', tone: 'neutral', meaning: 'MMAKF has replied. The clock is not running on us.' },

  // ── Programmes ───────────────────────────────────────────────────────────
  planned: { label: 'Planned', tone: 'neutral', meaning: 'Agreed and not yet scheduled.' },
};

/**
 * Domain-specific overrides, for the few values that genuinely differ.
 *
 * `active` is the case that forced this. For a coach it means "available for
 * assignment"; for a membership it means "paid up and in good standing"; for a
 * competition it would mean "happening now" — which is why competitions use
 * `live` instead and do not appear here.
 */
const BY_DOMAIN: Record<string, Record<string, Partial<StatusMeaning>>> = {
  membership: {
    active: { label: 'Current', meaning: 'Paid up and in good standing.' },
  },
  coach: {
    active: { meaning: 'Approved and available for assignment.' },
    inactive: { meaning: 'Not taking work at present. No adverse finding — this is not a sanction.' },
  },
  institution: {
    active: { meaning: 'Has at least one programme running.' },
  },
  venue: {
    active: { label: 'In use', meaning: 'Available to be booked.' },
  },
  // `referred` means two unrelated things, and the difference is a person's
  // grading result against a committee's paperwork. In grading it means "not
  // this time, present again"; in governance it means "sent to a committee".
  motion: {
    referred: { label: 'Referred', tone: 'neutral', meaning: 'Sent to a committee rather than decided here.' },
  },
  // A programme is paused by a decision, not by a failure.
  program: {
    paused: { label: 'Paused', tone: 'stopped', meaning: 'Delivery halted by agreement. Not cancelled.' },
  },
};

/** Anything unrecognised. Never throws — a surface must still render. */
function unknown(value: string): StatusMeaning {
  return {
    label: humanise(value),
    tone: 'neutral',
    // Deliberately not "Unknown status". The reader is not helped by being told
    // the software is confused; they are helped by seeing the raw value, which
    // is at least the truth and is what they will quote when they report it.
    meaning: undefined,
  };
}

/** `results_published` → `Results published`. */
export function humanise(value: string): string {
  const v = String(value ?? '').replace(/[_-]+/g, ' ').trim();
  if (!v) return '';
  return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
}

/**
 * Look up a status.
 *
 * @param value  the raw database value
 * @param domain optional, to disambiguate a shared word like `active`
 */
export function statusOf(value: string | null | undefined, domain?: string): StatusMeaning {
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return { label: '—', tone: 'neutral' };

  const base = DICTIONARY[key];
  if (!base) return unknown(key);

  const override = domain ? BY_DOMAIN[domain]?.[key] : undefined;
  return override ? { ...base, ...override } : base;
}

/** Does this status need somebody to do something? Drives §19 attention counts. */
export function needsAction(value: string | null | undefined, domain?: string): boolean {
  return statusOf(value, domain).actionable === true;
}

/** Is this the end of the road? Used to disable actions that cannot apply. */
export function isTerminal(value: string | null | undefined, domain?: string): boolean {
  return statusOf(value, domain).terminal === true;
}

/**
 * The CSS custom properties a tone paints with.
 *
 * Returned as an inline `style` string rather than a class, so a status can be
 * rendered anywhere without that surface having imported a stylesheet — and so
 * there is exactly one place where a tone becomes a colour.
 *
 * Every colour here is an EXISTING token. No new hex values: the palette was
 * fixed by the federation, and several of its values were chosen to clear a
 * measured contrast ratio.
 */
export function toneVars(tone: Tone): string {
  switch (tone) {
    case 'good':
      return '--st-fg: var(--gold-3); --st-bd: var(--gold-dim); --st-bg: rgba(160,124,30,0.08);';
    case 'live':
      // The only tone that moves. Live is the one state where a reader glancing
      // at a screen must notice without reading.
      return '--st-fg: var(--red-2); --st-bd: rgba(142,18,18,0.45); --st-bg: rgba(142,18,18,0.07);';
    case 'bad':
      return '--st-fg: var(--red); --st-bd: var(--red-3); --st-bg: rgba(142,18,18,0.05);';
    case 'warn':
      return '--st-fg: var(--numeral); --st-bd: rgba(149,86,79,0.4); --st-bg: rgba(149,86,79,0.06);';
    case 'waiting':
      return '--st-fg: var(--gold-3); --st-bd: var(--gold-dim); --st-bg: rgba(160,124,30,0.06);';
    case 'stopped':
      return '--st-fg: var(--off-white); --st-bd: var(--control-border); --st-bg: rgba(26,23,19,0.05);';
    case 'progress':
      return '--st-fg: var(--off-white); --st-bd: var(--border-2); --st-bg: transparent;';
    case 'neutral':
    default:
      return '--st-fg: var(--muted); --st-bd: var(--border); --st-bg: transparent;';
  }
}

/**
 * Every status a domain can hold, in the order a reader should meet them.
 *
 * For filter menus and legends. Order is LIFECYCLE ORDER, not alphabetical —
 * a filter listing `approved, cancelled, draft, rejected, submitted` tells the
 * reader nothing about how work actually flows.
 */
export const LIFECYCLES: Record<string, readonly string[]> = {
  application: [
    'draft', 'submitted', 'acknowledged', 'under_review', 'information_requested',
    'program_design', 'quoted', 'proposed', 'approved', 'contracted',
    'declined', 'withdrawn', 'expired',
  ],
  lead: ['new', 'qualifying', 'qualified', 'quoted', 'proposed', 'won', 'lost', 'dormant', 'disqualified'],
  task: ['open', 'in_progress', 'blocked', 'done', 'cancelled'],
  ticket: ['open', 'assigned', 'in_progress', 'waiting_user', 'waiting_internal', 'escalated', 'resolved', 'closed'],
  coach: [
    'candidate', 'screening', 'interview', 'technical_review', 'document_check',
    'approved', 'active', 'suspended', 'inactive', 'withdrawn', 'rejected',
  ],
  assignment: ['recommended', 'proposed', 'accepted', 'declined', 'confirmed', 'withdrawn', 'completed'],
  booking: [
    'requested', 'qualification_required', 'proposed', 'confirmed',
    'rescheduled', 'cancelled', 'completed', 'no_show', 'expired',
  ],
  session: ['scheduled', 'delivered', 'cancelled', 'rescheduled', 'no_show'],
  quote: ['draft', 'awaiting_approval', 'issued', 'accepted', 'rejected', 'expired', 'withdrawn', 'superseded'],
  contract: ['draft', 'issued', 'signed', 'active', 'completed', 'terminated', 'expired'],
  payment: ['pending', 'processing', 'successful', 'failed', 'refunded', 'partially_refunded', 'cancelled'],
  program_template: ['draft', 'under_review', 'approved', 'published', 'archived'],
  workflow: ['pending', 'running', 'succeeded', 'partially_failed', 'failed', 'skipped'],
};

/** Every raw value the dictionary knows. Used by the drift guard in tests. */
export function knownStatuses(): string[] {
  return Object.keys(DICTIONARY);
}
