// MMAKF fee master — long-term programmes only.
//
// Supplied by the federation office on 2026-11-06 as the consolidated fee
// catalogue for MMAKF, Karate Academy Bharat and Karate.net.in. Transcribed
// here row by row; every amount is in PAISE (₹1 = 100).
//
// GOVERNANCE, AS THE OFFICE STATED IT:
//   approved  — a confirmed fee. Loaded into fee_schedule as ACTIVE, so checkout
//               may charge it.
//   proposed  — a provisional amount. Loaded INACTIVE, so createOrder() refuses
//               it ("No published fee"), until an authorised administrator
//               approves it at /admin/fee-register.
//   (archived — a historical price: given an end date there. Nothing below is.)
// "The payment system should never charge a proposed fee until an authorised
// administrator approves it." That rule is enforced by fee_schedule.active and
// createOrder(), not by this file.
//
// Items marked "proposed" in the office's document, and every affiliation and
// tournament/event fee (the office: "provisional until reconciled against the
// existing MMAKF fee register"), are 'proposed'. Everything else is 'approved'.
//
// The student rule (src/db/student-rule.ts) still applies at load AND at
// approval: a fee that charges a student for standing — an admission or a
// student membership — is loaded inactive with the refusal recorded, so the
// office sees the conflict instead of the code silently charging or silently
// dropping it.

export type FeeGroup =
  | '01 Long-term Training'
  | '02 Academy Courses'
  | '03 WKF Performance'
  | '04 Specialised Programmes'
  | '05 Kyu & Dan Grading'
  | '06 Membership'
  | '07 Affiliation'
  | '08 Tournaments & Events'
  | '09 Equipment & Certificates';

export const FEE_GROUPS: FeeGroup[] = [
  '01 Long-term Training',
  '02 Academy Courses',
  '03 WKF Performance',
  '04 Specialised Programmes',
  '05 Kyu & Dan Grading',
  '06 Membership',
  '07 Affiliation',
  '08 Tournaments & Events',
  '09 Equipment & Certificates',
];

export interface FeeMasterRow {
  group: FeeGroup;
  code: string;
  label: string;
  kind: 'training' | 'course' | 'grading' | 'membership' | 'affiliation' | 'event_entry' | 'certificate' | 'other';
  amountPaise: number;
  status: 'approved' | 'proposed';
  /** How the fee is charged and any condition attached to it. */
  notes: string;
}

const ON_SITE = 'On-site group condition: minimum 50 paid students at one location; below 50, group training is online by default.';
const rs = (rupees: number) => Math.round(rupees * 100);

export const FEE_MASTER_SOURCE = 'MMAKF fee master supplied by the federation office, 2026-11-06';

export const FEE_MASTER: FeeMasterRow[] = [
  // ── 01 Long-term Karate training programmes ──────────────────────────────
  { group: '01 Long-term Training', code: 'training.online.standard.month', label: 'Standard Online Batch (per month)', kind: 'training', amountPaise: rs(1500), status: 'approved', notes: 'Monthly subscription, charged per month.' },
  { group: '01 Long-term Training', code: 'training.online.premium.month', label: 'Premium Online Batch (per month)', kind: 'training', amountPaise: rs(3000), status: 'approved', notes: 'Monthly subscription, charged per month.' },
  { group: '01 Long-term Training', code: 'training.online.one-to-one.month', label: 'Online One-to-one (per month)', kind: 'training', amountPaise: rs(7000), status: 'approved', notes: 'Monthly subscription, charged per month.' },
  { group: '01 Long-term Training', code: 'training.onsite.standard.student-month', label: 'Standard On-site Batch (per student, per month)', kind: 'training', amountPaise: rs(1500), status: 'approved', notes: `Long-term, per student per month. ${ON_SITE}` },
  { group: '01 Long-term Training', code: 'training.onsite.premium.student-month', label: 'Premium On-site Batch (per student, per month)', kind: 'training', amountPaise: rs(3000), status: 'approved', notes: `Long-term, per student per month. ${ON_SITE}` },
  { group: '01 Long-term Training', code: 'training.onsite.one-to-one.month', label: 'On-site One-to-one (per month)', kind: 'training', amountPaise: rs(50000), status: 'approved', notes: 'Monthly, charged per month.' },

  // ── 02 Complete Shotokan Karate courses ───────────────────────────────────
  { group: '02 Academy Courses', code: 'course.shotokan.01-taste-the-discipline', label: 'Course 01 – Taste the Discipline (White to Yellow Belt)', kind: 'course', amountPaise: rs(8000), status: 'approved', notes: 'Course-based.' },
  { group: '02 Academy Courses', code: 'course.shotokan.02-the-black-belt', label: 'Course 02 – The Black Belt (White Belt to Shodan)', kind: 'course', amountPaise: rs(143800), status: 'approved', notes: '54 months. Includes the ₹45,000 online student kit.' },
  { group: '02 Academy Courses', code: 'course.shotokan.03a-shodan-to-nidan', label: 'Course 03A – Shodan to Nidan', kind: 'course', amountPaise: rs(46000), status: 'approved', notes: 'Advanced.' },
  { group: '02 Academy Courses', code: 'course.shotokan.03b-nidan-to-sandan', label: 'Course 03B – Nidan to Sandan', kind: 'course', amountPaise: rs(69000), status: 'approved', notes: 'Advanced.' },
  { group: '02 Academy Courses', code: 'course.shotokan.advanced-black-belt', label: 'Complete Advanced Black Belt (Shodan to Sandan)', kind: 'course', amountPaise: rs(115000), status: 'approved', notes: 'Combined 03A + 03B.' },

  // ── 03 Unified WKF Performance Pathway ────────────────────────────────────
  { group: '03 WKF Performance', code: 'wkf.online.batch.month', label: 'WKF Performance – Online Batch (per month)', kind: 'training', amountPaise: rs(15000), status: 'approved', notes: 'One integrated long-term programme: Kihon, WKF Kata, WKF Kumite, rules and strategy, conditioning, competition preparation and assessment.' },
  { group: '03 WKF Performance', code: 'wkf.online.premium.month', label: 'WKF Performance – Online Premium (per month)', kind: 'training', amountPaise: rs(30000), status: 'approved', notes: 'One integrated long-term programme.' },
  { group: '03 WKF Performance', code: 'wkf.onsite.batch.student-month', label: 'WKF Performance – On-site Batch (per student, per month)', kind: 'training', amountPaise: rs(15000), status: 'approved', notes: `One integrated long-term programme. ${ON_SITE}` },
  { group: '03 WKF Performance', code: 'wkf.onsite.premium.student-month', label: 'WKF Performance – On-site Premium (per student, per month)', kind: 'training', amountPaise: rs(30000), status: 'approved', notes: `One integrated long-term programme. ${ON_SITE}` },

  // ── 04 Specialised long-term programmes ───────────────────────────────────
  { group: '04 Specialised Programmes', code: 'programme.womens-self-defence.12-week', label: "Women's Self-Defence (12-week programme)", kind: 'course', amountPaise: rs(20000), status: 'approved', notes: '12-week programme.' },
  { group: '04 Specialised Programmes', code: 'programme.advanced-self-defence', label: 'Advanced Self-Defence (long-term course)', kind: 'course', amountPaise: rs(30000), status: 'approved', notes: 'Long-term course.' },
  { group: '04 Specialised Programmes', code: 'programme.childrens-karate.month', label: "Children's Karate (per month)", kind: 'training', amountPaise: rs(1500), status: 'approved', notes: 'Monthly.' },
  { group: '04 Specialised Programmes', code: 'programme.competitive-athlete.month', label: 'Competitive Athlete Development (per month)', kind: 'training', amountPaise: rs(3000), status: 'approved', notes: 'Monthly.' },
  { group: '04 Specialised Programmes', code: 'programme.advanced-karate.month', label: 'Advanced Karate Development (per month)', kind: 'training', amountPaise: rs(3000), status: 'approved', notes: 'Monthly.' },
  { group: '04 Specialised Programmes', code: 'programme.dan-preparation', label: 'Dan Preparation', kind: 'course', amountPaise: rs(15000), status: 'proposed', notes: 'Course-based. Proposed.' },

  // ── 05 Kyu & Dan grading examination fees ─────────────────────────────────
  { group: '05 Kyu & Dan Grading', code: 'grading.kyu.yellow', label: 'Kyu grading – Yellow', kind: 'grading', amountPaise: rs(1000), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.kyu.orange', label: 'Kyu grading – Orange', kind: 'grading', amountPaise: rs(1100), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.kyu.green', label: 'Kyu grading – Green', kind: 'grading', amountPaise: rs(1200), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.kyu.blue-6', label: 'Kyu grading – Blue (6th Kyu)', kind: 'grading', amountPaise: rs(1300), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.kyu.blue-5', label: 'Kyu grading – Blue (5th Kyu)', kind: 'grading', amountPaise: rs(1400), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.kyu.brown-3', label: 'Kyu grading – Brown (3rd Kyu)', kind: 'grading', amountPaise: rs(1500), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.kyu.brown-2', label: 'Kyu grading – Brown (2nd Kyu)', kind: 'grading', amountPaise: rs(1600), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.kyu.brown-1', label: 'Kyu grading – Brown (1st Kyu)', kind: 'grading', amountPaise: rs(1700), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.dan.shodan', label: 'Dan grading – Shodan (1st Dan)', kind: 'grading', amountPaise: rs(7000), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.dan.nidan', label: 'Dan grading – Nidan (2nd Dan)', kind: 'grading', amountPaise: rs(10000), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.dan.sandan', label: 'Dan grading – Sandan (3rd Dan)', kind: 'grading', amountPaise: rs(15000), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.dan.yondan', label: 'Dan grading – Yondan (4th Dan)', kind: 'grading', amountPaise: rs(20000), status: 'approved', notes: 'Examination fee.' },
  { group: '05 Kyu & Dan Grading', code: 'grading.dan.godan', label: 'Dan grading – Godan (5th Dan)', kind: 'grading', amountPaise: rs(25000), status: 'approved', notes: 'Examination fee.' },

  // ── 06 Membership and admission ───────────────────────────────────────────
  { group: '06 Membership', code: 'admission.academy', label: 'Academy admission', kind: 'membership', amountPaise: rs(500), status: 'approved', notes: 'One-time admission.' },
  { group: '06 Membership', code: 'membership.individual.annual', label: 'Individual membership (annual)', kind: 'membership', amountPaise: rs(500), status: 'proposed', notes: 'Per year. Proposed.' },
  { group: '06 Membership', code: 'membership.athlete-registration.annual', label: 'Athlete registration (annual)', kind: 'membership', amountPaise: rs(1000), status: 'proposed', notes: 'Per year. Proposed.' },
  { group: '06 Membership', code: 'membership.instructor.annual', label: 'Instructor membership (annual)', kind: 'membership', amountPaise: rs(2000), status: 'proposed', notes: 'Per year. Proposed.' },
  { group: '06 Membership', code: 'membership.coach-affiliation.annual', label: 'Coach affiliation (annual)', kind: 'membership', amountPaise: rs(3000), status: 'proposed', notes: 'Per year. Proposed.' },
  { group: '06 Membership', code: 'membership.referee-registration.annual', label: 'Referee registration (annual)', kind: 'membership', amountPaise: rs(2500), status: 'proposed', notes: 'Per year. Proposed.' },

  // ── 07 Federation affiliation (all provisional) ───────────────────────────
  { group: '07 Affiliation', code: 'affiliation.club-dojo.annual', label: 'Affiliation – Karate Club / Dojo (annual)', kind: 'affiliation', amountPaise: rs(5000), status: 'proposed', notes: 'Proposed annual fee; provisional until reconciled with the existing MMAKF fee register.' },
  { group: '07 Affiliation', code: 'affiliation.school.annual', label: 'Affiliation – School (annual)', kind: 'affiliation', amountPaise: rs(5000), status: 'proposed', notes: 'Proposed annual fee; provisional until reconciled.' },
  { group: '07 Affiliation', code: 'affiliation.college-university.annual', label: 'Affiliation – College / University (annual)', kind: 'affiliation', amountPaise: rs(10000), status: 'proposed', notes: 'Proposed annual fee; provisional until reconciled.' },
  { group: '07 Affiliation', code: 'affiliation.corporate.annual', label: 'Affiliation – Corporate (annual)', kind: 'affiliation', amountPaise: rs(15000), status: 'proposed', notes: 'Proposed annual fee; provisional until reconciled.' },
  { group: '07 Affiliation', code: 'affiliation.district-association.annual', label: 'Affiliation – District Association (annual)', kind: 'affiliation', amountPaise: rs(15000), status: 'proposed', notes: 'Proposed annual fee; provisional until reconciled.' },
  { group: '07 Affiliation', code: 'affiliation.state-association.annual', label: 'Affiliation – State Association (annual)', kind: 'affiliation', amountPaise: rs(30000), status: 'proposed', notes: 'Proposed annual fee; provisional until reconciled.' },
  { group: '07 Affiliation', code: 'affiliation.regional-training-centre.annual', label: 'Affiliation – Regional Training Centre (annual)', kind: 'affiliation', amountPaise: rs(15000), status: 'proposed', notes: 'Proposed annual fee; provisional until reconciled.' },

  // ── 08 Tournaments, certification and other charges (all proposed) ───────
  { group: '08 Tournaments & Events', code: 'event.tournament.individual-entry', label: 'Individual tournament entry', kind: 'event_entry', amountPaise: rs(500), status: 'proposed', notes: 'Proposed.' },
  { group: '08 Tournaments & Events', code: 'event.tournament.team-entry', label: 'Team tournament entry', kind: 'event_entry', amountPaise: rs(1500), status: 'proposed', notes: 'Proposed.' },
  { group: '08 Tournaments & Events', code: 'event.kata', label: 'Kata event entry', kind: 'event_entry', amountPaise: rs(500), status: 'proposed', notes: 'Proposed.' },
  { group: '08 Tournaments & Events', code: 'event.kumite', label: 'Kumite event entry', kind: 'event_entry', amountPaise: rs(500), status: 'proposed', notes: 'Proposed.' },
  { group: '08 Tournaments & Events', code: 'seminar.coaching', label: 'Coaching seminar', kind: 'event_entry', amountPaise: rs(2500), status: 'proposed', notes: 'Proposed.' },
  { group: '08 Tournaments & Events', code: 'seminar.technical', label: 'Technical seminar', kind: 'event_entry', amountPaise: rs(1500), status: 'proposed', notes: 'Proposed.' },
  { group: '08 Tournaments & Events', code: 'seminar.referee', label: 'Referee seminar', kind: 'event_entry', amountPaise: rs(2500), status: 'proposed', notes: 'Proposed.' },
  { group: '08 Tournaments & Events', code: 'programme.instructor-development', label: 'Instructor development', kind: 'event_entry', amountPaise: rs(5000), status: 'proposed', notes: 'Proposed.' },
  { group: '08 Tournaments & Events', code: 'registration.black-belt', label: 'Black Belt registration', kind: 'other', amountPaise: rs(1500), status: 'proposed', notes: 'Proposed.' },

  // ── 09 Equipment, delivery and certificates ──────────────────────────────
  { group: '09 Equipment & Certificates', code: 'delivery.online-belt', label: 'Online belt delivery', kind: 'other', amountPaise: rs(150), status: 'approved', notes: 'Delivery charge for a belt ordered online. Collecting a physical belt carries no delivery charge.' },
  { group: '09 Equipment & Certificates', code: 'certificate.duplicate', label: 'Duplicate certificate', kind: 'certificate', amountPaise: rs(500), status: 'proposed', notes: 'Proposed.' },
  { group: '09 Equipment & Certificates', code: 'document.student-identity-card', label: 'Student identity card', kind: 'certificate', amountPaise: rs(200), status: 'proposed', notes: 'Proposed.' },
];

/**
 * Lines of the office's document that are NOT fees in this register, and why.
 * Shown on the admin page so nothing in the document looks forgotten.
 */
export const FEE_MASTER_EXCLUSIONS: Array<{ item: string; reason: string }> = [
  { item: 'Physical belt — ₹350', reason: 'A product. Post it in the shop catalogue (stock, sizes), not as a fee.' },
  { item: 'Student kit — ₹45,000 standalone', reason: 'A product. Post it in the shop catalogue. Course 02 already includes it.' },
  { item: 'Karate Gi — product-wise (normal from ₹2,500; WKF-approved higher)', reason: 'Products with sizes and variants. Post them in the shop catalogue.' },
  { item: 'Protective equipment, training materials — product-wise', reason: 'Products. Post them in the shop catalogue.' },
  // Worded without a zero-rupee figure: no surface prints one (tests/fee-catalogue.test.ts).
  { item: 'Physical belt collection — no delivery charge', reason: 'Not a charge, so it is not recorded as a price.' },
  { item: 'Certificates — category-wise', reason: 'No figure given. Duplicate certificate is listed separately.' },
  { item: 'National-level arrangement — special agreement', reason: 'No figure: agreed case by case, by quotation.' },
];
