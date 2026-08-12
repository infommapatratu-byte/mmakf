// Membership registration — the field model and its validation.

import { describe, it, expect } from 'vitest';
import {
  validateApplication, ageOn, fieldsFor, MEMBERSHIP_TYPES, MINOR_AGE,
  CORE_FIELDS, TYPE_FIELDS, CONSENTS,
} from '../src/lib/registration';

const STATES = ['Jharkhand', 'Bihar', 'West Bengal'];
const NOW = new Date('2026-08-12T00:00:00Z');

/** A complete adult athlete application, for tests to vary one field at a time. */
function adultAthlete(over: Record<string, unknown> = {}) {
  return {
    type: 'Athlete',
    name: 'Ravi Kumar',
    email: 'ravi@example.in',
    phone: '9876543210',
    state: 'Jharkhand',
    district: 'Ramgarh',
    dob: '2000-05-14',
    gender: 'Male',
    dojo: 'MMAKF Hombu Dojo',
    instructor: 'Sensei Vikas Pathak',
    emergencyName: 'Sita Kumar',
    emergencyPhone: '9876543211',
    consentAccuracy: true,
    consentDataUse: true,
    ...over,
  };
}

describe('age', () => {
  it('counts whole years, and handles a birthday that has not happened yet', () => {
    expect(ageOn('2000-01-01', NOW)).toBe(26);
    expect(ageOn('2000-08-12', NOW)).toBe(26);   // birthday today
    expect(ageOn('2000-08-13', NOW)).toBe(25);   // tomorrow
    expect(ageOn('2008-12-31', NOW)).toBe(17);
  });

  it('rejects malformed dates rather than guessing', () => {
    for (const bad of ['', 'yesterday', '14-05-2000', '2000-13-01', 'x']) {
      expect(ageOn(bad, NOW)).toBeNull();
    }
  });
});

describe('the four membership types ask different questions', () => {
  it('no longer shares one field set across all of them', () => {
    const names = (t: keyof typeof TYPE_FIELDS) => TYPE_FIELDS[t].map((f) => f.name);
    expect(names('Athlete')).not.toEqual(names('Instructor'));
    expect(names('Dojo / Club')).not.toEqual(names('Official'));

    expect(names('Athlete')).toContain('instructor');
    expect(names('Instructor')).toContain('teachesMinors');
    expect(names('Dojo / Club')).toContain('chiefInstructor');
    expect(names('Official')).toContain('officialKind');
  });

  it('collects the things the old six-field form never asked for', () => {
    const core = CORE_FIELDS.map((f) => f.name);
    expect(core).toContain('email');                      // could not reply before
    expect(TYPE_FIELDS.Athlete.map((f) => f.name)).toContain('dob');
    expect(TYPE_FIELDS.Athlete.map((f) => f.name)).toContain('emergencyName');
    expect(TYPE_FIELDS.Athlete.map((f) => f.name)).toContain('medicalNotes');
  });

  it('shows guardian fields only to minors', () => {
    const adult = fieldsFor('Athlete', false).map((f) => f.name);
    const minor = fieldsFor('Athlete', true).map((f) => f.name);
    expect(adult).not.toContain('guardianName');
    expect(minor).toContain('guardianName');
    expect(minor).toContain('guardianPhone');
  });

  it('leaves every consent unticked by default and makes photography optional', () => {
    expect(CONSENTS.every((c) => c.type === 'checkbox')).toBe(true);
    expect(CONSENTS.find((c) => c.name === 'consentPhotography')!.required).toBe(false);
    expect(CONSENTS.find((c) => c.name === 'consentAccuracy')!.required).toBe(true);
  });
});

describe('validation', () => {
  it('accepts a complete adult application', () => {
    const r = validateApplication(adultAthlete(), STATES, NOW);
    expect(r.ok).toBe(true);
    expect(r.isMinor).toBe(false);
    expect(r.age).toBe(26);
    expect(r.cleaned.email).toBe('ravi@example.in');
  });

  it('refuses an unknown membership type outright', () => {
    const r = validateApplication({ ...adultAthlete(), type: 'Grandmaster' }, STATES, NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.type).toBeTruthy();
  });

  it('requires an email address, and validates it', () => {
    expect(validateApplication(adultAthlete({ email: '' }), STATES, NOW).errors.email).toBeTruthy();
    expect(validateApplication(adultAthlete({ email: 'not-an-email' }), STATES, NOW).errors.email).toBeTruthy();
    expect(validateApplication(adultAthlete({ email: 'a@b' }), STATES, NOW).errors.email).toBeTruthy();
  });

  it('validates Indian mobile numbers and normalises them', () => {
    expect(validateApplication(adultAthlete({ phone: '12345' }), STATES, NOW).errors.phone).toBeTruthy();
    expect(validateApplication(adultAthlete({ phone: '1234567890' }), STATES, NOW).errors.phone).toBeTruthy();

    const r = validateApplication(adultAthlete({ phone: '+91 98765-43210' }), STATES, NOW);
    expect(r.ok).toBe(true);
    expect(r.cleaned.phone).toBe('+919876543210');
  });

  it('ATTACK: a state outside the federation list is refused', () => {
    // A free-text state made applications invisible to the verifying unit,
    // because the unit portal matches on exact equality.
    const r = validateApplication(adultAthlete({ state: 'Atlantis' }), STATES, NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.state).toMatch(/choose your state/i);
  });

  it('normalises a state to the federation spelling', () => {
    const r = validateApplication(adultAthlete({ state: 'jharkhand' }), STATES, NOW);
    expect(r.ok).toBe(true);
    expect(r.cleaned.state).toBe('Jharkhand');
  });

  it('REJECTS over-length input instead of silently truncating it', () => {
    const r = validateApplication(adultAthlete({ name: 'x'.repeat(200) }), STATES, NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.name).toMatch(/120 characters/);
    // The old endpoint stored a sliced value and reported success.
    expect(r.cleaned.name).toBeUndefined();
  });

  it('refuses a future or absurd date of birth', () => {
    expect(validateApplication(adultAthlete({ dob: '2030-01-01' }), STATES, NOW).errors.dob).toBeTruthy();
    expect(validateApplication(adultAthlete({ dob: '1850-01-01' }), STATES, NOW).errors.dob).toBeTruthy();
    expect(validateApplication(adultAthlete({ dob: 'not-a-date' }), STATES, NOW).errors.dob).toBeTruthy();
  });

  it('requires both mandatory consents', () => {
    expect(validateApplication(adultAthlete({ consentAccuracy: false }), STATES, NOW).errors.consentAccuracy).toBeTruthy();
    expect(validateApplication(adultAthlete({ consentDataUse: undefined }), STATES, NOW).errors.consentDataUse).toBeTruthy();
  });

  it('does not require the optional photography consent', () => {
    const r = validateApplication(adultAthlete(), STATES, NOW);
    expect(r.ok).toBe(true);
    expect(r.cleaned.consentPhotography).toBe(false);
  });

  it('reports every problem at once, so the form can be corrected in one pass', () => {
    const r = validateApplication({ type: 'Athlete' }, STATES, NOW);
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).length).toBeGreaterThan(5);
    expect(r.errors.name).toBeTruthy();
    expect(r.errors.email).toBeTruthy();
    expect(r.errors.dob).toBeTruthy();
  });
});

describe('child safeguarding', () => {
  const minor = (over: Record<string, unknown> = {}) =>
    adultAthlete({
      dob: '2014-03-02',     // 12 years old at NOW
      guardianName: 'Anita Devi',
      guardianRelation: 'Mother',
      guardianPhone: '9876543212',
      consentGuardian: true,
      consentMedical: true,
      ...over,
    });

  it('identifies a minor from the date of birth', () => {
    const r = validateApplication(minor(), STATES, NOW);
    expect(r.isMinor).toBe(true);
    expect(r.age).toBe(12);
    expect(r.cleaned.isMinor).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('REFUSES a minor application without guardian details', () => {
    const r = validateApplication(minor({ guardianName: '', guardianPhone: '' }), STATES, NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.guardianName).toBeTruthy();
    expect(r.errors.guardianPhone).toBeTruthy();
  });

  it('REFUSES a minor application without guardian consent', () => {
    expect(validateApplication(minor({ consentGuardian: false }), STATES, NOW).errors.consentGuardian).toBeTruthy();
    expect(validateApplication(minor({ consentMedical: false }), STATES, NOW).errors.consentMedical).toBeTruthy();
  });

  it('does not demand guardian consent from an adult', () => {
    const r = validateApplication(adultAthlete(), STATES, NOW);
    expect(r.ok).toBe(true);
    expect(r.errors.consentGuardian).toBeUndefined();
  });

  it('treats the day before the eighteenth birthday as a minor, and the day itself as an adult', () => {
    const dayBefore = '2008-08-13';   // turns 18 tomorrow
    const birthday = '2008-08-12';    // turns 18 today
    expect(validateApplication(minor({ dob: dayBefore }), STATES, NOW).isMinor).toBe(true);
    expect(ageOn(birthday, NOW)).toBe(MINOR_AGE);
    expect(validateApplication(adultAthlete({ dob: birthday }), STATES, NOW).isMinor).toBe(false);
  });

  it('always asks an instructor whether they teach children', () => {
    expect(TYPE_FIELDS.Instructor.map((f) => f.name)).toContain('teachesMinors');
    expect(TYPE_FIELDS.Instructor.map((f) => f.name)).toContain('backgroundCheck');
  });
});

describe('the other three types validate on their own terms', () => {
  it('an instructor must evidence a grade and give a background-check status option', () => {
    const base = {
      type: 'Instructor', name: 'Vikas Pathak', email: 'v@example.in', phone: '9876543210',
      state: 'Jharkhand', district: 'Ramgarh', dob: '1985-01-01',
      currentGrade: 'IV Dan', gradeAwardedOn: '2020-01-01', gradeAwardedBy: 'MMAKF',
      dojo: 'Hombu Dojo', emergencyName: 'X', emergencyPhone: '9876543211',
      consentAccuracy: true, consentDataUse: true,
    };
    expect(validateApplication(base, STATES, NOW).ok).toBe(true);
    expect(validateApplication({ ...base, currentGrade: '' }, STATES, NOW).errors.currentGrade).toBeTruthy();
    expect(validateApplication({ ...base, backgroundCheck: 'Maybe' }, STATES, NOW).errors.backgroundCheck).toBeTruthy();
  });

  it('a dojo application is about the dojo, not about a person', () => {
    const base = {
      type: 'Dojo / Club', name: 'Ramgarh Centre', email: 'd@example.in', phone: '9876543210',
      state: 'Jharkhand', district: 'Ramgarh',
      dojoName: 'MMAKF Ramgarh Centre', venue: 'Main Road, Ramgarh',
      chiefInstructor: 'Vikas Pathak', chiefInstructorGrade: 'IV Dan',
      studentCount: 40, trainingDays: 'Mon/Wed/Fri 17:00-19:00',
      consentAccuracy: true, consentDataUse: true,
    };
    const r = validateApplication(base, STATES, NOW);
    expect(r.ok).toBe(true);
    expect(r.cleaned.studentCount).toBe(40);
    expect(validateApplication({ ...base, studentCount: -5 }, STATES, NOW).errors.studentCount).toBeTruthy();
  });

  it('an official must state which role they are applying for', () => {
    const base = {
      type: 'Official', name: 'A Referee', email: 'r@example.in', phone: '9876543210',
      state: 'Bihar', district: 'Patna', dob: '1990-01-01',
      officialKind: 'Referee', currentGrade: 'III Dan', dojo: 'Patna Dojo',
      emergencyName: 'X', emergencyPhone: '9876543211',
      consentAccuracy: true, consentDataUse: true,
    };
    expect(validateApplication(base, STATES, NOW).ok).toBe(true);
    expect(validateApplication({ ...base, officialKind: 'Commentator' }, STATES, NOW).errors.officialKind).toBeTruthy();
  });

  it('every type is covered', () => {
    expect(MEMBERSHIP_TYPES.length).toBe(4);
    for (const t of MEMBERSHIP_TYPES) expect(TYPE_FIELDS[t].length).toBeGreaterThan(4);
  });
});
