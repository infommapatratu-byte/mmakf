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

/**
 * Where a select's options come from when they do not exist until run time.
 *
 * NAMED RATHER THAN INLINED, because the form, the validator and the API must
 * offer and accept THE SAME list. The previous arrangement hard-coded
 * `f.name === 'state' ? states : f.options` in the page and re-derived the same
 * list again in the validator; two derivations of one list is one drift away
 * from a form that offers a value the server then refuses.
 *
 *  · `stateUnits`   — the federation's own register of CHARTERED STATE UNITS.
 *  · `geoCountries` /
 *    `geoStates`    /
 *    `geoDistricts` — civil geography from `admin_areas`. A different ladder
 *                     entirely; see the note on LOCATION_FIELDS below.
 *  · `localityCandidates` — the places a typed locality turned out to mean.
 *                     Non-empty ONLY when resolveArea() said 'ambiguous', which
 *                     is the moment the applicant has to be asked.
 */
export type OptionSource =
  | 'stateUnits'
  | 'geoCountries'
  | 'geoStates'
  | 'geoDistricts'
  | 'localityCandidates';

/** One option of a run-time list: a value to submit, and a name to show. */
export interface AreaChoice {
  value: string;
  label: string;
}

export interface FieldDef {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'date' | 'select' | 'textarea' | 'number' | 'checkbox' | 'postal';
  required: boolean;
  options?: string[];
  /** A list that only exists at run time. See OptionSource. */
  optionsFrom?: OptionSource;
  /**
   * Where the chosen option's DISPLAY NAME is filed alongside its value.
   *
   * An area id is the right thing to store and the wrong thing to read: an
   * approval queue that shows a reviewer "civilDistrictAreaId: 4471" has told
   * them nothing, and they cannot check it without another system. The name is
   * recorded beside the id so the record is legible on its own — and the id
   * remains the thing every later query joins on.
   */
  labelKey?: string;
  help?: string;
  maxLength?: number;
  /** Shown only when this predicate passes — e.g. guardian fields for minors. */
  showWhen?: 'minor';
}

/** Who the applicant is. Asked of everybody, whatever they are applying for. */
const APPLICANT_FIELDS: FieldDef[] = [
  { name: 'name', label: 'Full name (as it should appear on the certificate)', type: 'text', required: true, maxLength: 120 },
  { name: 'email', label: 'Email address', type: 'email', required: true, maxLength: 254,
    help: 'Your application reference and all correspondence go here.' },
  { name: 'phone', label: 'Mobile number', type: 'tel', required: true, maxLength: 20 },
];

/**
 * Where the applicant lives — the location step.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE ARE TWO "STATE" QUESTIONS, AND WHY THEY MUST NOT BE MERGED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `state` is the federation's own list of CHARTERED STATE UNITS. It decides
 * which office verifies the application, and the unit portal matches it on
 * exact equality.
 *
 * `civilStateAreaId` is a PLACE, out of `admin_areas`. src/db/geography.ts
 * explains at length why the two ladders are not joined: a person living in a
 * state MMAKF has not chartered still has an address, and one select serving
 * both would make that person unrepresentable. Two questions, because they are
 * genuinely two questions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ALMOST ALL OF THIS IS OPTIONAL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The civil geography tables SHIP EMPTY — no country, no area, no postal code
 * is seeded anywhere in this repository. A required country select, on the path
 * that actually runs today, is a question with no answer. So the register-backed
 * fields are offered only when the register can answer them (see isOffered()),
 * and the free-text `district`/`city` below carry the location until it can.
 *
 * `postalCode` and the address lines need no register at all, so they are asked
 * unconditionally. That alone is the defect being closed: the intake used to
 * collect one free-text city and nothing else, and a postal code is the single
 * strongest signal resolveArea() has for re-resolving an address later.
 */
export const LOCATION_FIELDS: FieldDef[] = [
  { name: 'state', label: 'State unit you are registering under', type: 'select', required: true,
    optionsFrom: 'stateUnits',
    help: 'The MMAKF unit that verifies this application. This is the federation’s register of its own units, not a list of places.' },
  { name: 'district', label: 'District', type: 'text', required: true, maxLength: 60 },
  { name: 'city', label: 'City, town or village', type: 'text', required: false, maxLength: 60,
    help: 'Written down exactly as you type it. If more than one place answers to that name you will be asked which you meant — nothing is guessed on your behalf.' },

  { name: 'country', label: 'Country', type: 'select', required: false,
    optionsFrom: 'geoCountries', labelKey: 'countryName' },
  { name: 'civilStateAreaId', label: 'State or region where you live', type: 'select', required: false,
    optionsFrom: 'geoStates', labelKey: 'civilState' },
  { name: 'civilDistrictAreaId', label: 'District where you live', type: 'select', required: false,
    optionsFrom: 'geoDistricts', labelKey: 'civilDistrict' },
  { name: 'cityAreaId', label: 'Which of these did you mean?', type: 'select', required: false,
    optionsFrom: 'localityCandidates', labelKey: 'cityArea',
    help: 'More than one place in the register answers to what you typed. Choosing wrongly files you in the wrong district, so the federation asks rather than picks.' },

  { name: 'postalCode', label: 'PIN / postal code', type: 'postal', required: false, maxLength: 12,
    help: 'Recorded as given. It is the strongest signal the federation has for placing an address once the place register is loaded.' },
  { name: 'addressLine1', label: 'Address — house or building, street', type: 'text', required: false, maxLength: 160 },
  { name: 'addressLine2', label: 'Address — area or locality', type: 'text', required: false, maxLength: 160 },
  { name: 'landmark', label: 'Landmark', type: 'text', required: false, maxLength: 120 },
];

/**
 * Asked of every applicant, whatever they are applying for.
 *
 * Composed rather than hand-listed so that the location step is ONE definition
 * with two render sites: this array feeds the validator and the office's queue
 * labels (src/components/QueuePanel.astro), while the form draws the location
 * fields as their own step out of LOCATION_FIELDS.
 */
export const CORE_FIELDS: FieldDef[] = [...APPLICANT_FIELDS, ...LOCATION_FIELDS];

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

// ─── Run-time option lists ──────────────────────────────────────────────────

/**
 * The civil geography the server is prepared to offer FOR ONE SUBMISSION.
 *
 * Narrowed as the applicant descends: `states` is the top rung of the chosen
 * country, `districts` is what sits under the chosen state, and
 * `localityCandidates` is non-empty only when a typed locality turned out to
 * mean more than one place.
 *
 * The page renders from this object and the validator checks against the SAME
 * object, so "the list that was offered" and "the list that is accepted" cannot
 * be two different things.
 */
export interface RegistrationGeography {
  /**
   * True when the place register holds at least one country.
   *
   * Distinguished from "not configured" by the caller, because they are
   * different absences: an empty register is a register nobody has loaded yet,
   * and a missing database is a deployment with no register at all.
   */
  loaded: boolean;
  countries: AreaChoice[];
  states: AreaChoice[];
  districts: AreaChoice[];
  localityCandidates: AreaChoice[];
}

export const EMPTY_GEOGRAPHY: RegistrationGeography = {
  loaded: false, countries: [], states: [], districts: [], localityCandidates: [],
};

/** The value that means "none of these — record the place as I typed it". */
export const UNRESOLVED_CHOICE = 'unresolved';

/**
 * The options a field offers right now.
 *
 * ONE function, called by the renderer and by the validator. A select is a
 * suggestion to a browser and nothing more; what makes a submitted value
 * acceptable is membership of the list THIS returned for THIS submission.
 */
export function optionsFor(
  field: FieldDef,
  knownStates: string[] = [],
  geo: RegistrationGeography | null = null
): AreaChoice[] {
  switch (field.optionsFrom) {
    case 'stateUnits': return knownStates.map((s) => ({ value: s, label: s }));
    case 'geoCountries': return geo?.countries ?? [];
    case 'geoStates': return geo?.states ?? [];
    case 'geoDistricts': return geo?.districts ?? [];
    case 'localityCandidates': return geo?.localityCandidates ?? [];
    default: return (field.options ?? []).map((o) => ({ value: o, label: o }));
  }
}

/**
 * Is this field asked at all?
 *
 * A register-backed select with nothing in it is NOT rendered and NOT
 * validated. That single rule covers both of the ways the list can be empty —
 * the place register has never been loaded, and the applicant has not yet
 * chosen the parent area — and it is what stops the form from showing an empty
 * dropdown that no answer can satisfy.
 */
export function isOffered(
  field: FieldDef,
  knownStates: string[] = [],
  geo: RegistrationGeography | null = null
): boolean {
  if (!field.optionsFrom) return true;
  if (field.optionsFrom === 'stateUnits') return true;
  return optionsFor(field, knownStates, geo).length > 0;
}

/**
 * A postal code as it is stored: uppercase, no spaces.
 *
 * THE SAME normalisation linkPostalCode() and resolveArea() apply in
 * src/db/geography.ts. A second, subtly different one here is a lookup that
 * silently never matches, and the symptom reads as missing reference data
 * rather than as a bug.
 */
export function normalisePostalCode(input: string): string {
  return String(input ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * A shape check, deliberately NOT a national format.
 *
 * India's PIN is six digits, but the register is built for a country column and
 * MMAKF has adopted no list of postal formats. Asserting `\d{6}` here would
 * refuse a correct code the day the first overseas member applies, and refusing
 * a real address is worse than storing one nobody has validated.
 */
const POSTAL = /^[A-Z0-9][A-Z0-9-]{1,11}$/;

// ─── Validation ─────────────────────────────────────────────────────────────

/** What the server is prepared to accept for one submission. */
export interface KnownOptions {
  geo?: RegistrationGeography | null;
}

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
  now: Date = new Date(),
  known: KnownOptions = {}
): ValidationResult {
  const errors: Record<string, string> = {};
  const cleaned: Record<string, unknown> = {};
  // Defaults to "no place register", which is the state this deployment is
  // actually in: nothing seeds countries or admin_areas anywhere in this
  // repository. A caller that has loaded the map passes it; every caller that
  // has not gets the free-text location step and no empty selects.
  const geo = known.geo ?? EMPTY_GEOGRAPHY;

  const type = String(input.type ?? '').trim() as MembershipType;
  if (!MEMBERSHIP_TYPES.includes(type)) {
    return { ok: false, errors: { type: 'Choose what you are applying for.' }, cleaned: {}, isMinor: false, age: null };
  }
  cleaned.type = type;

  const dobRaw = String(input.dob ?? '').trim();
  const age = dobRaw ? ageOn(dobRaw, now) : null;
  const isMinor = age !== null && age < MINOR_AGE;

  const applicable = [...CORE_FIELDS, ...TYPE_FIELDS[type], ...CONSENTS].filter(
    (f) => (!f.showWhen || (f.showWhen === 'minor' && isMinor)) && isOffered(f, knownStates, geo)
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

      case 'postal': {
        const code = normalisePostalCode(value);
        if (!POSTAL.test(code)) {
          errors[field.name] = 'Enter a postal code using letters, digits and hyphens only.';
          continue;
        }
        cleaned[field.name] = code;
        continue;
      }

      case 'select':
        if (field.optionsFrom === 'stateUnits') {
          // A free-text state made applications invisible to the unit that had
          // to verify them, because the unit portal matches on exact equality.
          if (knownStates.length && !knownStates.some((s) => s.toLowerCase() === value.toLowerCase())) {
            errors[field.name] = 'Choose your state from the list.';
            continue;
          }
          cleaned[field.name] = knownStates.find((s) => s.toLowerCase() === value.toLowerCase()) ?? value;
          continue;
        }
        if (field.optionsFrom) {
          // NEVER trust an id that arrived in the body. `civilDistrictAreaId`
          // is an admin_areas primary key, and a submitted one is accepted only
          // because it is in the list this server built for this submission —
          // not because a select once rendered it. The alternative files a
          // member under any area in the national register the sender names.
          const hit = optionsFor(field, knownStates, geo).find((o) => o.value === value);
          if (!hit) {
            errors[field.name] = 'Choose one of the options offered. That value is not one of them.';
            continue;
          }
          cleaned[field.name] = hit.value;
          if (field.labelKey) cleaned[field.labelKey] = hit.label;
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

/**
 * Fields for a type, with minor-only fields included when relevant.
 *
 * `knownStates` and `geo` default to "nothing offered", which drops every
 * register-backed select — the same filter validateApplication() applies, so a
 * progress indicator counting these fields can never count a question the
 * server would not have asked.
 */
export function fieldsFor(
  type: MembershipType,
  isMinor: boolean,
  knownStates: string[] = [],
  geo: RegistrationGeography | null = null
): FieldDef[] {
  return [...CORE_FIELDS, ...TYPE_FIELDS[type], ...CONSENTS].filter(
    (f) => (!f.showWhen || (f.showWhen === 'minor' && isMinor)) && isOffered(f, knownStates, geo)
  );
}
