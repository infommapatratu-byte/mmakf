// A no-JS visitor gets an honest message, not Vercel's raw platform error.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HARD LIMIT THIS FILE DOCUMENTS
// ─────────────────────────────────────────────────────────────────────────────
//
// Confirmed exhaustively against production before this component was written:
// the deployment's edge platform refuses every POST whose body is an encoding
// an HTML <form> can produce, REGARDLESS of Origin, Sec-Fetch-*, User-Agent, or
// a cookie obtained from a genuine prior page visit. There is no request shape
// a script-free browser can produce that gets past it. src/scripts/
// form-upgrade.ts fixes this for everybody running JavaScript by rewriting the
// submission to JSON — but that rewrite IS JavaScript, so it cannot help the
// population this file is about.
//
// Given that hard limit, the correct and complete response is not a fake fix —
// switching to method="get" would put PII in server logs and browser history
// and reopen the CSRF hole SameSite POST protection exists to close, which
// tests/hardening.test.ts guards. The correct response is honesty: tell a
// no-JS visitor what is happening and give them a real alternative, before they
// waste time filling in a form that cannot be sent.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY <noscript> IS THE MECHANISM, AND WHAT THAT GUARANTEES
// ─────────────────────────────────────────────────────────────────────────────
//
// Content inside <noscript> is rendered by the browser ONLY when scripting is
// disabled or unsupported. There is no JS-side condition to keep in sync, and
// no code path by which a JavaScript-enabled visitor — for whom the JSON
// upgrade already works — sees this notice. Both halves are asserted below:
// every affected page carries the notice, and the component that renders it
// wraps its content in a real <noscript> tag rather than a styled div that
// merely looks like one.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const COMPONENT = 'src/components/NoScriptNotice.astro';

const PUBLIC_FORM_PAGES = [
  'src/pages/register.astro',
  'src/pages/join.astro',
  'src/pages/start/individual.astro',
  'src/pages/learn/apply.astro',
  'src/pages/learn/coaches.astro',
  'src/pages/careers/[slug].astro',
  'src/pages/portal/register.astro',
  'src/pages/portal/applications.astro',
  'src/pages/my/notifications.astro',
  'src/pages/my/schedule.astro',
];

describe('NoScriptNotice actually uses <noscript>, not a JS-toggled look-alike', () => {
  const src = readFileSync(COMPONENT, 'utf8');

  it('wraps its content in a real <noscript> element', () => {
    expect(src).toMatch(/<noscript>/);
    expect(src).toMatch(/<\/noscript>/);
  });

  it('names the alternative channel and asks for a subject line to route on', () => {
    expect(src).toContain('admin@mmakf.in');
    expect(src).toContain('subject line');
  });

  it('does not blame the visitor for what is a platform-side restriction', () => {
    expect(src).toMatch(/not\s+something\s+wrong\s+with\s+what\s+you\s+typed/i);
  });
});

describe('every public form warns a no-JS visitor before they fill it in', () => {
  for (const path of PUBLIC_FORM_PAGES) {
    it(`${path} imports and renders NoScriptNotice`, () => {
      const src = readFileSync(path, 'utf8');
      expect(src, `${path} does not import NoScriptNotice`)
        .toContain("import NoScriptNotice from '@/components/NoScriptNotice.astro';");
      expect(src, `${path} does not render <NoScriptNotice`)
        .toMatch(/<NoScriptNotice\s+what="[^"]+"\s*\/>/);
    });

    it(`${path} places the notice before at least one <form>`, () => {
      const src = readFileSync(path, 'utf8');
      const noticeAt = src.search(/<NoScriptNotice/);
      expect(noticeAt, `${path} has no notice`).toBeGreaterThan(-1);
      // NOT "before the first form in the file": join.astro and
      // portal/applications.astro each carry an earlier, deliberately
      // unguarded one-click action (a withdrawal with an optional reason —
      // no substantial content to lose) ahead of the substantive form the
      // notice actually covers. The real invariant is that a no-JS visitor
      // reaches the notice before reaching SOME form worth warning about.
      const formAfter = src.slice(noticeAt).search(/<form[\s>]/);
      expect(formAfter, `${path}: no form follows the notice at all`).toBeGreaterThan(-1);
    });
  }

  it('the import statement never lands inside a multi-line import block', () => {
    // The exact mistake made once already in this session: inserting an import
    // line by "after the last line starting with import" hit the opening line
    // of a multi-line `import {` block and split it in two. Guarded by pattern
    // rather than trusted to not recur.
    for (const path of PUBLIC_FORM_PAGES) {
      const src = readFileSync(path, 'utf8');
      expect(src, `${path} has a broken import block`)
        .not.toMatch(/import \{\nimport NoScriptNotice/);
    }
  });
});

describe('the fallback does not attempt an unsafe workaround', () => {
  it('no affected page was switched to method="get" as a workaround', () => {
    // A GET carrying a name, an email or a cover letter puts every one of them
    // into server logs and browser history, and GET requests carry none of the
    // SameSite protections this site's CSRF defence relies on — trading a real
    // vulnerability for a smaller inconvenience is not a fix.
    for (const path of PUBLIC_FORM_PAGES) {
      const src = readFileSync(path, 'utf8');
      const noticeAt = src.search(/<NoScriptNotice/);
      if (noticeAt < 0) continue;
      // A page may legitimately render an unrelated GET form (a filter, e.g.
      // my/notifications.astro's topic selector) between the notice and the
      // form it actually guards — GET was never affected by the platform
      // block, so that is not the pattern being guarded against here. The
      // real check: SOME post-method form exists after the notice, proving it
      // was not quietly swapped to GET to dodge the block.
      const rest = src.slice(noticeAt);
      const forms = [...rest.matchAll(/<form[^>]*>/g)].slice(0, 6);
      expect(forms.length, `${path}: no <form> found after the notice`).toBeGreaterThan(0);
      const hasPost = forms.some((m) => /method=["']post["']/i.test(m[0]));
      expect(hasPost, `${path}: no POST form found near the notice — was it switched to GET?`)
        .toBe(true);
    }
  });
});
