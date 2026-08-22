// WCAG 2.2 AA guards (audit Q-28 — see docs/ACCESSIBILITY.md).
//
// WHAT THESE PARSE, AND WHY IT IS THE SOURCE AND NOT THE RENDERED HTML
// ────────────────────────────────────────────────────────────────────
// The audit itself was done against RENDERED HTML: forty surfaces were fetched
// from `astro dev` with an admin session and a configured database, and the
// markup that came back was read. These guards deliberately do NOT repeat that.
// Rendering every route inside vitest needs a running dev server and a live
// session — a slow, flaky dependency for a regression guard — and worse, it can
// only see the branches that happened to render. A defect in the
// `state === 'denied'` arm of a component would pass a rendered-HTML scan
// forever.
//
// So these read the SOURCE — `src/**/*.astro` and `src/styles/*.css` — which is
// where every defect the audit found actually lived, and which covers every
// branch whether or not this environment can reach it.
//
// The cost is stated plainly: a regex over Astro templates is not a parser. It
// cannot resolve `alt={maybeUndefined}`, and it cannot see markup a client
// script builds with innerHTML. Both limits are listed under "not covered" in
// docs/ACCESSIBILITY.md.
//
// Each checker below is a pure function, and each is FIRST run against a
// known-bad fixture — the exact shape of the defect found in this repository —
// so the guard is proven to fail before it is trusted to pass. A checker that
// has never failed proves nothing (docs/TESTING-STRATEGY.md §1).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// ── file collection ─────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.astro')) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

const TEMPLATES = [
  ...walk('src/pages'),
  ...walk('src/components'),
  ...walk('src/layouts'),
].sort();

const read = (p: string) => readFileSync(p, 'utf8');

/** Everything outside <script> and <style> — the markup a browser turns into an
 *  accessibility tree. Astro style blocks contain `>` and quotes that would
 *  otherwise be read as attributes. */
function markupOf(src: string): string {
  return src
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

// ── colour maths ────────────────────────────────────────────────────────────

function channels(hex: string): number[] {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two opaque colours. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The `--name: #rrggbb` declarations of a stylesheet. */
function tokensOf(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{3,8})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** A stylesheet with its block comments removed.
 *
 *  REVIEW FIX: without this, a guard that looks for a declaration can be
 *  satisfied by the comment that explains the declaration. Proved by
 *  mutation: deleting `visibility: hidden` from the collapsed .nav-links
 *  left the 2.4.7 guard below green, because the comment above that
 *  declaration quotes the same words. A guard its own documentation can
 *  satisfy is not a guard.
 */
export function cssCode(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const GLOBAL_CSS = read('src/styles/global.css');
const TOKENS = tokensOf(GLOBAL_CSS);

describe('the contrast maths itself', () => {
  it('reproduces the two ratios WCAG states outright', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#8E1212', '#8E1212')).toBeCloseTo(1, 5);
  });

  it('still fails the colours this audit found failing', () => {
    // The two tokens that were changed, at their ORIGINAL values. If these ever
    // stop failing, the maths has drifted and every ratio below is worthless.
    expect(contrastRatio('#857E71', '#FFFFFF')).toBeLessThan(4.5); // old --muted
    expect(contrastRatio('#A07C1E', '#FFFFFF')).toBeLessThan(4.5); // old --gold
  });
});

// ── 1.4.3 Contrast (Minimum) ────────────────────────────────────────────────

// Every light surface a page paints text on. --card-2 is the darkest of them
// and is what table headers and skeleton rows sit on, so it is the binding
// constraint, not --card.
const SURFACES = ['card', 'bg', 'bg-2', 'card-2'];

// Tokens that carry TEXT somewhere in this codebase. Verified by reading the
// rules that reference them, not assumed: --muted is table headers, field
// labels, placeholders and empty-state copy; --gold / --gold-2 are eyebrows,
// section kickers and link accents; --off-white is body copy.
const TEXT_TOKENS = ['white', 'off-white', 'muted', 'gold', 'gold-2', 'gold-3', 'red-2', 'numeral'];

describe('WCAG 1.4.3 — text contrast, computed from the tokens in global.css', () => {
  for (const token of TEXT_TOKENS) {
    it(`--${token} reaches 4.5:1 on every light surface it is painted on`, () => {
      const fg = TOKENS[token];
      expect(fg, `--${token} is not declared in global.css`).toBeTruthy();
      for (const surface of SURFACES) {
        const bg = TOKENS[surface];
        expect(bg, `--${surface} is not declared in global.css`).toBeTruthy();
        const ratio = contrastRatio(fg, bg);
        expect(
          Number(ratio.toFixed(2)),
          `--${token} (${fg}) on --${surface} (${bg}) is ${ratio.toFixed(2)}:1, needs 4.5:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('--muted-2 is never promoted to a text colour (it is 1.87:1 on white)', () => {
    expect(contrastRatio(TOKENS['muted-2'], TOKENS['card'])).toBeLessThan(3);
    const textUses = TEMPLATES.filter((f) => /color:\s*var\(--muted-2\)/.test(read(f)));
    expect(textUses, 'a template is using --muted-2 as a text colour').toEqual([]);
  });

  it('--red-3 is never promoted to a text colour (it is 1.49:1 on white)', () => {
    // Measured in Chrome on five surfaces before the fix. It is the hairline
    // for error borders and pills; the ordinals it used to paint use --numeral.
    expect(contrastRatio(TOKENS['red-3'], TOKENS['card'])).toBeLessThan(3);
    const textUses = TEMPLATES.filter((f) =>
      /(^|[^-])color:\s*var\(--red-3\)/m.test(read(f)),
    );
    expect(textUses, 'a template is using --red-3 as a text colour').toEqual([]);
  });

  it('the dark footer band keeps its own light values, not the ink tokens', () => {
    // The ink tokens are ~2:1 on #14120F. That was a P0; the guard stays.
    for (const c of ['#D8D2C6', '#D9BC66', '#A9A296']) {
      expect(contrastRatio(c, '#14120F')).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// ── 1.4.11 Non-text Contrast ────────────────────────────────────────────────

describe('WCAG 1.4.11 — the boundary that identifies a control', () => {
  it('--control-border reaches 3:1 on every surface a field sits on', () => {
    const fg = TOKENS['control-border'];
    expect(fg, '--control-border is not declared in global.css').toBeTruthy();
    for (const surface of SURFACES) {
      const ratio = contrastRatio(fg, TOKENS[surface]);
      expect(
        Number(ratio.toFixed(2)),
        `--control-border on --${surface} is ${ratio.toFixed(2)}:1, needs 3:1`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('.input draws its border with --control-border, not the decorative --border-2', () => {
    // --border-2 is 1.54:1 on white. A text field has no other visible edge, so
    // its border IS the information that identifies the control.
    expect(GLOBAL_CSS).toMatch(/\.input \{[\s\S]{0,200}border: 1px solid var\(--control-border\)/);
  });
});

// ── 2.4.7 Focus Visible ─────────────────────────────────────────────────────

/** True when a stylesheet suppresses the outline and declares no replacement. */
export function outlineSuppressedWithoutReplacement(css: string): boolean {
  const suppresses = /outline:\s*(none|0)\b/.test(css);
  if (!suppresses) return false;
  const replaces =
    /:focus-visible[^{]*\{[^}]*outline:\s*\d/.test(css) ||
    /:focus[^{]*\{[^}]*box-shadow:/.test(css);
  return !replaces;
}

describe('WCAG 2.4.7 — focus is never removed without a replacement', () => {
  it('the checker catches a bare outline reset', () => {
    expect(outlineSuppressedWithoutReplacement('.x:focus { outline: none; }')).toBe(true);
    expect(
      outlineSuppressedWithoutReplacement(
        '.x:focus { outline: none; } .x:focus-visible { outline: 2px solid #000; }',
      ),
    ).toBe(false);
  });

  it('no stylesheet or template suppresses focus without one', () => {
    const files = ['src/styles/global.css', 'src/styles/a11y.css', ...TEMPLATES];
    const offenders = files.filter((f) => outlineSuppressedWithoutReplacement(read(f)));
    expect(offenders).toEqual([]);
  });

  it('global.css still declares the site-wide focus ring', () => {
    expect(GLOBAL_CSS).toMatch(/:focus-visible \{[\s\S]{0,120}outline: 2px solid/);
  });

  it('a keyboard-focused input gets a real ring, not only a border tint', () => {
    expect(GLOBAL_CSS).toMatch(/\.input:focus-visible \{[\s\S]{0,120}outline: 2px solid/);
  });
});

// ── 1.1.1 Non-text Content ──────────────────────────────────────────────────

export function imagesWithoutAlt(markup: string): string[] {
  return [...markup.matchAll(/<img\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => !/\salt\s*=/i.test(tag));
}

describe('WCAG 1.1.1 — every image declares its alternative', () => {
  it('the checker catches an img with no alt', () => {
    expect(imagesWithoutAlt('<img src="/a.jpg" />')).toHaveLength(1);
    expect(imagesWithoutAlt('<img src="/a.jpg" alt="" />')).toHaveLength(0);
  });

  it('no template renders an img without alt', () => {
    const offenders: string[] = [];
    for (const f of TEMPLATES) {
      for (const tag of imagesWithoutAlt(markupOf(read(f)))) offenders.push(`${f}: ${tag}`);
    }
    expect(offenders).toEqual([]);
  });
});

export function svgsWithoutRole(markup: string): string[] {
  return [...markup.matchAll(/<svg\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => !/aria-hidden|aria-label|aria-labelledby|role=/i.test(tag));
}

describe('WCAG 1.1.1 — an inline SVG is either hidden or named', () => {
  it('the checker catches an unmarked svg', () => {
    expect(svgsWithoutRole('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>')).toHaveLength(1);
    expect(svgsWithoutRole('<svg aria-hidden="true"><path d="M0 0"/></svg>')).toHaveLength(0);
  });

  it('no template renders an SVG that is neither aria-hidden nor named', () => {
    const offenders: string[] = [];
    for (const f of TEMPLATES) {
      for (const tag of svgsWithoutRole(markupOf(read(f)))) {
        offenders.push(`${f}: ${tag.slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── 1.3.1 / 4.1.2 labels ────────────────────────────────────────────────────

/**
 * A <label> is only a label if it points at a control (`for`) or contains one.
 * This catches the exact defect found on /admin: 129 controls whose label was a
 * floating `<label class="input-label">Name</label>`.
 */
export function labelsNotAssociated(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const hasFor = /\bfor\s*=/i.test(m[1]);
    const wraps = /<(input|select|textarea)\b/i.test(m[2]);
    if (!hasFor && !wraps) out.push(m[0].replace(/\s+/g, ' ').slice(0, 110));
  }
  return out;
}

describe('WCAG 1.3.1 / 4.1.2 — a label is attached to its control', () => {
  it('the checker catches the floating label found on /admin', () => {
    const bad = '<label class="input-label">Full name</label><input class="input" name="name" />';
    expect(labelsNotAssociated(bad)).toHaveLength(1);
    expect(labelsNotAssociated('<label for="a">Full name</label>')).toHaveLength(0);
    expect(labelsNotAssociated('<label>Full name<input name="name" /></label>')).toHaveLength(0);
  });

  it('no template renders a label that points at nothing', () => {
    const offenders: string[] = [];
    for (const f of TEMPLATES) {
      for (const tag of labelsNotAssociated(markupOf(read(f)))) offenders.push(`${f}: ${tag}`);
    }
    expect(offenders).toEqual([]);
  });
});

// ── 4.1.2 accessible name ───────────────────────────────────────────────────

export function buttonsWithoutName(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const text = m[2]
      .replace(/<[^>]+>/g, '')          // nested elements contribute nothing here
      .replace(/&[a-z#0-9]+;/gi, 'x')   // an entity is visible text
      .replace(/\{[^}]*\}/g, 'x')       // an Astro expression renders something
      .trim();
    if (!text && !/aria-label|aria-labelledby|title\s*=/i.test(m[1])) {
      out.push(m[0].replace(/\s+/g, ' ').slice(0, 110));
    }
  }
  return out;
}

describe('WCAG 4.1.2 — every button has an accessible name', () => {
  it('the checker catches an icon-only button', () => {
    expect(buttonsWithoutName('<button class="x"><svg/></button>')).toHaveLength(1);
    expect(buttonsWithoutName('<button aria-label="Close"><svg/></button>')).toHaveLength(0);
    expect(buttonsWithoutName('<button>Add</button>')).toHaveLength(0);
  });

  it('no template renders a nameless button', () => {
    const offenders: string[] = [];
    for (const f of TEMPLATES) {
      for (const tag of buttonsWithoutName(markupOf(read(f)))) offenders.push(`${f}: ${tag}`);
    }
    expect(offenders).toEqual([]);
  });
});

// ── 1.3.1 tables ────────────────────────────────────────────────────────────

export function tableHeaderProblems(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const table = m[0];
    const open = (table.match(/<table\b[^>]*>/i) || [''])[0];
    const ths = [...table.matchAll(/<th(?=[\s>])([^>]*)>/gi)];

    // A table whose widest row holds one cell has no column structure to name.
    // /my/passport draws two of these — a captioned single-column list of
    // certificates. They would read better as a <ul>, but they are not a 1.3.1
    // failure, and a guard that cried wolf here would be switched off.
    const widest = Math.max(
      0,
      ...[...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map(
        (r) => (r[0].match(/<t[dh](?=[\s>])/gi) || []).length,
      ),
    );
    if (widest <= 1) continue;

    if (ths.length === 0) {
      out.push(`no <th> at all: ${open.slice(0, 80)}`);
      continue;
    }
    const unscoped = ths.filter((t) => !/\bscope\s*=/i.test(t[1]));
    if (unscoped.length) {
      out.push(`${unscoped.length}/${ths.length} <th> without scope: ${open.slice(0, 80)}`);
    }
  }
  return out;
}

describe('WCAG 1.3.1 — a data table names its columns', () => {
  it('the checker catches both shapes found in this repo', () => {
    // academy.astro had no header row at all; eleven other files had <th> with
    // no scope attribute.
    expect(
      tableHeaderProblems('<table><tbody><tr><td>1</td><td>Kata</td></tr></tbody></table>'),
    ).toHaveLength(1);
    expect(
      tableHeaderProblems('<table><thead><tr><th>Day</th><th>Time</th></tr></thead></table>'),
    ).toHaveLength(1);
    expect(
      tableHeaderProblems(
        '<table><thead><tr><th scope="col">Day</th><th scope="col">Time</th></tr></thead></table>',
      ),
    ).toHaveLength(0);
  });

  it('the checker does not cry wolf over a single-column list', () => {
    expect(
      tableHeaderProblems('<table><caption>Certificates</caption><tbody><tr><td>None</td></tr></tbody></table>'),
    ).toHaveLength(0);
  });

  it('every table in every template has scoped headers', () => {
    const offenders: string[] = [];
    for (const f of TEMPLATES) {
      for (const p of tableHeaderProblems(markupOf(read(f)))) offenders.push(`${f}: ${p}`);
    }
    expect(offenders).toEqual([]);
  });

  // A table wider than a 320px viewport must not push the PAGE sideways; the
  // scroll belongs to the table.
  //
  // THE MEDIA-QUERY FALSE POSITIVE. This used to scan the raw file for any
  // `min-width: NNNpx` and call the table wide. `@media (min-width: 900px)` is
  // a GRID BREAKPOINT and says nothing whatever about how wide a table is, so
  // four admin pages whose tables are every one of them `width: 100%` were
  // reported as offenders — and the only available "fix" would have been to
  // wrap a table that already fits in a scroller it does not need. A check that
  // correct code cannot satisfy teaches people to silence it.
  //
  // So the media CONDITION is stripped before the search, while the rules
  // INSIDE the block are kept: a table given `min-width: 700px` at a breakpoint
  // is still a wide table and still has to scroll.
  //
  // And the pattern is WIDER than it was, not narrower — a plain `width: 900px`
  // on a table overflows a phone exactly as a min-width does, and went
  // unchecked before.
  // `(?:^|[^-\w])` is load-bearing: without it the pattern matches the TAIL of
  // `max-width:` and `border-left-width:`. A max-width is a constraint — the
  // exact opposite of a wide table — and matching it flagged two pages that
  // hold no raw table at all.
  const WIDE_PX = /(?:^|[^-\w])(?:min-)?width:\s*(3[2-9]\d|[4-9]\d\d|\d{4,})px/;
  const withoutMediaConditions = (src: string) => src.replace(/@media[^{]*\{/g, '{');

  /**
   * A RAW html table, case-sensitively.
   *
   * The old check was case-insensitive, so `<Table …>` — the shared DataTable
   * component — read as a table this page had written itself. It has not: the
   * component supplies its own `.tbl-scroll` wrapper (proved by the test
   * below), and asking every page that uses it to add a second scroller is
   * asking for a defect. Astro components are capitalised; raw elements are
   * not, and that distinction is exactly the one being drawn here.
   */
  const RAW_TABLE = /<table\b/;

  it('the shared DataTable supplies its own scroll container', () => {
    // The premise the exemption above rests on. If this ever stops being true,
    // every page that delegates to <Table> loses its horizontal scroll at once
    // and the check below would not notice — so it is asserted here rather
    // than assumed in a comment.
    const table = read('src/components/DataTable/Table.astro');
    expect(table).toMatch(/tbl-scroll/);
    expect(RAW_TABLE.test(table)).toBe(true);
  });

  it('every wide table sits inside a horizontal-scroll container (1.4.10)', () => {
    const offenders: string[] = [];
    for (const f of TEMPLATES) {
      const src = read(f);
      if (!RAW_TABLE.test(markupOf(src))) continue;
      const wide = WIDE_PX.test(withoutMediaConditions(src));
      if (wide && !/tbl-scroll|overflow-x:\s*auto/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('the wide-table check is not fooled by a breakpoint, a max-width, or <Table>', () => {
    // The three regressions that produced the rewrite above, pinned directly so
    // the loose heuristic cannot come back.

    // 1. A grid breakpoint says nothing about how wide a table is.
    expect(WIDE_PX.test(withoutMediaConditions(
      'table { width: 100%; } @media (min-width: 900px) { .grid { grid-template-columns: repeat(3, 1fr); } }'
    ))).toBe(false);

    // 2. A max-width is a constraint, not a width.
    expect(WIDE_PX.test(withoutMediaConditions('.form { max-width: 900px; }'))).toBe(false);
    expect(WIDE_PX.test(withoutMediaConditions('.card { border-left-width: 3px; }'))).toBe(false);

    // 3. The shared component is not a raw table.
    expect(RAW_TABLE.test('<Table columns={cols} rows={rows} />')).toBe(false);
    expect(RAW_TABLE.test('<table><tr><th scope="col">A</th></tr></table>')).toBe(true);

    // And a table that really is wide is still caught — inside a breakpoint …
    expect(WIDE_PX.test(withoutMediaConditions(
      '@media (min-width: 900px) { table { min-width: 720px; } }'
    ))).toBe(true);
    // … and as a plain width, which the old pattern missed entirely.
    expect(WIDE_PX.test(withoutMediaConditions('table { width: 960px; }'))).toBe(true);
  });
});

// ── 2.4.1 Bypass Blocks ─────────────────────────────────────────────────────

const BASE = read('src/layouts/Base.astro');
const A11Y_CSS = read('src/styles/a11y.css');

describe('WCAG 2.4.1 — the repeated nav can be skipped', () => {
  it('Base.astro renders a skip link as the first thing in the tab order', () => {
    const body = BASE.slice(BASE.indexOf('<body>'));
    const skip = body.indexOf('class="skip-link"');
    const nav = body.indexOf('<nav');
    expect(skip, 'no skip link in Base.astro').toBeGreaterThan(-1);
    expect(skip, 'the skip link must precede the nav').toBeLessThan(nav);
  });

  it('the skip link targets an element that exists', () => {
    const target = (BASE.match(/class="skip-link" href="#([^"]+)"/) || [])[1];
    expect(target).toBeTruthy();
    expect(BASE).toContain(`id="${target}"`);
  });

  it('the skip link is focusable when unfocused — not display:none', () => {
    const rule = (A11Y_CSS.match(/\.skip-link \{[^}]*\}/) || [''])[0];
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
    expect(A11Y_CSS).toMatch(/\.skip-link:focus \{[^}]*transform:\s*translateY\(0\)/);
  });

  it('.sr-only hides visually without leaving the accessibility tree', () => {
    const rule = (A11Y_CSS.match(/\.sr-only \{[^}]*\}/) || [''])[0];
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
  });

  it('a11y.css is loaded after global.css, so its utilities are not overridden', () => {
    expect(BASE.indexOf('styles/a11y.css')).toBeGreaterThan(BASE.indexOf('styles/global.css'));
  });
});

// ── 1.3.1 landmarks and headings ────────────────────────────────────────────

describe('WCAG 1.3.1 — one main landmark per page', () => {
  it('only the layout declares <main>', () => {
    // Ten surfaces used to nest a second <main> inside the layout's own.
    const offenders = TEMPLATES.filter(
      (f) => f !== 'src/layouts/Base.astro' && /<main[\s>]/i.test(markupOf(read(f))),
    );
    expect(offenders).toEqual([]);
  });

  it('Base.astro declares exactly one', () => {
    expect(markupOf(BASE).match(/<main[\s>]/gi)).toHaveLength(1);
  });
});

describe('WCAG 2.4.6 — every surface has a top-level heading', () => {
  /**
   * Components a page may delegate its <h1> to.
   *
   * Each is verified below to actually contain one. Without that, adding a name
   * here would be a way to switch the check off for any page that imports it.
   */
  const HEADING_COMPONENTS = [
    { tag: 'PageHero', file: 'src/components/PageHero.astro' },
    { tag: 'AudienceEditorial', file: 'src/components/AudienceEditorial.astro' },
    { tag: 'AdminShell', file: 'src/components/AdminShell.astro' },
  ];

  for (const c of HEADING_COMPONENTS) {
    it(`${c.tag}, which pages delegate their title to, renders an h1`, () => {
      // Asserted first, because the per-page check below accepts these
      // components as proof of an h1. If one ever stops rendering one, that
      // check would silently pass for every page that uses it.
      expect(read(c.file)).toMatch(/<h1\b/);
    });
  }

  // A page whose highest heading is h2 gives a screen-reader user no title to
  // land on. /admin was the one surface with no h1 at all.
  const surfaces = TEMPLATES.filter(
    (f) => f.startsWith('src/pages/') && !f.endsWith('404.astro'),
  );

  for (const f of surfaces) {
    it(`${f} renders an h1`, () => {
      const src = read(f);
      const delegated = HEADING_COMPONENTS.find((c) => new RegExp(`<${c.tag}\\b`).test(src));
      const hasHeading = /<h1[\s>]/i.test(src) || !!delegated;
      expect(
        hasHeading,
        `${f} has no h1 and renders none of ${HEADING_COMPONENTS.map((c) => c.tag).join(', ')}`
      ).toBe(true);

      // A page that BOTH writes its own h1 and delegates to a component that
      // writes one ends up with two, which is the failure this check is
      // ultimately about — a screen-reader user with two competing titles.
      if (delegated) {
        expect(
          /<h1[\s>]/i.test(src),
          `${f} renders <${delegated.tag}> (which already provides the h1) AND its own h1`
        ).toBe(false);
      }
    });
  }
});

// ── 2.1.1 / 2.4.3 keyboard ──────────────────────────────────────────────────

describe('WCAG 2.4.3 — the tab order is the document order', () => {
  it('nothing declares a positive tabindex', () => {
    const offenders: string[] = [];
    for (const f of TEMPLATES) {
      for (const m of markupOf(read(f)).matchAll(/tabindex\s*=\s*["']?([1-9]\d*)/gi)) {
        offenders.push(`${f}: tabindex=${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('WCAG 2.4.7 — a closed mobile menu is not in the tab order', () => {
  it('the collapsed nav panel is visibility:hidden, not merely translated away', () => {
    // Measured at 375px before the fix: ten nav links took keyboard focus at
    // y = -632 to -115, entirely off-screen, and the hamburger that opens them
    // came after them in the tab order.
    // Read the CSS with its comments stripped. The comment above the
    // declaration quotes `visibility: hidden`, so matching the raw source
    // passed on the explanation alone even with the declaration deleted.
    // Mutation-checked.
    const code = cssCode(BASE);
    const mobile = code.slice(code.indexOf('@media (max-width: 1080px)'));
    const closed = (mobile.match(/\.nav-links \{[\s\S]*?\}/) || [''])[0];
    expect(closed, 'the closed .nav-links block declares visibility: hidden')
      .toMatch(/visibility:\s*hidden/);
    expect(mobile).toMatch(/\.nav-links\.open \{[^}]*visibility: visible/);
  });

  it('Escape closes the menu and returns focus to the control that opened it', () => {
    expect(BASE).toMatch(/e\.key !== 'Escape'/);
    expect(BASE).toMatch(/ham\?\.focus\(\)/);
  });

  it('the hamburger still reports its state', () => {
    expect(BASE).toMatch(/aria-expanded="false"[\s\S]{0,80}aria-controls="navLinks"/);
    expect(BASE).toMatch(/setAttribute\('aria-expanded'/);
  });
});

describe('WCAG 2.4.3 — a poll does not destroy the focused control', () => {
  it('/live skips a refresh while the keyboard is inside the question board', () => {
    // The board is redrawn with innerHTML every 30s. Without this guard the
    // focused Upvote button is removed from under the user.
    expect(read('src/pages/live.astro')).toMatch(
      /if \(list\.contains\(document\.activeElement\)\) return;/,
    );
  });
});

// ── 2.2.2 Pause, Stop, Hide ─────────────────────────────────────────────────

describe('WCAG 2.2.2 — auto-updating information can be stopped', () => {
  it('the scoreboard offers a pause control alongside its poll', () => {
    const sb = read('src/pages/scoreboard.astro');
    expect(sb).toMatch(/id="sbPause"/);
    expect(sb).toMatch(/clearInterval\(timer\)/);
  });

  it('every auto-animation still honours prefers-reduced-motion', () => {
    // The homepage ticker and hero slideshow are recorded as OPEN under 2.2.2
    // in docs/ACCESSIBILITY.md; this keeps the mitigation that does exist from
    // being deleted along the way.
    const index = read('src/pages/index.astro');
    expect(index).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.ticker-track \{ animation: none/,
    );
    expect(index).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.hero-slide \{ animation: none/,
    );
  });
});

// ── 2.4.11 Focus Not Obscured ───────────────────────────────────────────────

describe('WCAG 2.4.11 — the fixed nav does not cover what you jump to', () => {
  it('scroll-padding reserves the height of the fixed bar', () => {
    // Measured in Chrome: /governance#documents landed the target at top:0 with
    // 73px of nav painted over it. With scroll-padding it lands at 88px.
    // REVIEW FIX: this used to match any `html {` block, so the
    // `@media (min-width: 1081px)` override satisfied it on its own and the
    // unconditional rule could be deleted with the test still green.
    // Mutation-checked. The unconditional rule is the one covering 1080px
    // and below, where the bar is 72px and the mobile menu opens under it.
    const code = cssCode(GLOBAL_CSS);
    const media = code.indexOf('@media (min-width: 1081px)');
    const unconditional = media >= 0 ? code.slice(0, media) : code;
    const base = Number(
      (unconditional.match(/html \{[^}]*scroll-padding-top:\s*(\d+)px/) || [])[1],
    );
    // The bar is min-height 72px plus its 8px padding.
    expect(base, 'html { scroll-padding-top } declared outside any media query')
      .toBeGreaterThanOrEqual(80);
    // A narrower override above 1080px is allowed but must still clear the
    // bar. Removing the override is not a failure — the base value applies.
    const over = code
      .slice(media < 0 ? code.length : media)
      .match(/html \{[^}]*scroll-padding-top:\s*(\d+)px/);
    if (over) expect(Number(over[1])).toBeGreaterThanOrEqual(80);
  });
});

// ── 3.3.8 Accessible Authentication ─────────────────────────────────────────

describe('WCAG 3.3.8 — a password manager can fill the sign-in fields', () => {
  it('no password field tells password managers to stay out', () => {
    const offenders: string[] = [];
    for (const f of TEMPLATES) {
      for (const m of markupOf(read(f)).matchAll(/<input\b[^>]*>/gi)) {
        if (/type="password"/i.test(m[0]) && /autocomplete="off"/i.test(m[0])) {
          offenders.push(`${f}: ${m[0].slice(0, 100)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing blocks paste into a field', () => {
    // Retyping a code by hand is exactly the cognitive-function test 3.3.8
    // exists to remove.
    const offenders = TEMPLATES.filter((f) => /onpaste|['"]paste['"]/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});

// ── 4.1.2 state ─────────────────────────────────────────────────────────────

describe('WCAG 4.1.2 — a toggle exposes its pressed state', () => {
  const toggles = [
    ['src/pages/gallery.astro', 'gfilter'],
    ['src/pages/shop.astro', 'sfilter'],
    ['src/pages/dojos.astro', 'dir-chip'],
  ];
  for (const [file, selector] of toggles) {
    it(`${selector} buttons carry aria-pressed in markup and in script`, () => {
      const src = read(file);
      expect(src).toMatch(new RegExp(`class="${selector}[^"]*"[^>]*aria-pressed`));
      expect(src).toMatch(/setAttribute\('aria-pressed'/);
    });
  }
});

// ── 4.1.3 Status Messages ───────────────────────────────────────────────────

describe('WCAG 4.1.3 — a failure is announced, not just painted red', () => {
  it('the shared toast is a live region', () => {
    expect(BASE).toMatch(/id="notif"[^>]*role="status"[^>]*aria-live="polite"/);
  });

  it('every sign-in error container is a live region', () => {
    // Each admin surface has its own gate. A lockout message that is not
    // announced leaves the user retrying into a longer lock.
    const gates = TEMPLATES.filter((f) => read(f).includes('id="loginErr"'));
    expect(gates.length).toBeGreaterThan(0);
    for (const f of gates) {
      expect(read(f), `${f} loginErr is not role="alert"`).toMatch(
        /id="loginErr"[^>]*role="alert"|role="alert"[^>]*id="loginErr"/,
      );
    }
  });

  it('DataTable states its own error in an alert, not an empty table', () => {
    const dt = read('src/components/DataTable.astro');
    expect(dt).toMatch(/dt-error" role="alert"/);
    expect(dt).toMatch(/aria-busy=/);
  });
});

// ── 2.5.8 Target Size ───────────────────────────────────────────────────────

describe('WCAG 2.5.8 — targets are at least 24x24 CSS px', () => {
  it('coarse pointers get the project 44px floor', () => {
    expect(GLOBAL_CSS).toMatch(/@media \(pointer: coarse\)[\s\S]{0,400}min-height: 44px/);
  });

  it('registration checkboxes are 24px, not the 22px they used to be', () => {
    expect(read('src/pages/registration.astro')).toMatch(
      /\.check-box \{[\s\S]{0,240}width: 24px; height: 24px;/,
    );
  });
});
