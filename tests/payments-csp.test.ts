// The Content-Security-Policy in vercel.json, against what the site actually loads.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SCAN AND NOT A LIST OF ASSERTIONS
// ─────────────────────────────────────────────────────────────────────────────
//
// Razorpay Checkout is loaded by three pages from https://checkout.razorpay.com.
// The policy that shipped blocked it: `script-src` named no Razorpay origin, so
// the browser refused checkout.js, `window.Razorpay` never existed, and the pay
// button reported a gateway failure that had nothing to do with the gateway.
// Nothing in the unit suite could see that. A CSP is enforced by the BROWSER, a
// green test cannot observe it, and the failure only appears in production — the
// repository's characteristic "complete, tested, unreachable" shape.
//
// So the claim "the policy permits what the site loads" is checked from both
// ends. vercel.json is parsed into its directives; the templates are scanned for
// every absolute https:// origin the BROWSER will fetch as a script, iframe,
// connection, image or stylesheet; and each origin must be permitted by the
// directive that governs it, with the real CSP fallback chain
// (frame-src -> child-src -> default-src).
//
// WHAT THE SCAN DELIBERATELY DOES NOT SEE, stated rather than implied:
//
//   · SERVER-SIDE fetches. The frontmatter fence of an .astro file and
//     everything under src/pages/api run on the server, where CSP does not apply
//     (src/lib/youtube.ts calling oauth2.googleapis.com is one).
//   · Origins assembled at run time. `https://${host}/…` has no origin to check
//     and is reported as DYNAMIC so that somebody has to look at it.
//   · A link a person clicks. <a href="https://…"> is navigation, not a load.
//   · Anything a third-party script loads on its own. checkout.js opening its
//     iframe is covered by frame-src; what runs INSIDE that iframe is governed
//     by Razorpay's policy, not ours.
//
// Like tests/accessibility.test.ts, each checker is proven against a known-bad
// fixture first. A scanner that has never reported anything proves nothing.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// ── parsing vercel.json ─────────────────────────────────────────────────────

type Csp = Map<string, string[]>;

function parseCsp(value: string): Csp {
  const out: Csp = new Map();
  for (const part of value.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const [name, ...sources] = tokens;
    // The first occurrence of a directive wins, per the CSP spec.
    if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), sources);
  }
  return out;
}

const cfg = JSON.parse(readFileSync('vercel.json', 'utf8'));

function headerOf(key: string, source = '/(.*)'): string {
  const rule = (cfg.headers ?? []).find((h: any) => h.source === source);
  const h = (rule?.headers ?? []).find((x: any) => x.key.toLowerCase() === key.toLowerCase());
  if (!h) throw new Error(`vercel.json has no ${key} header on ${source}`);
  return String(h.value);
}

const CSP_RAW = headerOf('Content-Security-Policy');
const CSP = parseCsp(CSP_RAW);
const PERMISSIONS = headerOf('Permissions-Policy');

// ── matching a URL against a source list ────────────────────────────────────

/** Origins that count as "this site" for an ABSOLUTE url in a template. */
const SELF_HOSTS = new Set(['www.mmakf.in', 'mmakf.in']);

function sourceMatches(token: string, u: URL): boolean {
  const t = token.trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (lower === "'self'") return u.protocol === 'https:' && SELF_HOSTS.has(u.hostname);
  if (lower.startsWith("'")) return false; // 'none', 'unsafe-inline', nonces, hashes: not a URL source
  if (lower === '*') return u.protocol === 'http:' || u.protocol === 'https:';
  if (/^[a-z][a-z0-9+.-]*:$/.test(lower)) return u.protocol === lower; // scheme-source: https:, data:

  // host-source: [scheme://]host[:port][/path]
  const m = lower.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^/:]+|[^/:*]+)(?::(\d+|\*))?(\/.*)?$/);
  if (!m) return false;
  const [, scheme, host, port, srcPath] = m;
  if (scheme && `${scheme}:` !== u.protocol) return false;
  if (!scheme && u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (host === '*') {
    // fall through to port/path
  } else if (host.startsWith('*.')) {
    const base = host.slice(2);
    // A wildcard matches subdomains ONLY — never the bare apex, never a lookalike.
    if (!u.hostname.endsWith(`.${base}`)) return false;
  } else if (u.hostname !== host) {
    return false;
  }
  if (port && port !== '*' && (u.port || (u.protocol === 'https:' ? '443' : '80')) !== port) return false;
  if (srcPath && srcPath !== '/') {
    return srcPath.endsWith('/') ? u.pathname.startsWith(srcPath) : u.pathname === srcPath;
  }
  return true;
}

/** The CSP fallback chain: which directive actually governs a fetch of this kind. */
const GOVERNED_BY: Record<string, string[]> = {
  'script-src': ['script-src', 'default-src'],
  'frame-src': ['frame-src', 'child-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'style-src': ['style-src', 'default-src'],
};

function effectiveSources(csp: Csp, directive: string): { from: string; sources: string[] } {
  for (const name of GOVERNED_BY[directive]) {
    const s = csp.get(name);
    if (s) return { from: name, sources: s };
  }
  return { from: '(none)', sources: [] };
}

function permits(csp: Csp, directive: string, url: URL): boolean {
  const { sources } = effectiveSources(csp, directive);
  return sources.some((tok) => sourceMatches(tok, url));
}

// ── finding what the templates load ─────────────────────────────────────────

type Kind = 'script' | 'frame' | 'connect' | 'img' | 'style' | 'unclassified';
const DIRECTIVE_OF: Record<Exclude<Kind, 'unclassified'>, string> = {
  script: 'script-src', frame: 'frame-src', connect: 'connect-src', img: 'img-src', style: 'style-src',
};

interface Load { file: string; line: number; kind: Kind; url: string; how: string }

/** Blank out comments but keep every newline, so line numbers stay true. */
function withoutComments(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, '');
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // A line comment starts at `//` that is NOT the `//` of a scheme: it must follow
    // the start of the line or whitespace/punctuation, never `:` or a quote.
    .split('\n')
    .map((l) => l.replace(/(^|[\s;{}(),])\/\/.*$/, '$1'))
    .join('\n');
}

/** What a browser runs: an .astro file minus its server-side frontmatter fence. */
function clientPart(file: string, text: string): string {
  let t = text;
  if (file.endsWith('.astro')) {
    const m = t.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    if (m) t = m[0].replace(/[^\n]/g, '') + t.slice(m[0].length);
  }
  return withoutComments(t);
}

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Scan one file's text for absolute http(s) loads. Pure, so it can be proven on fixtures. */
function findLoads(file: string, raw: string): Load[] {
  const text = clientPart(file, raw);
  const loads: Load[] = [];
  const add = (index: number, kind: Kind, url: string, how: string) =>
    loads.push({ file, line: lineAt(text, index), kind, url, how });
  const URL_BODY = '(https?:\\/\\/[^"\'`\\s)]+)';

  // 1. <script src="https://…">
  for (const m of text.matchAll(new RegExp(`<script\\b[^>]*?\\bsrc\\s*=\\s*(?:\\{\\s*)?(["'\`])${URL_BODY}\\1`, 'gi'))) {
    add(m.index!, 'script', m[2], '<script src>');
  }
  // 2. loadScript('https://…')
  for (const m of text.matchAll(new RegExp(`\\bloadScript\\(\\s*(["'\`])${URL_BODY}\\1`, 'g'))) {
    add(m.index!, 'script', m[2], 'loadScript()');
  }
  // 3. something.src = 'https://…' — what it is depends on what was created.
  for (const m of text.matchAll(new RegExp(`(\\w+)\\.src\\s*=\\s*(["'\`])${URL_BODY}\\2`, 'g'))) {
    const before = text.slice(Math.max(0, m.index! - 700), m.index!);
    const kind: Kind =
      /createElement\(\s*['"]script['"]\s*\)/.test(before) ? 'script'
      : /createElement\(\s*['"]iframe['"]\s*\)/.test(before) ? 'frame'
      : /createElement\(\s*['"]img['"]\s*\)|new Image\b/.test(before) ? 'img'
      : 'unclassified';
    add(m.index!, kind, m[3], `${m[1]}.src =`);
  }
  // 4. <iframe src="https://…"> and <iframe src={`https://…`}>
  for (const m of text.matchAll(new RegExp(`<iframe\\b[^>]*?\\bsrc\\s*=\\s*(?:\\{\\s*)?(["'\`])${URL_BODY}\\1`, 'gi'))) {
    add(m.index!, 'frame', m[2], '<iframe src>');
  }
  //    …and an iframe built in a script from a variable: `<iframe src="${src}"`.
  for (const m of text.matchAll(/<iframe\b[^>]*?\bsrc\s*=\s*["']\$\{\s*(\w+)\s*\}["']/gi)) {
    const before = text.slice(Math.max(0, m.index! - 2500), m.index!);
    const decl = [...before.matchAll(new RegExp(`(?:const|let|var)\\s+${m[1]}\\s*=\\s*(["'\`])${URL_BODY}`, 'g'))].pop();
    if (decl) add(m.index!, 'frame', decl[2], `<iframe src="\${${m[1]}}">`);
  }
  // 5. fetch / beacon / socket to an absolute URL
  for (const m of text.matchAll(new RegExp(`\\b(fetch|sendBeacon|WebSocket|EventSource)\\(\\s*(["'\`])((?:https?|wss?):\\/\\/[^"'\`\\s)]+)\\2`, 'g'))) {
    add(m.index!, 'connect', m[3], `${m[1]}()`);
  }
  // 6. <img src="https://…">
  for (const m of text.matchAll(new RegExp(`<img\\b[^>]*?\\bsrc\\s*=\\s*(?:\\{\\s*)?(["'\`])${URL_BODY}\\1`, 'gi'))) {
    add(m.index!, 'img', m[2], '<img src>');
  }
  // 7. stylesheets
  for (const m of text.matchAll(new RegExp(`<link\\b[^>]*\\brel\\s*=\\s*["']stylesheet["'][^>]*\\bhref\\s*=\\s*(["'\`])${URL_BODY}\\1`, 'gi'))) {
    add(m.index!, 'style', m[2], '<link stylesheet>');
  }
  for (const m of text.matchAll(/@import\s+url\(\s*(["']?)(https?:\/\/[^"')\s]+)\1\s*\)/g)) {
    add(m.index!, 'style', m[2], '@import url()');
  }
  return loads;
}

/** Turn a literal URL into something `new URL` accepts; null when the ORIGIN is dynamic. */
function toUrl(raw: string): URL | null {
  if (/^https?:\/\/\$\{/.test(raw)) return null;
  try {
    return new URL(raw.replace(/\$\{[^}]*\}/g, 'x'));
  } catch {
    return null;
  }
}

interface Verdict { load: Load; origin: string; directive: string; governedBy: string; ok: boolean; reason?: string }

function judge(csp: Csp, loads: Load[]): Verdict[] {
  return loads.map((load) => {
    const u = toUrl(load.url);
    if (!u) return { load, origin: '(dynamic)', directive: '?', governedBy: '?', ok: false, reason: 'the origin is built at run time and cannot be checked' };
    if (SELF_HOSTS.has(u.hostname)) return { load, origin: u.origin, directive: '-', governedBy: '-', ok: true };
    if (load.kind === 'unclassified') return { load, origin: u.origin, directive: '?', governedBy: '?', ok: false, reason: 'cannot tell what kind of load this is' };
    const directive = DIRECTIVE_OF[load.kind];
    const { from } = effectiveSources(csp, directive);
    return { load, origin: u.origin, directive, governedBy: from, ok: permits(csp, directive, u) };
  });
}

function walk(dir: string, accept: (p: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, accept, out);
    else if (accept(p.replace(/\\/g, '/'))) out.push(p.replace(/\\/g, '/'));
  }
  return out.sort();
}

// ════════════════════════════════════════════════════════════════════════════
// THE CHECKERS, PROVEN ON KNOWN-BAD INPUT FIRST
// ════════════════════════════════════════════════════════════════════════════

describe('the matcher and the scanner can fail', () => {
  const policy = parseCsp("default-src 'self'; script-src 'self' https://a.example https://*.wild.example; frame-src https://f.example");

  it('refuses an origin the directive does not list', () => {
    expect(permits(policy, 'script-src', new URL('https://b.example/x.js'))).toBe(false);
    expect(permits(policy, 'script-src', new URL('https://a.example/x.js'))).toBe(true);
  });

  it('a wildcard host matches subdomains, never the apex or a lookalike', () => {
    expect(permits(policy, 'script-src', new URL('https://cdn.wild.example/x.js'))).toBe(true);
    expect(permits(policy, 'script-src', new URL('https://wild.example/x.js'))).toBe(false);
    expect(permits(policy, 'script-src', new URL('https://evilwild.example/x.js'))).toBe(false);
  });

  it('a scheme must match: an http:// origin is not permitted by an https:// source', () => {
    expect(permits(policy, 'script-src', new URL('http://a.example/x.js'))).toBe(false);
  });

  it('follows the real fallback chain: frame-src, then child-src, then default-src', () => {
    expect(effectiveSources(policy, 'frame-src').from).toBe('frame-src');
    const noFrame = parseCsp("default-src 'self'; script-src https://a.example");
    expect(effectiveSources(noFrame, 'frame-src').from).toBe('default-src');
    expect(permits(noFrame, 'frame-src', new URL('https://a.example/'))).toBe(false); // script-src is not consulted
    const child = parseCsp("default-src 'self'; child-src https://c.example");
    expect(effectiveSources(child, 'frame-src').from).toBe('child-src');
  });

  it('finds each way a page can pull in a script, a frame or a connection', () => {
    const fixture = [
      `<script src="https://one.example/a.js"></script>`,
      `<script>loadScript('https://two.example/b.js'); const t = document.createElement('script'); t.src = 'https://three.example/c.js';</script>`,
      '<iframe title="m" src={`https://four.example/m?q=${q}`}></iframe>',
      "<script>const src = `https://five.example/embed/${id}`; box.innerHTML = `<iframe src=\"${src}\"></iframe>`;</script>",
      `<script>fetch('https://six.example/api');</script>`,
    ].join('\n');
    const found = findLoads('fixture.astro', fixture).map((l) => `${l.kind}:${new URL(l.url.replace(/\$\{[^}]*\}/g, 'x')).host}`);
    expect(found.sort()).toEqual([
      'connect:six.example', 'frame:five.example', 'frame:four.example',
      'script:one.example', 'script:three.example', 'script:two.example',
    ]);
  });

  it('ignores the frontmatter fence, comments and plain links', () => {
    const fixture = [
      '---',
      `const r = await fetch('https://server-side.example/token');`,
      '---',
      `<!-- <script src="https://commented.example/x.js"></script> -->`,
      `<script>\n// loadScript('https://line-comment.example/x.js')\n/* fetch('https://block-comment.example/') */</script>`,
      `<a href="https://just-a-link.example/">link</a>`,
    ].join('\n');
    expect(findLoads('fixture.astro', fixture)).toEqual([]);
  });

  it('reports a dynamic origin and an unclassifiable assignment instead of waving them through', () => {
    const fixture = '<script>const x = thing(); x.src = "https://who-knows.example/a";</script>\n<iframe src="https://${host}/e"></iframe>';
    const verdicts = judge(policy, findLoads('fixture.astro', fixture));
    // Both are seen and both fail: the assignment (what kind of load is it?) and
    // the iframe whose origin is a run-time placeholder. Neither is waved through.
    expect(verdicts.map((v) => v.ok)).toEqual([false, false]);
    expect(verdicts[0].reason).toMatch(/what kind of load/);
    expect(verdicts[1].reason).toMatch(/run time/);
    const dynamic = judge(policy, [{ file: 'f', line: 1, kind: 'frame', url: 'https://${host}/e', how: 'x' }]);
    expect(dynamic[0].ok).toBe(false);
    expect(dynamic[0].reason).toMatch(/run time/);
  });

  it('a policy that lacks the origin fails the verdict', () => {
    const noRzp = parseCsp("default-src 'self'; script-src 'self' 'unsafe-inline'");
    const v = judge(noRzp, findLoads('x.astro', `<script>loadScript('https://checkout.razorpay.com/v1/checkout.js')</script>`));
    expect(v[0].ok).toBe(false);
    expect(v[0].directive).toBe('script-src');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (a) WHAT THE POLICY MUST KEEP
// ════════════════════════════════════════════════════════════════════════════

describe('the policy keeps the protections it had', () => {
  it("default-src is 'self', so anything not named is refused", () => {
    expect(CSP.get('default-src')).toEqual(["'self'"]);
  });

  it("frame-ancestors is 'none': nothing may embed MMAKF", () => {
    expect(CSP.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it("object-src is 'none'", () => {
    expect(CSP.get('object-src')).toEqual(["'none'"]);
  });

  it("base-uri and form-action stay 'self', so an injected <base> or form cannot redirect a submission", () => {
    expect(CSP.get('base-uri')).toEqual(["'self'"]);
    expect(CSP.get('form-action')).toEqual(["'self'"]);
  });

  it("never allows 'unsafe-eval' in any directive", () => {
    expect(CSP_RAW).not.toMatch(/unsafe-eval/);
  });

  it('script-src has no wildcard, no bare scheme and no data:/blob: source', () => {
    const scripts = CSP.get('script-src') ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tok of scripts) {
      expect(tok, `script-src source ${tok}`).not.toBe('*');
      expect(tok, `script-src source ${tok}`).not.toMatch(/^\*\./); // a wildcard host is a wildcard
      expect(tok, `script-src source ${tok}`).not.toMatch(/^(https?|data|blob|wss?|filesystem):$/);
    }
  });

  it('script-src names its third-party origins one by one, and every one is https', () => {
    const hosts = (CSP.get('script-src') ?? []).filter((t) => !t.startsWith("'"));
    expect(hosts.length).toBeGreaterThan(0);
    for (const h of hosts) expect(h, h).toMatch(/^https:\/\/[a-z0-9.-]+$/i);
  });

  it('upgrade-insecure-requests is still on', () => {
    expect(CSP.has('upgrade-insecure-requests')).toBe(true);
  });

  it('the other security headers the Razorpay edit sat beside are untouched', () => {
    expect(headerOf('X-Frame-Options')).toBe('DENY');
    expect(headerOf('X-Content-Type-Options')).toBe('nosniff');
    expect(headerOf('Strict-Transport-Security')).toMatch(/max-age=63072000/);
    expect(headerOf('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('keeps the permissions it denies', () => {
    for (const feature of ['geolocation', 'microphone', 'camera']) {
      expect(PERMISSIONS, feature).toContain(`${feature}=()`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (c) RAZORPAY, IN THE DIRECTIVES THAT GOVERN IT
// ════════════════════════════════════════════════════════════════════════════

describe('Razorpay Checkout is permitted where the browser will ask', () => {
  const has = (directive: string, origin: string) =>
    (CSP.get(directive) ?? []).map((s) => s.toLowerCase()).includes(origin);

  it('script-src: checkout.js itself', () => {
    expect(has('script-src', 'https://checkout.razorpay.com')).toBe(true);
  });

  it('frame-src: the checkout iframe, whichever of the two origins it is served from', () => {
    expect(has('frame-src', 'https://api.razorpay.com')).toBe(true);
    expect(has('frame-src', 'https://checkout.razorpay.com')).toBe(true);
  });

  it('connect-src: the preferences call, the checkout origin and the analytics beacon', () => {
    expect(has('connect-src', 'https://api.razorpay.com')).toBe(true);
    expect(has('connect-src', 'https://checkout.razorpay.com')).toBe(true);
    expect(has('connect-src', 'https://lumberjack.razorpay.com')).toBe(true);
  });

  it('img-src: Razorpay-hosted logos and bank icons', () => {
    expect(has('img-src', 'https://*.razorpay.com')).toBe(true);
  });

  it('the Razorpay origins appear ONLY in those four directives', () => {
    for (const [name, sources] of CSP) {
      if (['script-src', 'frame-src', 'connect-src', 'img-src'].includes(name)) continue;
      expect(sources.join(' '), `${name} should not mention Razorpay`).not.toMatch(/razorpay/i);
    }
  });

  it('permits no Razorpay origin in script-src other than checkout.razorpay.com', () => {
    const razor = (CSP.get('script-src') ?? []).filter((s) => /razorpay/i.test(s));
    expect(razor).toEqual(['https://checkout.razorpay.com']);
  });

  it('Permissions-Policy delegates payment to the page and to Razorpay, and to nobody else', () => {
    const m = PERMISSIONS.match(/(?:^|,)\s*payment=\(([^)]*)\)/);
    expect(m, 'Permissions-Policy has no payment=(…) entry').toBeTruthy();
    const allow = m![1].trim().split(/\s+/).filter(Boolean);
    expect(allow).toContain('self');
    expect(allow).toContain('"https://api.razorpay.com"');
    expect(allow).toContain('"https://checkout.razorpay.com"');
    // Origins are quoted and `self` is a bare token: an unquoted origin is a
    // syntax error that makes the browser DROP the whole feature entry.
    for (const tok of allow) {
      expect(tok === 'self' || /^"https:\/\/[a-z0-9.-]+"$/i.test(tok), `malformed allowlist entry ${tok}`).toBe(true);
    }
    expect(allow.filter((t) => t !== 'self' && !/razorpay\.com"$/.test(t))).toEqual([]);
  });

  it('the header still parses as a policy list: every entry is feature=(…)', () => {
    for (const entry of PERMISSIONS.split(/,(?![^()]*\))/)) {
      expect(entry.trim(), entry).toMatch(/^[a-z-]+=\([^)]*\)$/);
    }
  });

  it('the checkout is the modal flow, so no form-action for Razorpay is needed', () => {
    // callback_url / redirect mode makes checkout.js POST a form to Razorpay, which
    // form-action 'self' would block. Every checkout in the tree uses `handler`.
    const pages = ['src/pages/checkout.astro', 'src/pages/shop/checkout.astro', 'src/pages/pay/[token].astro'];
    for (const p of pages) {
      const src = readFileSync(p, 'utf8');
      expect(src, `${p} loads checkout.js`).toContain('https://checkout.razorpay.com/v1/checkout.js');
      expect(src, `${p} opens the modal with a handler`).toMatch(/handler\s*[:=]/);
      expect(src, `${p} switched to redirect mode — add Razorpay to form-action first`).not.toMatch(/callback_url|redirect\s*:\s*true/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (b) EVERYTHING THE SITE LOADS IS PERMITTED
// ════════════════════════════════════════════════════════════════════════════

/**
 * Loads the policy does NOT permit, on purpose or by omission, each with the
 * reason it is tolerated and what to do about it.
 *
 * AN ENTRY HERE IS A KNOWN GAP, NOT A CLEARANCE. The block "the entries are still
 * gaps" below fails the day the policy is widened, so an entry cannot outlive the
 * thing it excuses.
 */
const KNOWN_BLOCKED: Array<{ file: string; origin: string; kind: Kind; reason: string }> = [
  {
    file: 'src/pages/live.astro',
    origin: 'https://www.youtube-nocookie.com',
    kind: 'frame',
    reason:
      'The live-class player. The page listens for securitypolicyviolation on frame-src and swaps the dead frame for an ' +
      'explanation and a link to the channel, so a blocked frame is a handled state. Embedding it is a policy decision for ' +
      'the federation: to allow it, add https://www.youtube-nocookie.com to frame-src.',
  },
  {
    file: 'src/components/TechnicalPlayer.astro',
    origin: 'https://www.youtube.com',
    kind: 'script',
    reason:
      'The YouTube IFrame API, loaded for the federation\'s own cleared recordings on /shotokan/videos. script-src does not ' +
      'name it, so window.YT never appears and the player never mounts; the component has no fallback for a blocked script. ' +
      'To show them, add https://www.youtube.com to script-src and https://www.youtube.com (and youtube-nocookie.com) to frame-src together.',
  },
];

const SCAN_FILES = [
  ...walk('src/pages', (p) => p.endsWith('.astro')),
  ...walk('src/layouts', (p) => p.endsWith('.astro')),
  ...walk('src/components', (p) => p.endsWith('.astro')),
  ...walk('src/styles', (p) => p.endsWith('.css')),
].filter((p) => !p.startsWith('src/pages/api/'));

const ALL_LOADS = SCAN_FILES.flatMap((f) => findLoads(f, readFileSync(f, 'utf8')));
const VERDICTS = judge(CSP, ALL_LOADS);
const isKnown = (v: Verdict) =>
  KNOWN_BLOCKED.some((k) => k.file === v.load.file && k.origin === v.origin && k.kind === v.load.kind);

describe('every external origin the site loads is permitted by the policy that governs it', () => {
  it('the scan can see the loads this test exists for (it has not gone blind)', () => {
    const has = (file: string, kind: Kind, origin: string) =>
      VERDICTS.some((v) => v.load.file === file && v.load.kind === kind && v.origin === origin);
    // Razorpay: three pages, three different spellings of the same script load.
    expect(has('src/pages/checkout.astro', 'script', 'https://checkout.razorpay.com')).toBe(true);
    expect(has('src/pages/shop/checkout.astro', 'script', 'https://checkout.razorpay.com')).toBe(true);
    expect(has('src/pages/pay/[token].astro', 'script', 'https://checkout.razorpay.com')).toBe(true);
    // And one of each other kind, so a regex that rots is noticed.
    expect(has('src/pages/contact.astro', 'frame', 'https://www.google.com')).toBe(true);
    expect(has('src/pages/live.astro', 'frame', 'https://www.youtube-nocookie.com')).toBe(true);
    expect(has('src/components/TechnicalPlayer.astro', 'script', 'https://www.youtube.com')).toBe(true);
    expect(has('src/pages/index.astro', 'img', 'https://images.unsplash.com')).toBe(true);
    expect(has('src/styles/global.css', 'style', 'https://fonts.googleapis.com')).toBe(true);
  });

  it('every script load — Razorpay included — is permitted by script-src', () => {
    const bad = VERDICTS.filter((v) => v.load.kind === 'script' && !v.ok && !isKnown(v))
      .map((v) => `${v.load.file}:${v.load.line} ${v.load.how} ${v.origin} is not in ${v.governedBy}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('every iframe is permitted by frame-src (or child-src, or default-src)', () => {
    const bad = VERDICTS.filter((v) => v.load.kind === 'frame' && !v.ok && !isKnown(v))
      .map((v) => `${v.load.file}:${v.load.line} ${v.load.how} ${v.origin} is not in ${v.governedBy}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('every client-side connection is permitted by connect-src', () => {
    const bad = VERDICTS.filter((v) => v.load.kind === 'connect' && !v.ok && !isKnown(v))
      .map((v) => `${v.load.file}:${v.load.line} ${v.load.how} ${v.origin} is not in ${v.governedBy}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('every image and stylesheet is permitted by img-src / style-src', () => {
    const bad = VERDICTS.filter((v) => (v.load.kind === 'img' || v.load.kind === 'style') && !v.ok && !isKnown(v))
      .map((v) => `${v.load.file}:${v.load.line} ${v.load.how} ${v.origin} is not in ${v.governedBy}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('nothing is left unclassified or dynamic: a new kind of load needs a decision, not silence', () => {
    const bad = VERDICTS.filter((v) => !v.ok && !isKnown(v) && (v.load.kind === 'unclassified' || v.origin === '(dynamic)'))
      .map((v) => `${v.load.file}:${v.load.line} ${v.load.how} ${v.reason}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

describe('the known gaps are still gaps (delete an entry the day its origin is permitted)', () => {
  for (const known of KNOWN_BLOCKED) {
    it(`${known.file} -> ${known.origin} (${known.kind})`, () => {
      const hit = VERDICTS.filter((v) => v.load.file === known.file && v.origin === known.origin && v.load.kind === known.kind);
      expect(hit.length, 'the load is no longer in the source — delete this entry').toBeGreaterThan(0);
      for (const v of hit) {
        expect(v.ok, `${known.origin} is now permitted by ${v.governedBy}: delete this entry (${known.reason})`).toBe(false);
      }
    });
  }
});
