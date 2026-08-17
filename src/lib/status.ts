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

  // ── Payment attempts ─────────────────────────────────────────────────────
  // An attempt is not a payment. `initiated` says a checkout was opened, which
  // proves the payer pressed a button and nothing else; `abandoned` says they
  // never came back. Neither is a failure and neither is `bad`: a person who
  // changed their mind at a payment page has done nothing wrong, and colouring
  // it red would send the office chasing people who simply did not buy.
  initiated: { label: 'Initiated', tone: 'neutral', meaning: 'Checkout was opened. Nothing has been paid and nothing has failed.' },
  abandoned: { label: 'Abandoned', tone: 'neutral', meaning: 'The payer left without completing. No money moved and nothing went wrong.', terminal: true },

  // ── Reconciliation ───────────────────────────────────────────────────────
  //
  // What a reconciliation run decided about ONE item. Every value except
  // `matched` is an exception with a person's name on it, so every one of them
  // is actionable — an exception nobody is told to act on is a silent loss.
  //
  // The two "missing" values are deliberately NOT one value called `unmatched`.
  // They mean opposite things and are worked by different people: money the
  // gateway holds that MMAKF has no record of is an income the federation has
  // not recognised, and a payment MMAKF recorded that the gateway's statement
  // does not contain is money that may never have existed.
  matched: {
    label: 'Matched', tone: 'good',
    meaning: 'The gateway’s record and MMAKF’s agree on this item, to the paisa.',
    terminal: true,
  },
  missing_in_mmakf: {
    label: 'Missing in MMAKF', tone: 'bad',
    meaning: 'The gateway holds a transaction this system has no record of. Money arrived against nothing MMAKF issued.',
    actionable: true,
  },
  missing_at_gateway: {
    label: 'Missing at gateway', tone: 'bad',
    meaning: 'MMAKF recorded a payment the gateway’s statement does not contain. Something was fulfilled against money that may never have moved.',
    actionable: true,
  },
  duplicate: {
    label: 'Duplicate', tone: 'warn',
    meaning: 'The same transaction appears more than once. Until it is resolved, one of the copies is inflating the totals.',
    actionable: true,
  },
  amount_mismatch: {
    label: 'Amount mismatch', tone: 'bad',
    meaning: 'The gateway and MMAKF disagree on how much this was. The figure is never adjusted to match — the difference is investigated.',
    actionable: true,
  },
  currency_mismatch: {
    label: 'Currency mismatch', tone: 'bad',
    meaning: 'The two records are in different currencies, so they cannot be compared at all until somebody establishes which is right.',
    actionable: true,
  },
  unsettled: {
    label: 'Unsettled', tone: 'waiting',
    meaning: 'Captured and not yet paid into the bank. Normal for recent money; a concern once it is old.',
    actionable: true,
  },
  disputed: {
    label: 'Disputed', tone: 'warn',
    meaning: 'A payer’s bank is trying to reclaim this. The money is at risk and there is a deadline attached.',
    actionable: true,
  },

  // ── Disputes ─────────────────────────────────────────────────────────────
  //
  // `evidence_required` is the most consequential word on this list. A deadline
  // that passes unanswered loses the money BY DEFAULT rather than by decision,
  // and there is no appeal from having said nothing — which is why it is warn
  // and actionable rather than a neutral "awaiting".
  evidence_required: {
    label: 'Evidence required', tone: 'warn',
    meaning: 'MMAKF must submit its evidence before the deadline. A deadline that passes loses the money by default, with no appeal.',
    actionable: true,
  },
  evidence_submitted: {
    label: 'Evidence submitted', tone: 'progress',
    meaning: 'Sent to the gateway. The decision is theirs and the clock is no longer running on MMAKF.',
  },

  // ── Gateway health ───────────────────────────────────────────────────────
  //
  // `unknown` is neutral and is NOT a fault: it means nothing has probed the
  // gateway yet. Painting it red would have somebody investigating an outage
  // that has not been looked for.
  unknown:  { label: 'Unknown', tone: 'neutral', meaning: 'Not yet probed. This is an absence of measurement, not a report of a problem.' },
  healthy:  { label: 'Healthy', tone: 'good', meaning: 'Answering normally.' },
  degraded: { label: 'Degraded', tone: 'warn', meaning: 'Answering, slowly or partially. Payments may still succeed and some will not.', actionable: true },
  down:     { label: 'Down', tone: 'bad', meaning: 'Not answering. No payment can be taken through it.', actionable: true },

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

  // ── Fee benchmarks (§ market evidence about other organisations) ─────────
  //
  // The tones carry an argument. `excluded` is `stopped` and not `bad`: nothing
  // failed, a person DECIDED this figure must not inform a recommendation, and
  // that decision is theirs to defend. `flagged` is `warn` and NOT terminal,
  // because a flagged benchmark is still counted — somebody wants it looked at
  // and has not yet ruled on it, and dropping evidence at the moment of doubt
  // is how a sample gets curated into the answer that was wanted.
  included: {
    label: 'Counted',
    tone: 'good',
    meaning: 'Part of the evidence. Informs recommendations where its units are comparable.',
  },
  excluded: {
    label: 'Excluded',
    tone: 'stopped',
    meaning: 'Taken out of the evidence by a decision, with a recorded reason. Kept, so the decision can be reviewed.',
    terminal: true,
  },
  flagged: {
    label: 'Flagged',
    tone: 'warn',
    meaning: 'Somebody has queried this figure and nobody has ruled on it yet. Still counted, and said so on every recommendation it informs.',
    actionable: true,
  },

  // ── Gateway configuration, as opposed to gateway health ──────────────────
  //
  // Not a member of any enum, because it is DERIVED from the environment at
  // the moment of asking — a stored copy goes stale the day somebody sets the
  // key, and a stale "not configured" would route money away from a gateway
  // that works. It is in the dictionary because it is RENDERED, and it is
  // `neutral` because MMAKF has no gateway credentials today and that is a
  // configuration state rather than a fault (§70). Painting it red would tell
  // the office something is broken when nothing is.
  not_configured: {
    label: 'Not configured',
    tone: 'neutral',
    meaning: 'No credentials are set for this gateway, so it cannot take money. A configuration state, not a failure.',
  },

  // ── The regulatory engine (migration 0027) ───────────────────────────────
  //
  // WHOSE RULE IT IS, drawn as a status, because on the Policy Centre the
  // standing of a source provision is the first thing a reader has to be able
  // to tell. Every tone below is chosen against one question: could somebody
  // skim this chip and come away thinking an academy rule binds an MMAKF
  // member?
  //
  // Hence `adopted` is the ONLY 'good' one, and `not_adopted` is 'neutral'
  // rather than 'bad' — a provision nobody has adopted is the normal, correct
  // resting state of source material, not a failure of anything.
  not_adopted: {
    label: 'Not adopted', tone: 'neutral',
    meaning: 'Recorded source material. MMAKF has taken no decision on it, and it binds nobody.',
  },
  cited: {
    label: 'Cited, not adopted', tone: 'neutral',
    meaning: 'Referred to by MMAKF material without being adopted. The rule remains the publisher\'s.',
  },
  adopted: {
    label: 'Adopted by MMAKF', tone: 'good',
    meaning: 'Carried into an MMAKF instrument whose version has been approved and published. This one binds.',
  },
  flagged_not_adoptable: {
    label: 'Flagged — not adoptable', tone: 'bad',
    meaning: 'Recorded, with a reason, as material that must not become federation policy. The engine refuses to carry it into any instrument.',
    terminal: true,
  },

  // The engine's own answers. THREE OF THESE ARE NOT FINDINGS ABOUT A PERSON,
  // and their tones say so: an absence of policy is 'neutral' and a warning,
  // never 'bad', because rendering "no rule exists" in the same red as
  // "ineligible" is precisely how an unwritten policy comes to look like a
  // refusal on a screen.
  // `eligible` and `ineligible` are NOT redefined here, and the omission is the
  // point. They are already in the dictionary from grading, the database is
  // right to reuse the words, and a second entry under the same key would not
  // have added a policy meaning — a duplicate key in an object literal is not a
  // merge, the later one simply wins, so redefining them here silently took the
  // grading sentence away from grading. The policy sentences are in BY_DOMAIN
  // below, under `policy`, where they apply to policy and to nothing else.
  requires_review: {
    label: 'Requires review', tone: 'warn',
    meaning: 'Routed to a person. Nobody is sanctioned on an automatic flag.', actionable: true,
  },
  no_rule_in_force: {
    label: 'No rule in force', tone: 'neutral',
    meaning: 'MMAKF had approved no rule covering that date. An absence of policy — nothing may be decided against anyone on this basis.',
  },
  not_approved: {
    label: 'Rule not approved', tone: 'warn',
    meaning: 'A version covers the date but has not been approved and published. An unapproved rule decides nothing.',
  },
  insufficient_facts: {
    label: 'Insufficient facts', tone: 'waiting',
    meaning: 'A fact the rule tests was not supplied. Not a refusal — nobody is refused for a record they were never asked for.',
    actionable: true,
  },

  // Instrument and rule lifecycle states not already shared above. `effective`
  // is separate from `published` on purpose: a version can be published in
  // March and take effect in April, and a member refused in between was
  // refused under the previous one.
  // `technical_review` is likewise already here, from the coach pipeline, and
  // is used by affiliation stages and competition events as well. Its
  // instrument sentence is in BY_DOMAIN under `instrument`.
  legal_review: {
    label: 'Legal review', tone: 'progress',
    meaning: 'With legal review. Not approved and not in force.',
  },
  governance_review: {
    label: 'Governance review', tone: 'progress',
    meaning: 'Before the governing body for a decision. Not approved and not in force.', actionable: true,
  },
  effective: {
    label: 'In force', tone: 'good',
    meaning: 'Published and inside its effective window. This is the version that binds today.',
  },
  // ─────────────────────────────────────────────────────────────────────────
  // Identity, geography, the marketplace and schedules (migrations 0025,
  // 0029, 0032). Found the same way the 94 above were: by the guard reading
  // the enum labels out of the migrations and listing everything this file had
  // never heard of. Every one of them was already being stored, and already
  // being rendered as an untoned grey chip.
  // ─────────────────────────────────────────────────────────────────────────

  // ── Places, which change without anybody failing ─────────────────────────
  //
  // A district is split, a city is renamed, a municipality is dissolved into
  // its neighbour. None of those is an error and none is a deletion: an address
  // recorded in 2019 has to keep resolving, so the old row stays and points at
  // what it became. All three are therefore `neutral` and terminal — this is
  // administrative history, and a red chip on "Dissolved" would have somebody
  // trying to fix the map of India.
  merged: {
    label: 'Merged', tone: 'neutral',
    meaning: 'Absorbed into another record, which now carries it. This one is kept so that older references still resolve.',
    terminal: true,
  },
  renamed: {
    label: 'Renamed', tone: 'neutral',
    meaning: 'The same place under a new name. The old name is kept so an address written under it still resolves.',
    terminal: true,
  },
  dissolved: {
    label: 'Dissolved', tone: 'neutral',
    meaning: 'No longer exists as an administrative area. Kept, because records were written against it.',
    terminal: true,
  },

  // ── Ways of reaching a person ────────────────────────────────────────────
  //
  // `bounced` is neither the person's fault nor the federation's, and it is
  // still the one contact state that must never be quiet. An address nobody
  // knows is dead is an address a suspension notice gets sent to.
  bounced: {
    label: 'Bounced', tone: 'warn',
    meaning: 'Mail to this address came back undelivered. Nothing sent here can be assumed to have arrived.',
    actionable: true,
  },

  // ── Claimed relationships, and the word "verified" ───────────────────────
  //
  // `asserted` CONFERS NOTHING, and the label says so out loud rather than
  // reading as a finished state to somebody deciding whether to hand over a
  // child's record. A parent filling in a form has made a claim; access needs a
  // verified relationship AND a grant on top of it.
  //
  // `verified` is the federation's most reused good word — it appears on a
  // relationship, a brand authorisation, a payout account and a seller check,
  // and in each the evidence behind it is different. The tone is `good` in all
  // four; what changes is the sentence, and those live in BY_DOMAIN below,
  // because "verified" with no object is a badge nobody can check.
  asserted: {
    label: 'Claimed, not checked', tone: 'waiting',
    meaning: 'Somebody has stated this and nobody has checked it. On its own it grants nothing.',
    actionable: true,
  },
  verified: {
    label: 'Verified', tone: 'good',
    meaning: 'Somebody checked the evidence, and who they were and when is on the record. Not merely claimed.',
  },

  // ── Suspected duplicate records ──────────────────────────────────────────
  //
  // A duplicate candidate is a QUESTION about whether two rows are one human
  // being. `same` is `warn` and not `good`: agreeing that the register holds
  // one person twice is a finding about a defect, and the merge it calls for
  // has not happened yet. `distinct` is `good` because deciding that two
  // records are two people is a real answer, and it is what stops the pair
  // coming back every time the detector runs.
  same: {
    label: 'Same person', tone: 'warn',
    meaning: 'A reviewer decided these are one person. Nothing is merged by this alone — the merge is a separate decision with its own record.',
    actionable: true,
  },
  distinct: {
    label: 'Different people', tone: 'good',
    meaning: 'A reviewer decided these are two people. The pair will not be raised again.',
    terminal: true,
  },

  // ── Seller compliance, which drifts without anybody deciding anything ────
  //
  // Separate from the seller's own standing, and the tones are the reason. A
  // GST registration lapses on its own; nobody suspended anybody. So
  // `action_required` and `breach` are DIFFERENT SEVERITIES and are painted as
  // such: one is a certificate to renew, the other is a finding that the seller
  // broke something they agreed to. `not_assessed` is a neutral absence — it is
  // a statement about what MMAKF has looked at, not about the shop.
  not_assessed: {
    label: 'Not assessed', tone: 'neutral',
    meaning: 'Nobody has checked this seller against the requirements yet. An absence of assessment, not a finding.',
  },
  compliant: {
    label: 'Compliant', tone: 'good',
    meaning: 'Meets what MMAKF requires, as at the last assessment.',
  },
  action_required: {
    label: 'Action required', tone: 'warn',
    meaning: 'Something has lapsed or is missing and the seller can put it right. Not a sanction and not a finding of misconduct.',
    actionable: true,
  },
  breach: {
    label: 'In breach', tone: 'bad',
    meaning: 'The seller has broken a term they agreed to. A finding with consequences, recorded against them.',
    actionable: true,
  },

  // ── The storefront, which is not the seller ──────────────────────────────
  //
  // Both closures are `stopped` because both are somebody's decision rather
  // than a fault, and they are two values because WHOSE decision it was is the
  // whole question. A seller going away for a fortnight must not have to be
  // suspended in order to stop taking orders — a suspension is a governance
  // record that follows them. Only the federation's closure is actionable:
  // it is MMAKF's own review to finish, and the seller cannot end it.
  not_created: {
    label: 'No store yet', tone: 'neutral',
    meaning: 'The seller is registered and has not built a storefront. Nothing is on sale, and nothing is wrong.',
  },
  closed_by_seller: {
    label: 'Closed by seller', tone: 'stopped',
    meaning: 'The seller has closed their own shop. Their standing is untouched and they can reopen it themselves.',
  },
  closed_by_federation: {
    label: 'Closed by MMAKF', tone: 'stopped',
    meaning: 'Closed by the federation pending a review. The seller cannot reopen it; somebody at MMAKF has to.',
    actionable: true,
  },

  // ── Seller checks and brand authorisation ────────────────────────────────
  //
  // `claimed` is the value the counterfeit defence turns on. A seller typing
  // "authorised Adidas distributor" produces exactly this and nothing else, and
  // it must never read like a badge — the badge comes from a reviewer having
  // read a letter, and this is the state before anybody has.
  //
  // `documents_required` earns its place beside `under_review` by separating
  // "we are still looking at it" from "we are waiting for you". A queue that
  // cannot tell those apart is a queue where every stalled application looks
  // like the reviewer's fault.
  claimed: {
    label: 'Claimed, not verified', tone: 'waiting',
    meaning: 'The seller says so and nobody has read the document. It confers no badge and no permission.',
    actionable: true,
  },
  not_started: {
    label: 'Not started', tone: 'neutral',
    meaning: 'The check exists and nothing has been submitted for it. A neutral absence, not a refusal.',
  },
  documents_required: {
    label: 'Documents required', tone: 'warn',
    meaning: 'Waiting on the seller to supply something. Nothing further can be checked until they do.',
    actionable: true,
  },
  verifying: {
    label: 'Verifying', tone: 'progress',
    meaning: 'With the provider for a check. Nothing has been proved yet, and nothing should be relied on.',
  },
  disabled: {
    label: 'Disabled', tone: 'stopped',
    meaning: 'Taken out of use by a decision. The row is kept rather than deleted, because past records point at it.',
    terminal: true,
  },

  // ── Counterfeit and authenticity cases ───────────────────────────────────
  //
  // A case reaches a seller, may reach several of their listings at once,
  // involves a brand owner as a third party and ends in an enforcement decision
  // that has to be defensible. `evidence_requested` is `warn` and actionable
  // for the same reason `information_requested` is: a request with a due date
  // that nobody chases is a case that quietly expires — and here the seller's
  // listing may be sitting in quarantine for the whole of it.
  opened: {
    label: 'Opened', tone: 'waiting',
    meaning: 'On the record and not yet worked. Any quarantine applied at opening is a precaution, not a finding.',
    actionable: true,
  },
  evidence_requested: {
    label: 'Evidence requested', tone: 'warn',
    meaning: 'The seller has been asked to answer by a date. Nothing is decided until they do or the date passes.',
    actionable: true,
  },
  seller_responded: {
    label: 'Seller responded', tone: 'waiting',
    meaning: 'The seller has answered. The case is back with MMAKF and nobody else can move it.',
    actionable: true,
  },

  // ── Bulk product import, which never writes to the live catalogue ────────
  //
  // The pipeline is staged so that nothing unreviewed reaches the shop, and the
  // tones hold that line: `valid` means a row WOULD import cleanly, not that
  // anything exists, and it is `progress` rather than `good` for that reason. A
  // green chip on five hundred valid rows would tell a seller their products
  // were live when not one listing had been created.
  //
  // `partially_published` is the `partially_failed` of this table, and carries
  // the same warning: re-running the whole file duplicates everything that
  // worked the first time.
  uploaded: {
    label: 'Uploaded', tone: 'neutral',
    meaning: 'The file is stored and nothing has been read out of it yet.',
  },
  validating: {
    label: 'Validating', tone: 'progress',
    meaning: 'Rows are being checked. No listing exists yet.',
  },
  preview: {
    label: 'Ready to review', tone: 'waiting',
    meaning: 'Checked, and waiting for the seller to look at what it would create. Nothing is imported until they submit it.',
    actionable: true,
  },
  partially_published: {
    label: 'Partly published', tone: 'warn',
    meaning: 'SOME ROWS BECAME LISTINGS AND SOME DID NOT. Re-uploading the whole file would duplicate the ones that worked — read the rows first.',
    actionable: true,
  },
  valid: {
    label: 'Valid', tone: 'progress',
    meaning: 'This row would import cleanly. It has not created anything.',
  },
  invalid: {
    label: 'Invalid', tone: 'bad',
    meaning: 'This row cannot be imported as written. Its errors are recorded against it and the rest of the file is unaffected.',
    actionable: true,
  },

  // ── Flags and fraud signals: raised by anyone, enforced by a person ──────
  //
  // "AI can flag. Human review for serious enforcement." Nothing in either
  // table suspends anybody, and these tones keep that boundary visible.
  // `false_positive` is `neutral` and emphatically not `bad`: the subject did
  // nothing, the detector was wrong, and the row survives as evidence for
  // whoever tunes the detector. Red would file a shopkeeper who did nothing
  // beside the ones who did.
  investigating: {
    label: 'Investigating', tone: 'progress',
    meaning: 'Somebody is looking into the concern. Nothing has been decided about the listing.',
  },
  reviewing: {
    label: 'Reviewing', tone: 'progress',
    meaning: 'A person is looking at the signal. A detector’s opinion is not an action.',
  },
  actioned: {
    label: 'Actioned', tone: 'good',
    meaning: 'A person reviewed it and did something, which is recorded on the row with their name.',
    terminal: true,
  },
  false_positive: {
    label: 'False positive', tone: 'neutral',
    meaning: 'The detector was wrong. Nothing was done and nothing should be — kept so the check that raised it can be corrected.',
    terminal: true,
  },

  // ── Stock reservations ───────────────────────────────────────────────────
  //
  // A hold is not a sale. `committed` is the moment the payment cleared and the
  // units stopped being available to anybody else; `released` is the hold given
  // back, always with a recorded reason, because stock that reappears without
  // one is indistinguishable from stock that was never held.
  committed: {
    label: 'Committed', tone: 'progress',
    meaning: 'Payment cleared and these units are set aside for this order. They have not left the shelf yet.',
  },
  released: {
    label: 'Released', tone: 'neutral',
    meaning: 'The hold was given back and the units are on sale again. The reason is recorded on the reservation.',
    terminal: true,
  },

  // ── Seller orders, shipments and returns ─────────────────────────────────
  //
  // These describe WORK, not money: one order can be paid while one seller's
  // part of it is shipped and another's is still being packed. Nothing here is
  // `good` until the goods actually arrive or the money actually goes back — a
  // buyer is not helped by a green chip on a parcel that has had a label
  // printed for it and nothing more.
  //
  // `refund_pending` is the one to read twice. It says a refund is owed and has
  // not been paid, which means a real person is out of pocket right now; it is
  // `waiting` and actionable everywhere it appears.
  order_created: {
    label: 'Order placed', tone: 'neutral',
    meaning: 'Recorded against the seller. Nothing has been paid, picked or promised.',
  },
  payment_pending: {
    label: 'Payment pending', tone: 'waiting',
    meaning: 'The buyer has not paid, so nothing should be shipped. The stock is held, not sold.',
    actionable: true,
  },
  seller_accepted: {
    label: 'Accepted by seller', tone: 'progress',
    meaning: 'The seller has taken the order on. Nothing has been packed yet.',
  },
  shipped: {
    label: 'Shipped', tone: 'progress',
    meaning: 'Handed to a carrier. Where the seller gave no tracking number there is no tracking, and nothing here invents one.',
  },
  in_transit: {
    label: 'In transit', tone: 'progress',
    meaning: 'With the carrier and moving. Carrier dates are estimates and are never shown as a promise.',
  },
  label_printed: {
    label: 'Label printed', tone: 'progress',
    meaning: 'A label exists. The parcel has NOT left the seller — this is not a dispatch and the carrier has not seen it.',
  },
  picked_up: {
    label: 'Picked up', tone: 'progress',
    meaning: 'The carrier has collected it from the seller.',
  },
  out_for_delivery: {
    label: 'Out for delivery', tone: 'progress',
    meaning: 'On today’s round, as the carrier last reported it.',
  },
  returned_to_origin: {
    label: 'Returned to sender', tone: 'warn',
    meaning: 'The carrier could not deliver it and sent it back. The buyer has paid and has nothing.',
    actionable: true,
  },
  return_requested: {
    label: 'Return requested', tone: 'warn',
    meaning: 'The buyer has asked to send it back. Nothing is agreed until the seller or MMAKF answers.',
    actionable: true,
  },
  seller_reviewing: {
    label: 'With the seller', tone: 'waiting',
    meaning: 'The seller is deciding whether to take it back, against the policy as it stood when the buyer asked.',
    actionable: true,
  },
  // `authorised` and `authorized` are one letter apart and describe opposite
  // kinds of thing. The American spelling is already in this file for a payment
  // whose funds are HELD AND NOT TAKEN; this one is a return the seller has
  // agreed to accept. Two chips both reading "Authorised" on the same order
  // would be indefensible, so this one says what was authorised.
  authorised: {
    label: 'Return authorised', tone: 'good',
    meaning: 'The seller has agreed to take it back and the buyer may send it. Not a refund — no money has moved.',
  },
  inspected: {
    label: 'Inspected', tone: 'progress',
    meaning: 'The seller has examined what came back. What follows depends on the finding, which is recorded.',
  },
  refund_pending: {
    label: 'Refund pending', tone: 'waiting',
    meaning: 'A refund is owed and has not been paid. The buyer is out of pocket until it is.',
    actionable: true,
  },
  exchanged: {
    label: 'Exchanged', tone: 'good',
    meaning: 'Settled by sending a replacement rather than money.',
    terminal: true,
  },
  seller_responding: {
    label: 'Awaiting seller reply', tone: 'waiting',
    meaning: 'The seller has been asked to answer the buyer’s complaint and has a date to do it by.',
    actionable: true,
  },

  // ── Settlement and payout ────────────────────────────────────────────────
  //
  // `on_hold` and `reversed` are the two that must never be quiet. A held
  // settlement is a seller's money that MMAKF is sitting on by decision, and a
  // reversed payout is money that left and came back — the seller has not been
  // paid, whatever the settlement says about what they are owed.
  paying: {
    label: 'Paying', tone: 'progress',
    meaning: 'The transfer has been instructed and has not landed. DO NOT INSTRUCT IT AGAIN — a payout that goes twice cannot be undone by a status change.',
  },
  on_hold: {
    label: 'On hold', tone: 'warn',
    meaning: 'Withheld by a decision, with a reason. This is a seller’s money that MMAKF has chosen not to send yet.',
    actionable: true,
  },
  reversed: {
    label: 'Reversed', tone: 'bad',
    meaning: 'The transfer went out and came back. The seller has NOT been paid, and the reason the bank gave is on the record.',
    actionable: true,
  },

  // ── Promotions, which cannot spend a seller's money unasked ──────────────
  //
  // Two consent states rather than one "pending", because the two gates are
  // different people: the seller agreeing that their goods may be discounted —
  // the discount comes out of their payable — and the federation approving the
  // promotion at all. One value for both would let a promotion go live having
  // cleared only one of them.
  awaiting_seller_consent: {
    label: 'Awaiting seller consent', tone: 'waiting',
    meaning: 'The discount comes out of the seller’s money and they have not agreed to it. It cannot run.',
    actionable: true,
  },
  awaiting_federation_approval: {
    label: 'Awaiting MMAKF approval', tone: 'waiting',
    meaning: 'The seller has agreed and the federation has not approved it yet.',
    actionable: true,
  },

  // ── Product reviews ──────────────────────────────────────────────────────
  //
  // `hidden` is not `rejected`. A rejected review never passed moderation; a
  // hidden one was published and has been taken down since. That is a different
  // fact about a real person's words, and somebody may have to account for it.
  hidden: {
    label: 'Hidden', tone: 'stopped',
    meaning: 'Was visible and has been taken down by a decision, with a reason. The text is kept.',
  },

  // ── The technical library ────────────────────────────────────────────────
  //
  // What a stored technical fact RESTS ON, which is not the same as whether it
  // is true. Only `committee_verified` is federation instruction; the other two
  // say plainly that it is not, and a learner is entitled to see which of the
  // three they are being shown.
  unverified: {
    label: 'Unverified', tone: 'neutral',
    meaning: 'Recorded, with nothing cited for it yet. Not federation instruction.',
  },
  source_documented: {
    label: 'Source documented', tone: 'progress',
    meaning: 'A named source states this and the citation is on file. It carries that source’s authority, not MMAKF’s.',
  },
  committee_verified: {
    label: 'Committee verified', tone: 'good',
    meaning: 'Checked by an MMAKF technical reviewer, who is named on the record.',
  },

  // ── Schedules ────────────────────────────────────────────────────────────
  //
  // `retired` is neutral and terminal for the same reason `archived` is. A
  // timetable that governs nothing today is still the answer to "why was the
  // dojo shut that Tuesday", and every date worked out under it stays worked
  // out under it.
  retired: {
    label: 'Retired', tone: 'neutral',
    meaning: 'No longer governs any date. Kept, because the days it did govern were worked out from it.',
    terminal: true,
  },
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
    // `venues.active` is a boolean, and the register calls the false side
    // withdrawn. Without this the reader would be told a room had been "taken
    // back by whoever submitted it", which is the applications meaning of the
    // word and describes nothing that happens to a hall. The tone stays
    // `stopped`: a room goes out of use because somebody decided it should.
    withdrawn: {
      label: 'Withdrawn',
      meaning: 'Taken out of use. Kept in the register rather than deleted, because past sessions point at it.',
    },
  },
  // A workflow definition's `active` flag is also a boolean, and it decides
  // whether a trigger starts anything at all. "Inactive" is far too mild for
  // that: an administrator reading it as "quiet at the moment" would wait for
  // an acknowledgement that is never going to be sent.
  automation: {
    active: { meaning: 'This is the version its trigger starts.' },
    inactive: {
      label: 'Switched off',
      tone: 'stopped',
      meaning: 'Installed and not running. Nothing happens in this version when its trigger fires.',
    },
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
  // ── Workflow runs ────────────────────────────────────────────────────────
  //
  // Four of these words are already in the dictionary WITH THE PAYMENT MEANING,
  // because payments are where they were first needed. Put on an automation run
  // they are not merely vague, they are wrong: `pending` would tell an operator
  // the run is "with the payment provider", and `failed` would assure them that
  // "no money moved" about a job whose whole question is what it did before it
  // stopped. The tones are unchanged — only the sentence a reader is given.
  workflow: {
    pending: { meaning: 'Created and not yet claimed by a worker.' },
    running: { meaning: 'Claimed and executing. A second worker cannot pick it up while it is here.' },
    succeeded: {
      meaning: 'No required step failed. A step marked optional may have failed and the run still reads as succeeded, so the steps are worth reading before assuming every effect happened.',
    },
    failed: {
      meaning: 'A required step failed and none had succeeded before it, so nothing the automation intended took effect.',
    },
    skipped: {
      meaning: 'Nothing ran, because the same idempotency key had already succeeded, was still in progress, or had used its attempts.',
    },
  },
  // ── Reconciliation items ─────────────────────────────────────────────────
  //
  // `refunded` on a reconciliation item is not the refund's own status. It is a
  // VERDICT on a discrepancy: the gateway and MMAKF differ, and the difference
  // is explained by a refund rather than by a loss. The dictionary sentence —
  // "Refunded", full stop — would leave a finance officer reading an exception
  // list unable to tell an explained difference from an unexplained one.
  reconciliation: {
    // The base entry reads "the same transaction appears more than once", which
    // describes a statement imported twice — an accounting nuisance. That is
    // NOT what src/db/reconciliation.ts classifies as `duplicate`: it groups
    // gateway transactions by the merchant reference, so a duplicate here means
    // two separate charges against one purchase, and a real person is out of
    // pocket until somebody refunds them. `warn` would put that beside "this
    // has not settled yet" in a queue, which is where it would stay.
    duplicate: {
      label: 'Duplicate charge',
      tone: 'bad',
      meaning: 'Two charges against one purchase. Somebody has paid twice and is owed the second one back.',
      actionable: true,
    },
    refunded: {
      tone: 'neutral',
      meaning: 'The difference between the two records is accounted for by a refund. Explained, and needs nothing further.',
      terminal: true,
    },
    disputed: {
      label: 'Disputed',
      tone: 'warn',
      meaning: 'The difference is accounted for by a dispute that is still open. It resolves when the dispute does.',
      actionable: true,
    },
  },

  // ── Reconciliation runs ──────────────────────────────────────────────────
  //
  // The defect this block exists for is the one already documented above for
  // workflow runs and notification deliveries, a third time. `failed` carries
  // the PAYMENT sentence — "Did not complete. No money moved." — which read
  // against a reconciliation run is an assurance about the federation's money
  // made by a job that did not manage to look at it.
  reconciliation_run: {
    pending: { meaning: 'Scheduled and not yet started. Nothing has been compared.' },
    running: { meaning: 'Comparing now. The counts below are not final until it completes.' },
    completed: { meaning: 'Every item in the period was classified. That is not the same as every item being matched — read the exceptions.' },
    failed: {
      meaning: 'The run stopped before classifying the period. NOTHING IS PROVEN EITHER WAY: the absence of exceptions here is the absence of a comparison, not a clean result.',
      actionable: true,
    },
    cancelled: { meaning: 'Stopped by a person. The period it covered has not been reconciled by this run.', actionable: true },
  },

  // ── Disputes ─────────────────────────────────────────────────────────────
  //
  // `accepted` is why this block is not optional. In the dictionary it is a
  // GOOD tone, because almost everywhere in the federation accepting something
  // is a success. On a chargeback it means MMAKF conceded and handed the money
  // back — a loss, chosen rather than suffered. A green chip against it would
  // tell a treasurer scanning the register that the conceded ones went well.
  //
  // `cancelled` inverts the other way: the dictionary paints it `bad`, and a
  // dispute the payer's bank withdrew is the best outcome available.
  dispute: {
    open: { meaning: 'Raised by the payer’s bank and not yet answered. The evidence window is running.', actionable: true },
    under_review: { meaning: 'With the gateway for a decision. Nothing further can be submitted.' },
    won: { meaning: 'MMAKF kept the money. The gateway’s handling fee is charged regardless of the outcome.' },
    lost: { meaning: 'The money went back to the payer, and the gateway’s handling fee is charged on top of it.' },
    accepted: {
      label: 'Conceded',
      tone: 'stopped',
      meaning: 'MMAKF chose not to defend and returned the money. A loss taken deliberately — not a success.',
      terminal: true,
    },
    expired: {
      tone: 'bad',
      meaning: 'The evidence deadline passed with nothing submitted, so the money was lost by default rather than by decision. There is no appeal from silence.',
      terminal: true,
    },
    cancelled: {
      tone: 'good',
      meaning: 'Withdrawn by the payer’s bank before any decision. MMAKF keeps the money.',
      terminal: true,
    },
  },

  // ── Notification and push delivery ───────────────────────────────────────
  //
  // The same defect the workflow block above exists for, one table over.
  // `failed` carries the PAYMENT sentence, so the delivery page would tell an
  // operator "No money moved" about an SMS a provider rejected — and tell it to
  // every screen-reader user too, because Status exposes the meaning through
  // aria-describedby and not only as a mouse tooltip.
  //
  // `expired` is the one that had to change. Its dictionary sentence says a
  // deadline passed without a decision; the federation publishes no deadlines,
  // and on a push registration the word means the browser's own subscription is
  // no longer valid. Nobody missed anything and there is nobody to chase.
  //
  // Tones are unchanged throughout — only the sentence a reader is given.
  notification: {
    queued: { meaning: 'Written and waiting for a transport. Not lost: it goes out once a provider for its channel is configured.' },
    sent: { meaning: 'A transport accepted it. That is not the same as it having been read.' },
    failed: { meaning: 'A transport rejected it. The reason the provider gave is recorded against the message.' },
    expired: {
      meaning: 'The device registration is no longer valid, so there was nothing to deliver to. Normal churn — people replace phones and clear browser data.',
    },
  },
  // ── Places and duplicate records (migration 0025) ────────────────────────
  //
  // `merged` is one word for two administrative acts. A merged AREA is a place
  // that became part of another place; a merged DUPLICATE is two records of one
  // human being that a named reviewer decided to combine, which is the most
  // consequential thing anybody does to a person's file. The base sentence is
  // written to be true of both; these say which one happened.
  geography: {
    merged: {
      meaning: 'Absorbed into a neighbouring area, which now covers it. Addresses written under this one still resolve through it.',
    },
  },
  duplicate_candidate: {
    merged: {
      meaning: 'The two records were combined by a named decider, with a reason. The record that survived is on the row.',
    },
  },

  // ── The four places the federation says "verified" ───────────────────────
  //
  // One word, four evidences, and the difference is what the reader is being
  // asked to rely on. A verified RELATIONSHIP is the ground on which somebody
  // is let near a child's file. A verified BRAND AUTHORISATION is a reviewer
  // having read a letter from a manufacturer, and it is the whole of the
  // counterfeit defence. A verified PAYOUT ACCOUNT is a provider confirming
  // that a bank account exists, which is NOT a statement about who owns it —
  // and a treasurer who reads it as one has been misled by a green chip.
  //
  // The tone stays `good` throughout. Only the sentence changes.
  relationship: {
    verified: {
      meaning: 'Checked against evidence by a named person. Access to a child’s record still needs a grant on top of this.',
    },
  },
  brand_authorisation: {
    verified: {
      meaning: 'A reviewer has read the authorisation document. This, and nothing a seller typed, is where the brand badge comes from.',
    },
  },
  payout_account: {
    verified: {
      meaning: 'The provider confirmed the account. It says the account exists — not who owns it.',
    },
    // The base sentence is the payment one, "No money moved", which is true of
    // a failed charge and meaningless about an account that could not be
    // checked. What matters here is the consequence: nothing will be sent to it.
    failed: {
      meaning: 'The account could not be verified, so no payout will be attempted to it. The reason is recorded.',
    },
  },
  seller_verification: {
    verified: {
      meaning: 'This check passed on evidence recorded at the time. A check of a document that expires, expires with it.',
    },
  },

  // ── Seller orders (migration 0029) ───────────────────────────────────────
  //
  // Three words in this enum already carry another table's meaning, which is
  // the defect documented above for workflow runs, notification deliveries and
  // reconciliation runs, a fourth time. `processing` would tell a shopkeeper
  // their order is "with the payment provider, do not retry" when it means they
  // are packing it; `delivered` would tell them it was "held, with attendance
  // recorded", which is the sentence written for a coaching session; and
  // `disputed` would announce that a payer's bank is reclaiming the money when
  // a marketplace dispute is a buyer complaining about goods and the money has
  // not moved at all.
  seller_order: {
    processing: { meaning: 'The seller is preparing the goods. Nothing to do with the payment, which cleared before this.' },
    delivered: { meaning: 'The buyer has it, as the carrier reported. The return window runs from here.' },
    disputed: {
      meaning: 'The buyer has complained about this order. Not a chargeback — the money is still where it was, and this is answered by the seller rather than by a bank.',
      actionable: true,
    },
  },

  // A shipment is a parcel, and the three words below were written for other
  // things entirely: `delivered` for a coaching session, `failed` for a payment
  // — "No money moved", about a parcel — and `lost` for a sales lead nobody
  // won. A buyer ringing about a missing order is the worst possible audience
  // for any of the three.
  shipment: {
    delivered: { meaning: 'The carrier reported it delivered. Where there is no tracking, this is the seller’s word for it.' },
    failed: {
      tone: 'warn',
      meaning: 'A delivery attempt did not succeed. The parcel still exists and the carrier’s reason is recorded.',
      actionable: true,
    },
    lost: {
      meaning: 'The carrier has declared it lost. The buyer has paid and will not receive it — somebody must refund or resend.',
      actionable: true,
    },
  },

  // A return is a parcel travelling the other way, and its words were written
  // for cases and applications. `received` is the sentence for a disciplinary
  // complaint being logged, and `approved` is the one for an application that
  // has been accepted but may not be public yet.
  return_request: {
    approved: { meaning: 'The seller has agreed to the return. Nothing has been sent back and no money has moved.' },
    received: { meaning: 'The goods are back with the seller. Nothing is refunded until they have been looked at.' },
    in_transit: { meaning: 'The buyer has sent it back and it is on its way to the seller.' },
  },

  // A marketplace dispute is a buyer saying a seller let them down. It is not
  // the chargeback in `dispute` above — different parties, different evidence,
  // different clock — and `open` here is not the task-queue "assigned and not
  // started" the base entry describes.
  marketplace_dispute: {
    open: {
      meaning: 'A buyer has complained and nobody has answered. The seller has a date to respond by.',
      actionable: true,
    },
  },

  // ── Bulk import rows ─────────────────────────────────────────────────────
  //
  // Every word in this small enum already means something else in this file,
  // and each would be wrong in a way a seller would act on. `pending` is the
  // payment sentence; `duplicate` is the reconciliation one, which would tell a
  // shopkeeper that "the same transaction appears more than once" about a line
  // of their spreadsheet; `created` says "nothing has been attempted yet" about
  // the one value in the enum that means a listing now exists; and `skipped`
  // says its conditions were not met when what happened is that somebody chose
  // not to import it.
  //
  // The duplicate is deliberately NOT actionable. In reconciliation a duplicate
  // is money somebody is owed back; here it is a spreadsheet row that will not
  // be imported twice, and counting five hundred of them into the federation's
  // "needs attention" total would bury the ones that matter.
  product_import_row: {
    pending: { meaning: 'Read out of the file and not yet checked.' },
    duplicate: {
      label: 'Duplicate row',
      tone: 'warn',
      meaning: 'The same product as another row or as something already in the catalogue. It will not create a second listing.',
      actionable: false,
    },
    created: {
      label: 'Listing created',
      tone: 'good',
      meaning: 'This row became a DRAFT listing. It goes through the same moderation as a hand-typed one before anybody can buy it.',
    },
    skipped: { meaning: 'Left out of the import deliberately. Nothing was created from it, and the row is kept.' },
  },
  product_import: {
    failed: {
      meaning: 'The import stopped before it finished. Read the rows before uploading the file again — some of them may already have become listings.',
      actionable: true,
    },
  },

  // ── Stock reservations ───────────────────────────────────────────────────
  //
  // `held` in this dictionary is the minutes of a meeting that took place. On a
  // reservation it is the units set aside for an order nobody has paid for yet,
  // which is the only thing standing between two buyers and the same last gi.
  stock_reservation: {
    held: {
      tone: 'progress',
      meaning: 'Units set aside for an unpaid order. Nobody else can buy them until it is paid or lapses.',
    },
    expired: { meaning: 'The order it was held for lapsed, so the units went back on sale.' },
    fulfilled: { meaning: 'The goods left the building and the units came off the shelf for good.' },
  },

  // ── Settlements ──────────────────────────────────────────────────────────
  //
  // A settlement is a seller's account for a period, and `open` and `closed`
  // are the two words on it that carry the most money. The dictionary's `open`
  // is a task nobody has started; here it means the period is still ACCRUING
  // and every figure on the screen can still change. `closed` is not "no longer
  // of interest" — it is the moment the figures stop moving and the statement
  // becomes a document, and it is emphatically NOT terminal: approval, payment
  // and the transfer itself all come after it, and a surface that greyed those
  // out because the base entry says `closed` is the end of the road would leave
  // a seller unpaid with no button to press.
  settlement: {
    open: {
      tone: 'progress',
      meaning: 'The period is still accruing and lines may still be added. Nothing here is final.',
      actionable: false,
    },
    closed: {
      tone: 'waiting',
      meaning: 'The period is sealed and the net is final. Anything arriving after this lands in the next period as an adjustment.',
      actionable: true,
      terminal: false,
    },
    approved: { meaning: 'Released for payment by somebody with the authority to release it. The transfer is a separate record.' },
    paid: { meaning: 'The payout for this settlement landed. The bank reference is on the payout, not here.' },
  },

  // ── Flags, cases and fraud signals ───────────────────────────────────────
  //
  // `upheld` and `dismissed` come from the protest vocabulary, where upholding
  // is a success. Against a shop they are the other way round: an upheld
  // counterfeit case is a finding AGAINST the seller, and painting it `good`
  // because the complainant won would be the sort of chip a marketplace
  // manager scans past. `dismissed` keeps its neutral tone in all three, but
  // says what was dismissed and what should happen next.
  listing_flag: {
    open: { meaning: 'A concern has been raised about a listing that may be live, and nobody has worked it yet.' },
    upheld: {
      tone: 'bad',
      meaning: 'The concern was found to be right. What was done about the listing is recorded beside it.',
      terminal: true,
    },
    dismissed: { meaning: 'Looked at and found to be nothing. The listing stands, and the flag is kept so the pattern stays visible.' },
  },
  authenticity_case: {
    upheld: {
      tone: 'bad',
      meaning: 'The authenticity claim was found proved. The enforcement taken is recorded on the case.',
      terminal: true,
    },
    dismissed: {
      meaning: 'The claim was not made out. Any quarantine applied while it was investigated should now be lifted.',
      actionable: true,
    },
  },
  fraud_signal: {
    open: { meaning: 'Raised by a detector and not yet looked at. A signal has no power of its own — nothing acts on this.' },
    dismissed: { meaning: 'A person looked and judged there was nothing in it. No action was taken against anybody.' },
  },

  // ── Promotions ───────────────────────────────────────────────────────────
  //
  // `active` on a promotion is money coming off prices at this moment, which is
  // the `live` tone rather than the coach's "approved and available for
  // assignment". It decays: an administrator glancing at the marketplace must
  // notice a running discount without reading.
  promotion: {
    active: { label: 'Running', tone: 'live', meaning: 'The discount is being applied at checkout now.' },
    ended: { meaning: 'Its window has passed. Prices are back to what the seller set.' },
  },

  // ── The technical library ────────────────────────────────────────────────
  //
  // `disputed` in this dictionary is a payer's bank reclaiming money, complete
  // with a deadline and a treasurer. On a technical record it means two
  // credible sources disagree and the library says so rather than silently
  // picking a winner. No money, no deadline, nobody to chase — and it is not a
  // fault in the record, it is the record being honest.
  technical: {
    disputed: {
      label: 'Sources disagree',
      tone: 'warn',
      meaning: 'Two credible sources disagree and the record says so rather than choosing between them. Not federation instruction.',
      actionable: false,
    },
  },

  // ── The words that mean "trading" and "in use" ───────────────────────────
  //
  // `open` and `active` were both already here carrying the sentence of
  // whichever domain needed them first: a task assigned to somebody and not
  // started, and a coach available for assignment. Neither is wrong where it
  // came from, and both are wrong on a shop.
  //
  // `open` is much the more expensive of the two. `store_status.open` IS A
  // SHOP THAT IS TRADING, so without this override every open storefront in the
  // marketplace is marked actionable and counted by needsAction() as work
  // nobody has begun. The §19 dashboard question — "what needs my
  // attention?" — is only worth asking if the ordinary is not in the answer.
  store: {
    open: {
      label: 'Open',
      tone: 'good',
      meaning: 'Trading. Buyers can see the shop and place orders with it.',
      actionable: false,
    },
    draft: { meaning: 'Being built by the seller. Nothing in it is on sale and no buyer can see it.' },
  },

  // A brand MMAKF has blocked is a decision about the BRAND — a counterfeit
  // problem, an impersonation, a trade-mark dispute — and it is not a finding
  // against any one seller who happened to list under it. The base `blocked`
  // belongs to the task board and reads "Cannot proceed until something else
  // does", which invites a reader to wait for a dependency that does not exist.
  brand: {
    active: { meaning: 'Listings may name this brand, subject to any authorisation the brand itself requires.' },
    restricted: { meaning: 'A listing naming this brand needs a verified authorisation from its seller.' },
    blocked: {
      tone: 'stopped',
      meaning: 'No listing may name this brand at all. A decision about the brand, not a finding against a seller.',
      actionable: false,
    },
  },
  listing_variant: {
    active: { label: 'On sale', meaning: 'Buyable, subject to stock.' },
  },

  // ── Timetables (migration 0032) ──────────────────────────────────────────
  //
  // ONE active schedule per owner, purpose and room is enforced by a partial
  // unique index in scheduling.schema.ts, because two would make resolution a
  // coin toss and the loser would be somebody's Sunday. "Approved and available
  // for assignment" says none of that, and a second schedule that looks equally
  // "active" on screen is how somebody comes to create one.
  schedule: {
    active: { label: 'In force', meaning: 'The one the resolver reads for this owner and purpose. Only one may be in force at a time.' },
    draft: { meaning: 'Editable, and invisible to every read. No day resolves against it.' },
  },
  season: {
    active: { label: 'Current', meaning: 'The stretch of the calendar being worked in now.' },
  },
  dojo_class: {
    active: { meaning: 'Running to its timetable. Members may be enrolled in it.' },
  },

  // ── The regulatory engine (migration 0027) ───────────────────────────────
  //
  // Three words the engine needed were already spoken for, and the database is
  // right to reuse them. What cannot be reused is the sentence: grading's "May
  // sit the examination" says nothing about a rule applied to a date.
  //
  // `ineligible` is the one that matters. In grading it is terminal — the
  // candidate did not meet the requirement and that sitting is over. An engine
  // answer is NOT terminal, because a rule applied to a person is appealable,
  // and a terminal status greys out the actions a surface offers. Marking an
  // appealable refusal as the end of the road is how somebody comes to believe
  // there is nothing they can do.
  policy: {
    eligible: { meaning: 'Every condition of the rule in force on that date was met.' },
    ineligible: {
      meaning: 'A rule was in force and the subject did not meet it. The failed condition is recorded, and the decision is appealable.',
      terminal: false,
    },
  },
  instrument: {
    technical_review: { meaning: 'With the technical committee. Not approved, and not in force.' },
    approved: { meaning: 'Approved, and not necessarily in force — a version can be approved in March and take effect in April.' },
    published: { meaning: 'Published. It binds only inside its effective window.' },
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

  // ── Money movement, reconciliation and disputes (migration 0017) ──────────
  //
  // `payment_attempt` and `payment_intent` are two lists because they are two
  // things: an intent succeeds at most once and an attempt is one try at it.
  // A filter menu that offered only one of them would make "show me the failed
  // attempts" and "show me the purchases nobody managed to pay for" the same
  // question, and they have very different answers.
  payment_intent: ['open', 'succeeded', 'failed', 'cancelled', 'expired'],
  payment_attempt: ['initiated', 'pending', 'succeeded', 'failed', 'abandoned', 'cancelled'],
  reconciliation_run: ['pending', 'running', 'completed', 'failed', 'cancelled'],
  // NOT lifecycle order — these are parallel outcomes of one comparison, so the
  // order is WORST FIRST. A finance officer opening a filter menu should meet
  // "the federation is short" before "this has not settled yet".
  reconciliation: [
    'missing_in_mmakf', 'duplicate', 'missing_at_gateway',
    'amount_mismatch', 'currency_mismatch', 'disputed', 'refunded', 'unsettled',
    'matched',
  ],
  dispute: [
    'open', 'evidence_required', 'evidence_submitted', 'under_review',
    'won', 'lost', 'accepted', 'expired', 'cancelled',
  ],
  gateway: ['unknown', 'healthy', 'degraded', 'down', 'not_configured'],
};

/** Every raw value the dictionary knows. Used by the drift guard in tests. */
export function knownStatuses(): string[] {
  return Object.keys(DICTIONARY);
}
