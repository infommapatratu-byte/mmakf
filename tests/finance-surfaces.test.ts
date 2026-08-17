// The finance admin surfaces, and the four ways they could lie.
//
// /admin/finance, /admin/reconciliation and /admin/benchmarks are the screens
// somebody reads before quoting a price, chasing a payer, or signing off a
// year. Each has a characteristic way of being wrong, and none of the four is
// caught by the type checker or by the build:
//
//  1. A FIGURE NOBODY COUNTED. A rupee literal typed into a template to see how
//     the layout sits, left in, and read six months later as turnover.
//  2. A NULL RENDERED AS A ZERO. "No refunds this year" when what happened is
//     that the refunds table could not be read.
//  3. ANOTHER ORGANISATION'S FEE READ AS MMAKF'S. The benchmark register holds
//     other federations' prices; one rupee sign on the wrong number and a
//     British licence fee gets quoted to a school in Jharkhand.
//  4. A HARDCODED GATEWAY RATE. Published card rates change and MMAKF's
//     negotiated terms may differ, so a percentage in a template is a number
//     that is wrong the moment somebody renegotiates and nobody edits it.
//
// These are assertions about the SOURCE, because that is where all four live.
// Nothing here connects to a database.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { statusOf, needsAction } from '../src/lib/status';
import { ADMIN_GROUPS } from '../src/lib/surface';

const PAGES = {
  finance: 'src/pages/admin/finance.astro',
  reconciliation: 'src/pages/admin/reconciliation.astro',
  benchmarks: 'src/pages/admin/benchmarks.astro',
} as const;

const read = (p: string) => readFileSync(p, 'utf8');
const SOURCES = Object.entries(PAGES).map(([name, path]) => ({ name, path, src: read(path) }));

/** The frontmatter and markup, with comment blocks removed. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/**
 * Everything but the stylesheet.
 *
 * `width: 100%` is a length and `flex: 1 1 100%` is a basis; neither is a rate,
 * and a guard that cannot tell them from a gateway commission would be turned
 * off within a week of somebody writing a responsive rule.
 */
function withoutStyles(src: string): string {
  return src.replace(/<style[\s\S]*?<\/style>/gi, '');
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. NO FIGURE THAT IS NOT FROM A QUERY
// ═══════════════════════════════════════════════════════════════════════════

describe('no money figure is written into the surfaces by hand', () => {
  it.each(SOURCES)('$name carries no rupee literal', ({ path, src }) => {
    // ₹ followed by a digit is the shape of a figure somebody typed. The symbol
    // on its own is fine — it appears in prose about what a column would show.
    const hits = [...src.matchAll(/₹\s*[\d.,]+/g)].map((m) => m[0]);
    expect(
      hits,
      `${path} contains a rupee amount written into the source. Every figure on these ` +
      'screens must come from a query — a literal is a number nobody counted, and it is ' +
      'indistinguishable on screen from one somebody did.'
    ).toEqual([]);
  });

  it.each(SOURCES)('$name carries no digit-grouped amount', ({ path, src }) => {
    // "1,50,000" or "1,234.00" — the shape of an illustrative total, in prose
    // or in markup. Excludes the frontmatter's own numeric constants, which
    // never carry grouping.
    const hits = [...src.matchAll(/\b\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\b/g)].map((m) => m[0]);
    expect(hits, `${path} contains what looks like a sample amount`).toEqual([]);
  });

  it.each(SOURCES)('$name names no unit of money beside a number', ({ path, src }) => {
    const hits = [...src.matchAll(/\b\d+(?:\.\d+)?\s*(?:rupees?|paise|lakh|crore)\b/gi)].map((m) => m[0]);
    expect(
      hits,
      `${path} states an amount in words. Even in a comment this is a figure the federation ` +
      'has not approved — the brief forbids a placeholder rupee value anywhere, comments included.'
    ).toEqual([]);
  });

  it('the guard is not vacuous — it catches the literal it exists to catch', () => {
    const planted = 'ceiling is ₹4,500.00 per athlete';
    expect([...planted.matchAll(/₹\s*[\d.,]+/g)].length).toBe(1);
    expect([...planted.matchAll(/\b\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\b/g)].length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. A ZERO AND AN UNMEASURABLE ARE DIFFERENT FACTS
// ═══════════════════════════════════════════════════════════════════════════

describe('a figure that could not be produced is never a zero', () => {
  it('the money dashboard renders a dash, not a zero, when there is no figure', () => {
    const src = code(read(PAGES.finance));
    // money() returns null for an absent figure and the template falls back to
    // an em dash. A `?? 0` anywhere on that path is the defect.
    expect(src).toMatch(/money\(f\.paise\)\s*\?\?\s*'—'/);
    expect(src, 'a money figure defaults to zero somewhere').not.toMatch(/paise\s*\?\?\s*0\b/);
  });

  it('every absent figure carries a reason beside it', () => {
    const src = code(read(PAGES.finance));
    // The gap sentence is rendered wherever the value is null. Three bands, so
    // three occurrences — one per figure grid.
    const rendered = [...src.matchAll(/f\.paise == null && <p class="fig-gap">\{f\.gap\}<\/p>/g)];
    expect(
      rendered.length,
      'a figure grid renders a dash with no explanation. A dash nobody explained ' +
      'is indistinguishable from a bug, and a reader will resolve it as a zero.'
    ).toBeGreaterThanOrEqual(3);
  });

  it('the reconciliation page distinguishes an empty list from an unreadable one', () => {
    const src = code(read(PAGES.reconciliation));
    // `gap` is the "we could not read this" channel and it is rendered before
    // any table, so an unreadable register never reaches the empty state.
    expect(src).toMatch(/\.gap \? <p class="note">\{[a-z]+\.gap\}<\/p>/i);
    expect(src).toMatch(/gap: string \| null/);
  });

  it('a missing table is diagnosed by name and by migration, not thrown', () => {
    for (const page of [PAGES.finance, PAGES.reconciliation]) {
      const src = read(page);
      expect(src, `${page} does not name the migration a missing table comes from`)
        .toMatch(/INTRODUCED_BY/);
      expect(src).toMatch(/information_schema\.tables/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE BENCHMARK REGISTER IS UNMISTAKABLY SOMEBODY ELSE'S MONEY
// ═══════════════════════════════════════════════════════════════════════════

describe('the benchmark register cannot be read as MMAKF’s price list', () => {
  const src = read(PAGES.benchmarks);

  it('never imports the rupee formatter', () => {
    // formatINR() is for MMAKF's money. A benchmark rendered with a rupee sign
    // is the first step towards it being quoted as a federation price, so the
    // formatter is not available in this file at all — which is a stronger
    // guarantee than remembering not to call it.
    expect(
      /import\s*\{[^}]*formatINR[^}]*\}\s*from/.test(src),
      'benchmarks.astro imports formatINR. Another organisation’s fee must never render ' +
      'with a rupee sign unless that organisation charges in rupees, which is what ' +
      'formatBenchmarkAmount() is for.'
    ).toBe(false);
    expect(src).toMatch(/formatBenchmarkAmount/);
  });

  it('states whose money it is before it shows any of it', () => {
    const banner = src.indexOf('class="whose"');
    const firstTable = src.indexOf('<Table');
    const firstCard = src.indexOf('<StatCard');
    expect(banner, 'the attribution banner is missing').toBeGreaterThan(-1);
    expect(banner).toBeLessThan(firstTable);
    expect(banner).toBeLessThan(firstCard);
  });

  it('keeps the attribution on the primary column, which is what survives a phone', () => {
    // Below the breakpoint DataTable keeps only the primary columns. Losing the
    // organisation there is exactly the failure: a fee with no owner.
    expect(src).toMatch(/key: 'organisation', header: 'Organisation charging it', primary: true/);
  });

  it('says in words that nothing here is an MMAKF fee', () => {
    expect(src).toMatch(/not MMAKF/);
    expect(src).toMatch(/somebody else’s price/i);
  });

  it('checks its own claim against the rows rather than promising it', () => {
    // A register of other organisations' fees containing an MMAKF row is a
    // price list nobody approved. The page counts, and says so.
    expect(src).toMatch(/selfReferences/);
    expect(src).toMatch(/mmakf\|modern\\s\+martial\\s\+arts\\s\+karate/i);
  });

  it('offers no path from a benchmark to a fee rule', () => {
    const c = code(src);
    for (const forbidden of ['addRule', 'feeRules', 'createFramework', 'publishFramework']) {
      expect(
        c.includes(forbidden),
        `benchmarks.astro references ${forbidden}. A benchmark is evidence about a third party; ` +
        'turning one into an MMAKF price is a decision two people make on the fee framework screen.'
      ).toBe(false);
    }
  });

  it('changes a row’s standing through the store, never with its own UPDATE', () => {
    const c = code(src);
    expect(c).toMatch(/setBenchmarkStatus\(/);
    expect(c, 'the page writes to the register directly instead of through src/db/benchmarks.ts')
      .not.toMatch(/db\(\)\s*\.\s*update\(/);
  });

  it('does not convert a currency, and says why', () => {
    expect(src).toMatch(/never converted|Currency is never converted/i);
    const c = code(src);
    // An exchange rate applied in a template would be arithmetic on somebody
    // else's money with a rate this system does not hold.
    expect(c).not.toMatch(/fxRate|exchangeRate|toINR/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. NO GATEWAY RATE, AND NO SECRET
// ═══════════════════════════════════════════════════════════════════════════

describe('the surfaces hold no rate and disclose no credential', () => {
  it.each(SOURCES)('$name states no percentage of its own', ({ path, src }) => {
    const hits = [...withoutStyles(src).matchAll(/\b\d+(?:\.\d+)?\s*%/g)].map((m) => m[0]);
    expect(
      hits,
      `${path} contains a percentage. Published gateway rates change and MMAKF's negotiated ` +
      'terms may differ, so a rate belongs in gateway_cost_rates with the source it came from.'
    ).toEqual([]);
  });

  it('the money dashboard reports gateway cost as measured, not as a rate applied', () => {
    const src = read(PAGES.finance);
    expect(src).toMatch(/provider_fee_paise/);
    expect(src).toMatch(/NO RATE IS APPLIED HERE/);
    // applyFactor() in fees.ts is the only place a factor touches money, and
    // this page applies none.
    expect(code(src)).not.toMatch(/applyFactor/);
  });

  it.each(SOURCES)('$name never reads a secret from the environment', ({ path, src }) => {
    const hits = [...src.matchAll(/process\.env\.[A-Z_]+/g)].map((m) => m[0]);
    expect(
      hits,
      `${path} reads the environment directly. Credential shape is decided in ` +
      'src/lib/payments/mode.ts, which returns booleans and never a key.'
    ).toEqual([]);
  });

  it('the money dashboard shows the mode without showing the key', () => {
    const src = read(PAGES.finance);
    expect(src).toMatch(/paymentModeReport\(\)/);
    // paymentModeReport() also returns the PUBLIC key id. It is deliberately
    // not rendered: a screen that prints one credential teaches everybody who
    // maintains it that printing credentials is what this section does.
    expect(code(src), 'the dashboard renders a gateway key').not.toMatch(/mode\.keyId/);
    expect(code(src)).not.toMatch(/keySecret/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORITY
// ═══════════════════════════════════════════════════════════════════════════

describe('each surface is gated, and its writes are guarded separately', () => {
  it('the money dashboard needs finance:read', () => {
    expect(read(PAGES.finance)).toMatch(/requires="finance:read"/);
  });

  it('reconciliation needs finance:read', () => {
    expect(read(PAGES.reconciliation)).toMatch(/requires="finance:read"/);
  });

  it('the benchmark register is gated on the action its own store asserts', () => {
    // Not finance:*. src/db/benchmarks.ts asserts benchmark:read and
    // benchmark:write, and a page offering a control the module will refuse is
    // worse than one that does not offer it.
    const src = read(PAGES.benchmarks);
    expect(src).toMatch(/requires="benchmark:read"/);
    expect(src).toMatch(/canAnywhere\(principal, 'benchmark:write'\)/);
  });

  it('the two read-only surfaces write nothing at all', () => {
    for (const page of [PAGES.finance, PAGES.reconciliation]) {
      const src = read(page);
      expect(src, `${page} has a form`).not.toMatch(/method="post"/i);
      expect(src, `${page} has a POST branch`).not.toMatch(/request\.method === 'POST'/);
    }
  });

  it('the benchmark register re-checks authority on the request, not on the render', () => {
    const src = code(read(PAGES.benchmarks));
    // The rendered page may be minutes old and the request may not have come
    // from it, so mayWrite is tested inside the POST branch as well.
    const post = src.slice(src.indexOf("request.method === 'POST'"));
    expect(post).toMatch(/!mayWrite/);
    expect(post).toMatch(/rateLimit\(/);
  });

  it('all three appear in the admin menu, each gated on the action its page requires', () => {
    const finance = ADMIN_GROUPS.flatMap((g) => g.modules);
    const expected: Record<string, string> = {
      '/admin/finance': 'finance:read',
      '/admin/reconciliation': 'finance:read',
      '/admin/benchmarks': 'benchmark:read',
    };
    for (const [href, action] of Object.entries(expected)) {
      const entry = finance.find((m) => m.href === href);
      expect(entry, `${href} is not in the admin navigation`).toBeTruthy();
      expect(entry!.action, `${href} is gated on the wrong action in the menu`).toBe(action);
    }
  });

  it('names the benchmark register in the menu so it cannot be mistaken for MMAKF’s prices', () => {
    const entry = ADMIN_GROUPS.flatMap((g) => g.modules).find((m) => m.href === '/admin/benchmarks');
    expect(entry!.label.toLowerCase()).toContain('federations');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE STATUS VOCABULARY THESE SCREENS RENDER
// ═══════════════════════════════════════════════════════════════════════════

describe('the reconciliation vocabulary reads correctly', () => {
  it('every classification except matched asks somebody to act', () => {
    const exceptions = [
      'missing_in_mmakf', 'missing_at_gateway', 'duplicate',
      'amount_mismatch', 'currency_mismatch', 'unsettled', 'disputed',
    ];
    for (const v of exceptions) {
      expect(needsAction(v), `${v} is an exception nobody is told to act on`).toBe(true);
    }
    expect(needsAction('matched')).toBe(false);
  });

  it('does not collapse the two "missing" cases into one word', () => {
    // They mean opposite things and are worked by different people: money the
    // gateway holds against nothing MMAKF issued, against a payment MMAKF
    // recorded that the gateway's statement does not contain.
    const inMmakf = statusOf('missing_in_mmakf');
    const atGateway = statusOf('missing_at_gateway');
    expect(inMmakf.label).not.toBe(atGateway.label);
    expect(inMmakf.meaning).not.toBe(atGateway.meaning);
  });

  it('warns that a failed run proves nothing, rather than reading as a clean period', () => {
    // The dictionary's own `failed` carries the PAYMENT sentence — "No money
    // moved" — which on a reconciliation run is an assurance about the
    // federation's money given by a job that never managed to look at it.
    const run = statusOf('failed', 'reconciliation_run');
    expect(run.meaning).toMatch(/NOTHING IS PROVEN/i);
    expect(run.meaning).not.toMatch(/no money moved/i);
    expect(run.actionable).toBe(true);
  });

  it('does not paint a conceded chargeback as a success', () => {
    // `accepted` is `good` everywhere else in the federation, because accepting
    // something is normally a success. On a dispute it means MMAKF handed the
    // money back — a loss, chosen rather than suffered.
    const conceded = statusOf('accepted', 'dispute');
    expect(conceded.tone).not.toBe('good');
    expect(conceded.tone).toBe('stopped');
    expect(conceded.label).toBe('Conceded');
    // And the generic reading is unchanged for everybody else.
    expect(statusOf('accepted').tone).toBe('good');
  });

  it('treats a lapsed evidence deadline as a loss, not as a neutral expiry', () => {
    const lapsed = statusOf('expired', 'dispute');
    expect(lapsed.tone).toBe('bad');
    expect(lapsed.meaning).toMatch(/default/i);
    // The undomained reading is the mild one, which is why the override exists.
    expect(statusOf('expired').tone).toBe('neutral');
  });

  it('does not read a withdrawn dispute as a failure', () => {
    // `cancelled` is `bad` in the dictionary. A dispute the payer's bank
    // withdrew is the best available outcome.
    expect(statusOf('cancelled', 'dispute').tone).toBe('good');
    expect(statusOf('cancelled').tone).toBe('bad');
  });

  it('does not treat an abandoned checkout as a failure', () => {
    // Somebody who changed their mind at a payment page has done nothing wrong.
    expect(statusOf('abandoned').tone).toBe('neutral');
    expect(needsAction('abandoned')).toBe(false);
  });

  it('reports an unprobed gateway as unmeasured rather than as an outage', () => {
    expect(statusOf('unknown').tone).toBe('neutral');
    expect(statusOf('down').tone).toBe('bad');
    expect(needsAction('down')).toBe(true);
  });
});

describe('every exception the reconciliation page lists tells the reader what to do', () => {
  const src = read(PAGES.reconciliation);

  it('carries an instruction for every non-matched classification', () => {
    const classifications = [
      'missing_in_mmakf', 'missing_at_gateway', 'duplicate',
      'amount_mismatch', 'currency_mismatch', 'unsettled', 'refunded', 'disputed',
    ];
    const block = src.slice(src.indexOf('const WHAT_TO_DO'), src.indexOf('// ─── The registers'));
    for (const c of classifications) {
      expect(block, `no instruction for ${c}`).toMatch(new RegExp(`\\b${c}:`));
    }
  });

  it('tells the reader NOT to make two figures agree', () => {
    // The one act reconciliation must never perform. A system that can quietly
    // write one figure onto another to make a report balance proves nothing.
    expect(src).toMatch(/Do not adjust either record/);
    expect(src).toMatch(/never adjusts to match|must never perform/);
  });

  it('gives the four run-free exception classes an instruction each', () => {
    // These read only the commerce tables, so they answer on a database that
    // has never reconciled anything — which is every deployment until the first
    // gateway statement arrives.
    const instructions = [...src.matchAll(/WHAT TO DO:/g)];
    expect(instructions.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses to invent a settlement deadline', () => {
    // MMAKF has published no settlement expectation. A "T+2" default in code
    // would be this system deciding a commercial term nobody signed.
    expect(src).toMatch(/no default expectation and will not invent one/);
  });
});
