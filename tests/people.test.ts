// Individual profiles.
//
// Two things are being protected here. First, that a slug computed by a card
// and a slug matched by the profile are the SAME slug — the classic way this
// feature ships broken is a link that 404s. Second, that the page cannot
// attribute one person's record to another: three of the six people on the
// platform are called Pathak.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { slugify, profileHref, initials } from '../src/lib/people';
import { SEED } from '../src/data/seed';

const page = readFileSync('src/pages/people/[slug].astro', 'utf8');

describe('slugs', () => {
  it('drops honorifics into the URL rather than out of it', () => {
    // The name is the record; the slug is derived from all of it. Stripping
    // "Shihan" here and not in the card is exactly how the link breaks.
    expect(slugify('Shihan Pramod Kumar Pathak')).toBe('shihan-pramod-kumar-pathak');
  });

  it('is stable across the punctuation real names carry', () => {
    expect(slugify('Sensei Sumitra Devi')).toBe('sensei-sumitra-devi');
    expect(slugify("Sensei O'Brien")).toBe('sensei-obrien');
    expect(slugify('  Daksh   Mohan  Mishra ')).toBe('daksh-mohan-mishra');
  });

  it('returns null for a name that cannot make a URL, rather than /people/', () => {
    // A link to /people/ would be a live link to a page that does not exist.
    expect(profileHref('')).toBeNull();
    expect(profileHref('—')).toBeNull();
    expect(profileHref('Shihan Pramod Kumar Pathak')).toBe('/people/shihan-pramod-kumar-pathak');
  });

  it('every seeded leadership name produces a resolvable slug', () => {
    for (const p of SEED.leadership) {
      const href = profileHref(p.name);
      expect(href, `${p.name} has no profile URL`).not.toBeNull();
      // Round-trip: the slug the card links to is the slug the page matches.
      const matched = SEED.leadership.filter((q: any) => slugify(q.name) === slugify(p.name));
      expect(matched.length, `${p.name} collides with another profile`).toBe(1);
    }
  });
});

describe('monogram initials', () => {
  it('skips the honorific so the tile reads as the person, not the title', () => {
    expect(initials('Shihan Pramod Kumar Pathak')).toBe('PK');
    expect(initials('Sensei Vikas Pathak')).toBe('VP');
    expect(initials('Siddharth Prasad')).toBe('SP');
  });

  it('survives an empty or single-word name', () => {
    expect(initials('')).toBe('');
    expect(initials('Sensei')).toBe('');
  });
});

describe('the page never invents what it does not hold', () => {
  it('renders a monogram and SAYS SO when no portrait is on record', () => {
    // The federation has no photograph of several of these people. A stock
    // photo of someone else would be a misattribution, so the page states the
    // absence instead.
    expect(page).toMatch(/No photograph of \{person\.name\} is held on the federation record/);
    expect(page).toMatch(/prof-mono-lg/);
  });

  it('omits image from the structured data rather than emitting a placeholder', () => {
    expect(page).toMatch(/if \(person\.img\) jsonLd\.image = person\.img;/);
  });

  it('renders honours only WITH the source they were recorded from', () => {
    expect(page).toMatch(/\{h\.note\} *<\/div>|h\.note &&/);
    expect(page).toMatch(/An honour the federation[\s\S]{0,80}source/);
  });

  it('holds grade and title apart instead of concatenating them', () => {
    expect(page).toMatch(/None of these is a grade/);
    // A single line reading "Soke Shihan Renshi VI Dan" is the failure mode.
    expect(page).not.toMatch(/\{person\.rank\}\s*\{titles/);
  });
});

describe('press attribution', () => {
  // Reimplementation of the page's rule, asserted against the real archive.
  const HONORIFICS = new Set(['shihan', 'sensei', 'senpai', 'soke', 'renshi', 'kyoshi', 'hanshi']);
  const DEVANAGARI: Record<string, string[]> = {
    'Shihan Pramod Kumar Pathak': ['प्रमोद'],
    'Sensei Vikas Pathak': ['विकास'],
  };
  const mentions = (text: string, name: string) => {
    const hay = (text || '').toLowerCase();
    const names = name.split(/\s+/).filter((w) => !HONORIFICS.has(w.toLowerCase())).map((w) => w.toLowerCase());
    if (names.length && names.every((n) => hay.includes(n))) return true;
    return (DEVANAGARI[name] || []).some((d) => text.includes(d));
  };
  const forPerson = (name: string) =>
    SEED.press.filter((c: any) => mentions(`${c.headline || ''} ${c.summary || ''}`, name));

  it('matches the Hindi headline that names Pramod in Devanagari', () => {
    const found = forPerson('Shihan Pramod Kumar Pathak');
    expect(found.some((c: any) => c.headline.includes('प्रमोद'))).toBe(true);
    // And the Johar Jharkhand award coverage, which names him in Latin script.
    expect(found.some((c: any) => c.outlet.startsWith('Johar Jharkhand'))).toBe(true);
  });

  it('does NOT hand Pramod the clipping that names only Vikas', () => {
    // Shared surname, shared dojo, same federation — and still not his coverage.
    const pramod = forPerson('Shihan Pramod Kumar Pathak');
    const vikasOnly = SEED.press.find((c: any) => (c.summary || '').includes('Sensei Vikas Pathak'));
    expect(vikasOnly).toBeTruthy();
    expect(pramod).not.toContain(vikasOnly);
  });

  it('gives Vikas the grading clipping that names him', () => {
    const found = forPerson('Sensei Vikas Pathak');
    expect(found.some((c: any) => (c.summary || '').includes('Sensei Vikas Pathak'))).toBe(true);
  });

  it('leaves the illegible-masthead clipping labelled as unconfirmed', () => {
    const c = SEED.press.find((x: any) => x.outlet.includes('not legible'));
    expect(c).toBeTruthy();
    // The archive says what it does not know rather than naming a plausible outlet.
    expect(c!.verified).toMatch(/unconfirmed/i);
    expect(c!.date).toBe('Undated');
  });
});

describe('the record it draws on is the one the federation holds', () => {
  const pramod: any = SEED.leadership.find((p: any) => p.name === 'Shihan Pramod Kumar Pathak');

  it('models titles separately from grade in the data, not just the view', () => {
    expect(pramod.rank).toBe('VI Dan Black Belt');
    expect(pramod.titles.map((t: any) => t.title)).toEqual(['Soke', 'Shihan', 'Renshi', 'Sensei']);
    // Every title carries what it means; a title with no gloss reads as inflation.
    expect(pramod.titles.every((t: any) => t.meaning && t.meaning.length > 5)).toBe(true);
  });

  it('cites a publication for every honour', () => {
    expect(pramod.honours.length).toBeGreaterThan(0);
    for (const h of pramod.honours) {
      expect(h.note, `${h.title} has no recorded source`).toBeTruthy();
      expect(h.year).toMatch(/^\d{4}$/);
    }
  });

  it('holds no portrait for him, and the seed does not pretend otherwise', () => {
    // If this ever fails it is because MMAKF supplied a photograph — which is
    // the outcome we want, and the page will render it.
    expect(pramod.img).toBe('');
  });
});
