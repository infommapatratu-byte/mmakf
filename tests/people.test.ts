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
import { HEADLINE_GLOSS, hasDevanagari, glossFor } from '../src/lib/press-gloss';
import { SEED } from '../src/data/seed';

const page = readFileSync('src/pages/people/[slug].astro', 'utf8');
const pressPage = readFileSync('src/pages/press.astro', 'utf8');

/**
 * The page with every comment stripped.
 *
 * A guard that matches a string living inside an explanatory comment proves
 * nothing, and this page's comments deliberately QUOTE the sentence that was
 * removed from it so the next reader knows why it may not come back. Matching
 * the raw source would pass forever on the comment alone.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const prose = stripComments(page);

/**
 * THE ABSENCE-APOLOGY CHECKER.
 *
 * The family of sentence this page is not allowed to publish: a public surface
 * telling a visitor what the federation's own records do not contain. Every
 * pattern below was published on this platform and removed — the first three
 * from this page, the rest from the news items and the results register.
 *
 * Run against the known-bad fixture first (the exact markup that was here), so
 * the checker is proven to fail before it is trusted to pass.
 */
const APOLOGY: RegExp[] = [
  /no photograph of/i,
  /is held on the federation record/i,
  /no portrait of/i,
  /has not supplied/i,
  /are not stated here/i,
  /not on the record/i,
  /cannot point to/i,
];
const apologiesIn = (src: string): string[] =>
  APOLOGY.filter((r) => r.test(stripComments(src))).map((r) => r.source);

const KNOWN_BAD = `
  <div class="prof-portrait">
    <div class="prof-mono-lg" role="img" aria-label={\`No portrait of \${person.name} is on record\`}>
      {initials(person.name)}
    </div>
    <p class="prof-nophoto">
      No photograph of {person.name} is held on the federation record.
    </p>
  </div>`;

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
  it('the apology checker catches the markup that was actually here', () => {
    // Proven to fail before it is trusted to pass: this is the exact block that
    // stood under the monogram tile, and both its sentences must be caught.
    const found = apologiesIn(KNOWN_BAD);
    expect(found).toContain('no photograph of');
    expect(found).toContain('no portrait of');
    expect(found).toContain('is held on the federation record');
  });

  it('renders the monogram tile and says NOTHING about the missing photograph', () => {
    // The rule that stands: no stock photograph of a stranger, ever. The rule
    // that changed: the absence is not announced to the visitor. A public page
    // apologising for the federation's own records reads as weakness to the
    // schools and parents it is meant to convince — the office register is
    // where a missing file is noted, not the profile.
    expect(page).toMatch(/prof-mono-lg/);
    expect(apologiesIn(page)).toEqual([]);
    // And the styling for that caption went with the caption.
    expect(page).not.toMatch(/prof-nophoto/);
    // The screen-reader label announced it too; the tile is decorative now and
    // the name it stands for is the <h1> beside it.
    expect(prose).not.toMatch(/aria-label=\{`No/);
  });

  it('omits image from the structured data rather than emitting a placeholder', () => {
    expect(page).toMatch(/if \(person\.img\) jsonLd\.image = person\.img;/);
  });

  it('renders honours only WITH the source they were recorded from', () => {
    // Filtered in the frontmatter — an honour with no source never reaches the
    // template — and the source is printed on the card that does render.
    expect(page).toMatch(/h && h\.title && h\.source/);
    expect(page).toMatch(/\{h\.source\}/);
    expect(prose).toMatch(/Each entry carries the publication it was recorded from/);
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

  it('cites a publication for every honour, in a field of its own', () => {
    expect(pramod.honours.length).toBeGreaterThan(0);
    for (const h of pramod.honours) {
      // `source` is separate from `note` so the page can DROP a sourceless
      // honour, rather than trusting a free-text sentence to contain a citation.
      expect(h.source, `${h.title} has no recorded source`).toBeTruthy();
      expect(h.year).toMatch(/^\d{4}$/);
    }
  });

  it('holds no portrait for him, and the seed does not pretend otherwise', () => {
    // If this ever fails it is because MMAKF supplied a photograph — which is
    // the outcome we want, and the page will render it.
    expect(pramod.img).toBe('');
  });
});

describe('his master is a named person who conferred a name — not a school', () => {
  const pramod: any = SEED.leadership.find((p: any) => p.name === 'Shihan Pramod Kumar Pathak');

  it('records the master as a person, with the name that person conferred', () => {
    expect(pramod.master).toBeTruthy();
    expect(typeof pramod.master).toBe('object');
    expect(pramod.master.name).toBe('Grandmaster S N T Lee');
    expect(pramod.master.conferred).toMatch(/Junior Tiger Lee/);
    expect(pramod.master.source, 'the master relationship has no recorded source').toBeTruthy();
    expect(pramod.addressedAs).toBe('Grandmaster Jr. Tiger Lee');
  });

  it('does NOT restate it as a lineage, a school or a style of Shotokan', () => {
    // A master conferring a title on his student, and a school that MMAKF
    // descends from, are two different claims. Only the first was stated. This
    // site published the second in nine places and withdrew it; the arrival of
    // a named teacher must not quietly bring it back.
    const record = JSON.stringify(pramod);
    expect(record).not.toMatch(/lineage/i);
    expect(record).not.toMatch(/descend/i);
    expect(record).not.toMatch(/Tiger Lee (school|style|system of|lineage)/i);
    // And the federation's own lineage field stays empty — the statement about
    // a teacher is not a statement about where the federation's karate comes from.
    expect(SEED.federation.lineage).toBe('');
  });

  it('records nothing about the master that the federation did not state', () => {
    // No grade, no nationality, no school, no dates, no chain of transmission.
    const keys = Object.keys(pramod.master).sort();
    expect(keys).toEqual(['conferred', 'conferredShort', 'name', 'relation', 'source']);
  });

  it('renders the master on the page, and never the word lineage', () => {
    expect(page).toMatch(/const master = person\.master && person\.master\.name/);
    expect(page).toMatch(/\{master\.name\}/);
    expect(prose).not.toMatch(/lineage/i);
  });
});

describe('a section with nothing to show does not render at all', () => {
  // Every section on this page is data-driven, and every one of them is gated
  // on the data existing. An empty heading is a promise the page cannot keep.
  const GUARDS = [
    'honours.length > 0 &&',
    'clippings.length > 0 &&',
    'titles.length > 0 &&',
    'authority.length > 0 &&',
    'postings.length > 0 &&',
    'ownChannels.length > 0 &&',
    'fedChannels.length > 0 &&',
    'teaches.length > 0 &&',
    'leads.length > 0 &&',
  ];

  it('gates every list-driven block on its list', () => {
    for (const g of GUARDS) {
      expect(page, `${g} is not guarded`).toContain(g);
    }
    expect(page).toMatch(/\{master && \(/);
  });

  it('leaves the timetable section out entirely for the one man who is not on it', () => {
    // He is named nowhere in the published timetable — his teaching is expressed
    // through Dan preparation and examination authority instead. The page must
    // render no heading and no empty table for him.
    const rows = SEED.schedule.filter((s: any) => s.ins === 'Shihan Pramod Kumar Pathak');
    expect(rows.length).toBe(0);
    expect(page).toMatch(/\{\(teaches\.length > 0 \|\| leads\.length > 0\) && \(/);
  });

  it('leaves the appointments and master sections out for people who have neither', () => {
    for (const p of SEED.leadership as any[]) {
      if (p.name === 'Shihan Pramod Kumar Pathak') continue;
      expect(p.master, `${p.name} has an unexpected master record`).toBeUndefined();
      expect(p.authority, `${p.name} has an unexpected authority record`).toBeUndefined();
      expect(p.honours, `${p.name} has an unexpected honours record`).toBeUndefined();
    }
  });
});

describe('the page describes the credential the person actually holds', () => {
  it('has somebody on the register whose rank is NOT a Dan grade', () => {
    // The guard below only means something because this person exists. If every
    // rank ever became a Dan grade, this fails and the guard can be retired.
    const nonDan = (SEED.leadership as any[]).filter((p) => !/\bdan\b/i.test(p.rank || ''));
    expect(nonDan.length).toBeGreaterThan(0);
    expect(nonDan.map((p) => p.rank)).toContain('WKF Registered');
  });

  it('explains a Dan grade ONLY where the rank is a Dan grade', () => {
    // "Examined rank" and "A Dan grade is awarded on examination" were printed
    // over whatever `rank` held — so a WKF registration was described as an
    // examined grade on a page whose entire argument is that a title and a
    // grade are different kinds of credential.
    expect(page).toMatch(/const isDan = \/\\bdan\\b\/i\.test\(person\.rank \|\| ''\)/);
    expect(page).toMatch(/\{isDan && \(/);
    expect(page).toMatch(/\{isDan \? 'Grade' : 'Standing'\}/);
    // The rank itself is always printed, examined or not.
    expect(page).toMatch(/\{person\.rank\}/);
  });
});

describe('data-driven copy names people instead of assuming their gender', () => {
  it('hard-codes no pronoun in a section that renders for anyone', () => {
    // The federation stated the master relationship about one man, and the
    // academy channel is his — but both sections are driven by fields any
    // person on the register may hold, and four of the six are not him.
    expect(prose).not.toMatch(/gave him/i);
    expect(prose).not.toMatch(/>His own</i);
    expect(prose).toMatch(/\}'s own<\/h3>/);
    expect(prose).toMatch(/The <em class="r">master<\/em>, and the name conferred\./);
  });
});

describe('whose channel is whose', () => {
  const pramod: any = SEED.leadership.find((p: any) => p.name === 'Shihan Pramod Kumar Pathak');

  it("claims his academy channel on his record, by the address held in `social`", () => {
    const url = 'https://www.youtube.com/@PramodPathakMartialArt';
    expect(pramod.ownChannels).toContain(url);
    // The join key resolves: the name, platform and note stay in `social`.
    const entry = SEED.social.find((a: any) => a.url === url);
    expect(entry, 'the claimed channel is not in the social store').toBeTruthy();
    expect(entry!.name).toMatch(/Pramod Pathak Martial Arts Academy/);
  });

  it('never shows a claimed channel as the federation\'s, on his page or anyone else\'s', () => {
    expect(page).toMatch(/!claimed\.has\(a\.url\)/);
    // The caption that denied his own channel was his is gone.
    expect(prose).not.toMatch(/not this person's personal accounts/);
  });

  it('hands no other person a channel they have not claimed', () => {
    for (const p of SEED.leadership as any[]) {
      if (p.name === 'Shihan Pramod Kumar Pathak') continue;
      expect(p.ownChannels).toBeUndefined();
    }
  });
});

describe('the Hindi headlines carry their gloss, from one table', () => {
  it('imports the gloss table rather than copying it', () => {
    expect(page).toMatch(/from '@\/lib\/press-gloss'/);
    expect(pressPage).toMatch(/from '@\/lib\/press-gloss'/);
    // Neither page declares its own copy of the map.
    expect(page).not.toMatch(/HEADLINE_GLOSS\s*:\s*Record/);
    expect(pressPage).not.toMatch(/HEADLINE_GLOSS\s*:\s*Record/);
  });

  it('glosses the printed Hindi headlines that name him, and marks them lang=hi', () => {
    expect(HEADLINE_GLOSS['जूनियर टाइगर ली']).toBe('Junior Tiger Lee');
    expect(HEADLINE_GLOSS['मार्शल आर्ट में प्रमोद ने बनाए हैं कई रिकॉर्ड'])
      .toMatch(/records in martial arts/);
    expect(hasDevanagari('जूनियर टाइगर ली')).toBe(true);
    expect(hasDevanagari('Bharat Gaurav Karate Khel Ratna award')).toBe(false);
    expect(page).toMatch(/lang=\{hasDevanagari\(c\.headline\) \? 'hi' : 'en'\}/);
  });

  it('shows a headline with no recorded gloss rather than guessing one', () => {
    expect(glossFor('Belt grading ceremony, Rasda')).toBeNull();
    expect(page).toMatch(/\{glossFor\(c\.headline\) && \(/);
  });
});
