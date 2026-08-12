// Membership registration — the field model and its validation.
//
// The previous form asked six questions (name, phone, type, state, district,
// grade) and used the SAME six for athletes, instructors, dojos and officials —
// four applications that share almost nothing. It collected no email, so the
// office could not reply; and no date of birth, so it could not determine an
// age category or even identify which applicants were children.
//
// That last point is the serious one. MMAKF teaches children (its own published
// programmes run from age 5), and a body handling minors' data must know who is
// a minor, must hold a guardian's consent, and must have an emergency contact.
//
// WHAT THIS FILE DOES NOT DO: it does not invent MMAKF's policy. It does not
// set fees, eligibility rules, mandatory documents or grading requirements.
// Those are the federation's to decide (§68). It defines which QUESTIONS are
// asked and how the answers are checked.

export type MembershipType = 'Athlete' | 'Instructor' | 'Dojo / Club' | 'Official';

export const MEMBERSHIP_TYPES: MembershipType[] = ['Athlete', 'Instructor', 'Dojo / Club', 'Official'];

/** Age below which a guardian's consent is required. */
export const MINOR_AGE = 18;

export interface FieldDef {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'date' | 'select' | 'textarea' | 'number' | 'checkbox';
  required: boolean;
  options?: string[];
  help?: string;
  maxLength?: number;
  /** Shown only when this predicate passes — e.g. guardian fields for minors. */
  showWhen?: 'minor';
}

/** Asked of every applicant, whatever they are applying for. */
export const CORE_FIELDS: FieldDef[] = [
  { name: 'name', label: 'Full name (as it should appear on the certificate)', type: 'text', required: true, maxLength: 120 },
  { name: 'email', label: 'Email address', type: 'email', required: true, maxLength: 254,
    help: 'Your application reference and all correspondence go here.' },
  { name: 'phone', label: 'Mobile number', type: 'tel', required: true, maxLength: 20 },
  { name: 'state', label: 'State', type: 'select', required: true },
  { name: 'district', label: 'District', type: 'text', required: true, maxLength: 60 },
  { name: 'city', label: 'City / town', type: 'text', required: false, maxLength: 60 },
];

/**
 * Fields per membership type.
 *
 * Note what is NOT here: no field asserts that a document is mandatory or that
 * a qualification is required. Where the federation has not published a rule,
 * the field is optional and labelled as "if held".
 */
export const TYPE_FIELDS: Record<MembershipType, FieldDef[]> = {
  Athlete: [
    { name: 'dob', label: 'Date of birth', type: 'date', required: true,
      help: 'Determines the age category for competition, and whether guardian consent is required.' },
    { name: 'gender', label: 'Gender (for competition category)', type: 'select', required: true,
      options: ['Female', 'Male', 'Prefer not to say'] },
    { name: 'dojo', label: 'Dojo / club where you train', type: 'text', required: true, maxLength: 120 },
    { name: 'instructor', label: 'Instructor name', type: 'text', required: true, maxLength: 120 },
    { name: 'currentGrade', label: 'Current grade, if held', type: 'text', required: false, maxLength: 60,
      help: 'For example 8th Kyu, or Shodan. Leave blank if you have not been graded.' },
    { name: 'gradeAwardedOn', label: 'Date that grade was awarded', type: 'date', required: false },
    { name: 'gradeAwardedBy', label: 'Organisation that awarded it', type: 'text', required: false, maxLength: 120,
      help: 'If your grade was awarded by another body, name it here so the office can review it.' },
    { name: 'trainingSince', label: 'Training since (year)', type: 'number', required: false },

    { name: 'guardianName', label: 'Parent or guardian name', type: 'text', required: true, maxLength: 120, showWhen: 'minor' },
    { name: 'guardianRelation', label: 'Relationship to applicant', type: 'text', required: true, maxLength: 40, showWhen: 'minor' },
    { name: 'guardianPhone', label: 'Parent or guardian mobile', type: 'tel', required: true, maxLength: 20, showWhen: 'minor' },
    { name: 'guardianEmail', label: 'Parent or guardian email', type: 'email', required: false, maxLength: 254, showWhen: 'minor' },

    { name: 'emergencyName', label: 'Emergency contact name', type: 'text', required: true, maxLength: 120 },
    { name: 'emergencyPhone', label: 'Emergency contact mobile', type: 'tel', required: true, maxLength: 20 },
    { name: 'medicalNotes', label: 'Medical conditions, allergies or injuries the instructor must know about', type: 'textarea', required: false, maxLength: 1000,
      help: 'Karate is a contact sport. Write "none" if there is nothing to declare.' },
    { name: 'bloodGroup', label: 'Blood group, if known', type: 'text', required: false, maxLength: 8 },
  ],

  Instructor: [
    { name: 'dob', label: 'Date of birth', type: 'date', required: true },
    { name: 'gender', label: 'Gender', type: 'select', required: false, options: ['Female', 'Male', 'Prefer not to say'] },
    { name: 'currentGrade', label: 'Current Dan grade', type: 'text', required: true, maxLength: 60 },
    { name: 'gradeAwardedOn', label: 'Date awarded', type: 'date', required: true },
    { name: 'gradeAwardedBy', label: 'Organisation that awarded it', type: 'text', required: true, maxLength: 120 },
    { name: 'certificateNo', label: 'Dan certificate number, if held', type: 'text', required: false, maxLength: 60 },
    { name: 'teachingSince', label: 'Teaching since (year)', type: 'number', required: false },
    { name: 'dojo', label: 'Dojo(s) where you teach', type: 'textarea', required: true, maxLength: 500 },
    { name: 'studentCount', label: 'Approximate number of students', type: 'number', required: false },
    { name: 'teachesMinors', label: 'I teach students under 18', type: 'checkbox', required: false },
    { name: 'backgroundCheck', label: 'Police verification / background check status', type: 'select', required: false,
      options: ['Completed', 'Applied for', 'Not yet obtained'],
      help: 'Recorded for the federation safeguarding register. The office will tell you what is required.' },
    { name: 'firstAid', label: 'First aid certification, if held', type: 'text', required: false, maxLength: 120 },
    { name: 'referee', label: 'Name of a senior instructor who can confirm your standing', type: 'text', required: false, maxLength: 120 },
    { name: 'emergencyName', label: 'Emergency contact name', type: 'text', required: true, maxLength: 120 },
    { name: 'emergencyPhone', label: 'Emergency contact mobile', type: 'tel', required: true, maxLength: 20 },
  ],

  'Dojo / Club': [
    { name: 'dojoName', label: 'Dojo / club name', type: 'text', required: true, maxLength: 160 },
    { name: 'establishedYear', label: 'Year established', type: 'number', required: false },
    { name: 'venue', label: 'Training venue — full address', type: 'textarea', required: true, maxLength: 500 },
    { name: 'chiefInstructor', label: 'Chief instructor name', type: 'text', required: true, maxLength: 120 },
    { name: 'chiefInstructorGrade', label: 'Chief instructor Dan grade', type: 'text', required: true, maxLength: 60 },
    { name: 'chiefInstructorMembership', label: 'Their MMAKF membership number, if already registered', type: 'text', required: false, maxLength: 40 },
    { name: 'studentCount', label: 'Number of students', type: 'number', required: true },
    { name: 'minorCount', label: 'Of those, how many are under 18', type: 'number', required: false },
    { name: 'trainingDays', label: 'Training days and times', type: 'textarea', required: true, maxLength: 400 },
    { name: 'matArea', label: 'Training area / mat size', type: 'text', required: false, maxLength: 80 },
    { name: 'firstAidOnSite', label: 'A first aid kit is kept on site', type: 'checkbox', required: false },
    { name: 'insurance', label: 'Insurance held, if any', type: 'text', required: false, maxLength: 160 },
    { name: 'existingAffiliation', label: 'Existing affiliation to any other body', type: 'text', required: false, maxLength: 160 },
  ],

  Official: [
    { name: 'dob', label: 'Date of birth', type: 'date', required: true },
    { name: 'officialKind', label: 'Role applied for', type: 'select', required: true,
      options: ['Referee', 'Judge', 'Technical delegate', 'Timekeeper / table official'] },
    { name: 'currentGrade', label: 'Current Dan grade', type: 'text', required: true, maxLength: 60 },
    { name: 'officiatingLevel', label: 'Officiating qualification currently held, if any', type: 'text', required: false, maxLength: 80 },
    { name: 'coursesAttended', label: 'Referee or judging courses attended', type: 'textarea', required: false, maxLength: 600 },
    { name: 'eventsOfficiated', label: 'Events officiated at', type: 'textarea', required: false, maxLength: 600 },
    { name: 'dojo', label: 'Dojo / club affiliation', type: 'text', required: true, maxLength: 120 },
    { name: 'emergencyName', label: 'Emergency contact name', type: 'text', required: true, maxLength: 120 },
    { name: 'emergencyPhone', label: 'Emergency contact mobile', type: 'tel', required: true, maxLength: 20 },
  ],
};

/** Consents. Every one is explicit and unticked by default. */
export const CONSENTS: FieldDef[] = [
  { name: 'consentAccuracy', label: 'I confirm the information given here is true and complete.', type: 'checkbox', required: true },
  { name: 'consentDataUse', label: 'I agree that MMAKF may store and use this information to administer my membership, gradings and competition entries.', type: 'checkbox', required: true },
  { name: 'consentGuardian', label: 'I am the parent or legal guardian of the applicant and I consent to this application and to MMAKF holding the information above.', type: 'checkbox', required: true, showWhen: 'minor' },
  { name: 'consentMedical', label: 'I consent to emergency first aid or medical treatment being arranged if it is needed and I cannot be reached.', type: 'checkbox', required: true, showWhen: 'minor' },
  { name: 'consentPhotography', label: 'I agree that photographs or video taken at MMAKF events may be used by the federation. (Optional — you may leave this unticked.)', type: 'checkbox', required: false },
];

// ─── Validation ─────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
  cleaned: Record<string, unknown>;
  isMinor: boolean;
  age: number | null;
}

/** Whole years between a date of birth and a reference date. */
export function ageOn(dob: string, on: Date = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;

  let age = on.getUTCFullYear() - d.getUTCFullYear();
  const monthDiff = on.getUTCMonth() - d.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && on.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Indian mobile numbers, with or without +91 and separators. */
const PHONE = /^(\+?91[\s-]?)?[6-9]\d{9}$/;

function normalisePhone(v: string): string {
  return v.replace(/[\s-]/g, '');
}

/**
 * Validate a submitted application.
 *
 * Deliberately does NOT truncate. The previous endpoint silently sliced an
 * over-length name to fit, storing a corrupted value and telling the applicant
 * nothing. Over-length input is now an error the applicant can see and correct.
 */
export function validateApplication(
  input: Record<string, unknown>,
  knownStates: string[] = [],
  now: Date = new Date()
): ValidationResult {
  const errors: Record<string, string> = {};
  const cleaned: Record<string, unknown> = {};

  const type = String(input.type ?? '').trim() as MembershipType;
  if (!MEMBERSHIP_TYPES.includes(type)) {
    return { ok: false, errors: { type: 'Choose what you are applying for.' }, cleaned: {}, isMinor: false, age: null };
  }
  cleaned.type = type;

  const dobRaw = String(input.dob ?? '').trim();
  const age = dobRaw ? ageOn(dobRaw, now) : null;
  const isMinor = age !== null && age < MINOR_AGE;

  const applicable = [...CORE_FIELDS, ...TYPE_FIELDS[type], ...CONSENTS].filter(
    (f) => !f.showWhen || (f.showWhen === 'minor' && isMinor)
  );

  for (const field of applicable) {
    const raw = input[field.name];

    if (field.type === 'checkbox') {
      const ticked = raw === true || raw === 'true' || raw === 'on';
      if (field.required && !ticked) {
        errors[field.name] = 'This confirmation is required.';
      }
      cleaned[field.name] = ticked;
      continue;
    }

    const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();

    if (!value) {
      if (field.required) errors[field.name] = 'This is required.';
      continue;
    }

    if (field.maxLength && value.length > field.maxLength) {
      errors[field.name] = `Please keep this to ${field.maxLength} characters or fewer.`;
      continue;
    }

    switch (field.type) {
      case 'email':
        if (!EMAIL.test(value)) { errors[field.name] = 'Enter a valid email address.'; continue; }
        cleaned[field.name] = value.toLowerCase();
        continue;

      case 'tel':
        if (!PHONE.test(normalisePhone(value))) {
          errors[field.name] = 'Enter a 10-digit Indian mobile number.';
          continue;
        }
        cleaned[field.name] = normalisePhone(value);
        continue;

      case 'date': {
        const parsed = new Date(`${value}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime())) {
          errors[field.name] = 'Enter a valid date.';
          continue;
        }
        if (parsed.getTime() > now.getTime()) {
          errors[field.name] = 'This date cannot be in the future.';
          continue;
        }
        if (field.name === 'dob') {
          const yrs = ageOn(value, now);
          // A sanity bound, not an eligibility rule: MMAKF sets any minimum age.
          if (yrs === null || yrs > 120) { errors[field.name] = 'Enter a valid date of birth.'; continue; }
        }
        cleaned[field.name] = value;
        continue;
      }

      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) { errors[field.name] = 'Enter a number.'; continue; }
        cleaned[field.name] = n;
        continue;
      }

      case 'select':
        if (field.name === 'state') {
          // A free-text state made applications invisible to the unit that had
          // to verify them, because the unit portal matches on exact equality.
          if (knownStates.length && !knownStates.some((s) => s.toLowerCase() === value.toLowerCase())) {
            errors.state = 'Choose your state from the list.';
            continue;
          }
          cleaned.state = knownStates.find((s) => s.toLowerCase() === value.toLowerCase()) ?? value;
          continue;
        }
        if (field.options && !field.options.includes(value)) {
          errors[field.name] = 'Choose one of the options.';
          continue;
        }
        cleaned[field.name] = value;
        continue;

      default:
        cleaned[field.name] = value;
    }
  }

  if (isMinor) cleaned.isMinor = true;
  if (age !== null) cleaned.age = age;

  return { ok: Object.keys(errors).length === 0, errors, cleaned, isMinor, age };
}

/** Fields for a type, with minor-only fields included when relevant. */
export function fieldsFor(type: MembershipType, isMinor: boolean): FieldDef[] {
  return [...CORE_FIELDS, ...TYPE_FIELDS[type], ...CONSENTS].filter(
    (f) => !f.showWhen || (f.showWhen === 'minor' && isMinor)
  );
}
