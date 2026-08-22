// The four surfaces over the identity and location foundation.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE CAN AND CANNOT PROVE, STATED SO NOBODY OVER-READS IT
// ─────────────────────────────────────────────────────────────────────────────
//
// The DECISIONS these screens take are already covered against a real Postgres
// in tests/identity.test.ts — that a reason is required, that a self-decision is
// refused, that an approval over a moved record is refused, that a merge
// decision merges nothing. None of that is re-tested here; a second copy would
// drift from the first.
//
// What is NOT covered there is the WIRING: whether a page that renders those
// decisions gates itself on the right action, surfaces the module's refusals
// instead of a 500, and tells the reader the truth about what a control does.
// A page can satisfy every domain test and still be a hole, because the domain
// function is not what an administrator interacts with.
//
// Two techniques, and the difference matters:
//
//  · src/pages/api/geography/resolve.ts is a MODULE. Its GET handler is imported
//    and called with real Requests. Those are behavioural assertions.
//  · The .astro pages cannot be imported and executed here, so they are read as
//    SOURCE — the same technique tests/portal.test.ts and tests/layout-guards.ts
//    already use. A source assertion is weaker than an execution: it proves a
//    call is present, not that it is reached on every path. Where that weakness
//    matters it is said in the test's own words, and tests/routes-live.test.ts
//    fetches these routes over HTTP for the part this cannot reach.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { GET } from '../src/pages/api/geography/resolve';
import { GUARDIAN_CAPABILITIES } from '../src/db/identity';
import { ADMIN_GROUPS } from '../src/lib/surface';

const read = (p: string) => readFileSync(p, 'utf8');

const DUPLICATES = 'src/pages/admin/duplicates.astro';
const CHANGES = 'src/pages/admin/profile-changes.astro';
const FAMILY = 'src/pages/my/family.astro';
const RESOLVE = 'src/pages/api/geography/resolve.ts';

const req = (qs: string) =>
  new Request(`https://admin.mmakf.in/api/geography/resolve${qs}`, { method: 'GET' });

/** The endpoint takes an Astro context; only `request` and `url` are read. */
const call = (qs: string) => {
  const request = req(qs);
  return (GET as any)({ request, url: new URL(request.url) });
};

// ─── The routes exist and are reachable from the menu ───────────────────────

describe('the surfaces exist and the menu offers them', () => {
  it('every file is on disk', () => {
    for (const f of [DUPLICATES, CHANGES, FAMILY, RESOLVE]) {
      expect(existsSync(f), `${f} is missing`).toBe(true);
    }
  });

  it('/my/family is reachable — a page nobody can navigate to is an orphan', () => {
    // It shipped as one. `guardianCan()` was wired correctly and no file in the
    // repository linked to the page, so the only way to reach it was to type
    // the path. A surface that cannot be navigated to has not been delivered.
    const linkers = ['src/pages/my/index.astro', 'src/lib/surface.ts', 'src/pages/portal/_sections.ts']
      .filter((f) => existsSync(f))
      .filter((f) => read(f).includes('/my/family'));

    expect(linkers.length, '/my/family is linked from nowhere').toBeGreaterThan(0);
  });

  it('offers the family link ONLY to somebody who has dependants', () => {
    // A permanent "My family" button would tell every member the federation
    // believes they have dependants, and would lead to an empty page — which
    // reads as a fault in their account rather than as the absence of a
    // relationship.
    const s = read('src/pages/my/index.astro');
    expect(s).toMatch(/dependants\s*>\s*0/);
    expect(s).toMatch(/dependantsOf\(/);
  });

  it('the admin menu offers both queues, each gated on its own action', () => {
    const modules = ADMIN_GROUPS.flatMap((g) => g.modules);
    const dup = modules.find((m) => m.href === '/admin/duplicates');
    const chg = modules.find((m) => m.href === '/admin/profile-changes');

    expect(dup, 'the duplicate queue is not in the admin menu').toBeTruthy();
    expect(chg, 'the profile-change queue is not in the admin menu').toBeTruthy();

    // NOT 'person:write'. Every dojo administrator holds that so they can
    // correct a telephone number, and neither of these is that kind of act.
    expect(dup!.action).toBe('duplicate:review');
    expect(chg!.action).toBe('profilechange:decide');
  });
});

// ─── /admin/duplicates ──────────────────────────────────────────────────────

describe('/admin/duplicates', () => {
  const src = () => read(DUPLICATES);

  it('gates the page on duplicate:review', () => {
    expect(src()).toMatch(/requires=["']duplicate:review["']/);
  });

  it('re-checks authority in the POST handler rather than trusting the render', () => {
    // A hidden control is not a control. The rendered page may be minutes old,
    // the reader's bindings may have been withdrawn, and the request may not
    // have come from the page at all.
    const s = src();
    expect(s).toMatch(/canAnywhere\(\s*identity!?\.principal,\s*'duplicate:review'\s*\)/);
    expect(s).toMatch(/mayReview/);
  });

  it('STATES that recording a merge merges nothing', () => {
    // The single most important sentence on the page. decideDuplicate() accepts
    // 'merged' and performs no merge — an administrator who presses it and
    // believes two records were combined has been misled BY THIS PAGE.
    const s = src();
    expect(s).toMatch(/does not combine any records/i);
    // And the control must not be labelled as though it performs one.
    expect(s).toMatch(/record a merge decision/i);
  });

  it('renders WHICH signals fired, not only the score', () => {
    // A reviewer declaring two records one human needs to see that it was a
    // verified telephone and a date of birth, not two common names.
    const s = src();
    expect(s).toMatch(/SIGNAL_WORDS/);
    expect(s).toMatch(/verified_phone/);
    expect(s).toMatch(/name_and_area/);
    expect(s).toMatch(/Why these two were raised/i);
  });

  it('requires a reason in the form itself, not only in the module', () => {
    expect(src()).toMatch(/name="reason"[\s\S]{0,200}required/);
  });

  it('surfaces an IdentityError as a message rather than a 500', () => {
    const s = src();
    expect(s).toMatch(/isIdentityError\(err\)/);
    // 500 is reserved for a fault that is genuinely the server's.
    expect(s).toMatch(/Nothing was changed\./);
  });

  it('does not filter the queue in JavaScript', () => {
    // duplicateQueue() filters in SQL via visibleScopes(). A .filter() over the
    // returned rows would mean the rows had already been read.
    const s = src();
    expect(s).toMatch(/duplicateQueue\(/);
    expect(s).not.toMatch(/rows\.filter\(/);
  });
});

// ─── /admin/profile-changes ─────────────────────────────────────────────────

describe('/admin/profile-changes', () => {
  const src = () => read(CHANGES);

  it('gates the page on profilechange:decide', () => {
    expect(src()).toMatch(/requires=["']profilechange:decide["']/);
  });

  it('warns that the record moved BEFORE the reviewer presses approve', () => {
    // decideProfileChange() refuses this case, but a refusal after the click is
    // a worse experience than a warning before it — and the warning is what
    // stops a reviewer believing the queue is broken.
    const s = src();
    expect(s).toMatch(/moved/);
    expect(s).toMatch(/has moved since this request was filed/i);
    expect(s).toMatch(/currentValue/);
  });

  it('withholds the control on the reviewer’s own request, and says why', () => {
    // The module refuses a self-decision, so offering the control would be
    // offering a button that always errors. Said, never silently hidden.
    const s = src();
    expect(s).toMatch(/isMine/);
    expect(s).toMatch(/must be decided by somebody else/i);
  });

  it('reports whether an approval was actually APPLIED', () => {
    // Approval and application are two facts: the module declines to write over
    // a record that moved. A page reporting only "approved" would let a reader
    // believe a change happened that did not.
    const s = src();
    expect(s).toMatch(/approved_not_applied/);
    expect(s).toMatch(/out\.applied/);
  });

  it('explains why these fields are governed at all', () => {
    const s = src();
    expect(s).toMatch(/competition age category/i);
    expect(s).toMatch(/national squad/i);
  });

  it('requires a reason in the form itself', () => {
    expect(src()).toMatch(/name="reason"[\s\S]{0,200}required/);
  });
});

// ─── /my/family ─────────────────────────────────────────────────────────────

describe('/my/family — the guardian surface', () => {
  const src = () => read(FAMILY);

  it('asks guardianCan() and never the PARENT role', () => {
    const s = src();
    expect(s).toMatch(/guardianCan\(/);
    // The role may be MENTIONED in prose explaining why it is not consulted;
    // what must not appear is a branch that reads it.
    expect(s).not.toMatch(/can\((?:[^)]*),\s*['"]PARENT['"]/);
    expect(s).not.toMatch(/role\s*===\s*['"]PARENT['"]/);
  });

  it('accepts no identifier that could select another family', () => {
    // The strongest form of the control: a request that cannot express "show me
    // somebody else's children" needs no check to refuse one.
    const s = src();
    expect(s).not.toMatch(/searchParams\.get\(\s*['"](personId|person|child|subject|id)['"]/);
  });

  it('reads dependants through dependantsOf(), which is verified-only', () => {
    expect(src()).toMatch(/dependantsOf\(/);
  });

  it('distinguishes a withheld capability from absent data', () => {
    // Rendering an empty attendance panel for a capability nobody granted is a
    // lie: "you may not see this" and "there is nothing here" are different
    // facts, and conflating them is exactly what the capability table exists to
    // prevent being invisible.
    const s = src().toLowerCase();
    const saysWithheld =
      /not been granted/.test(s) || /do(es)? not hold/.test(s) || /withheld/.test(s);
    expect(saysWithheld, 'the page never tells a guardian that a capability was withheld').toBe(true);
  });

  it('grants nothing — a guardian cannot widen their own access here', () => {
    // A guardian who could grant themselves a capability is the escalation
    // guardian_authorizations exists to prevent.
    //
    // The check is against CODE, not against the text of the file: the page
    // names grantGuardianCapability() in a comment explaining why it is absent,
    // and a test that failed on that would be punishing the file for explaining
    // itself. So comment lines are stripped first, and what must not appear is
    // an import of the function or a call to it.
    const code = src()
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n');

    expect(code).not.toMatch(/grantGuardianCapability\s*\(/);
    expect(code).not.toMatch(/import[\s\S]{0,200}grantGuardianCapability/);
  });

  it('covers capabilities that all exist in the domain model', () => {
    // A page checking a capability the module has never heard of would fail
    // closed for ever and look like a permissions bug.
    const s = src();
    const referenced = [...s.matchAll(/capability:\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);
    for (const c of referenced) {
      expect(GUARDIAN_CAPABILITIES as readonly string[]).toContain(c);
    }
  });
});

// ─── /api/geography/resolve — executed, not merely read ─────────────────────

describe('the geography endpoint', () => {
  it('is unauthenticated BY DESIGN and says so, and is rate limited', () => {
    const s = read(RESOLVE);
    expect(s).toMatch(/rateLimit\(/);
    // There is deliberately no geo:read action; the file must justify that
    // rather than leave a reader to assume the gate was forgotten.
    expect(s).toMatch(/unauthenticated/i);
    expect(s).not.toMatch(/assertCan|canAnywhere/);
  });

  it('reads only the map, never a person', () => {
    const s = read(RESOLVE);
    // `addresses` holds where people live. It is shaped like geography and is
    // data about a person, and this endpoint must not be able to reach it.
    expect(s).not.toMatch(/g\.addresses/);
    expect(s).not.toMatch(/persons/);
  });

  it('reports "not configured" as a fallback instruction, not as an error', async () => {
    // The deployment under test has no DATABASE_URL. Nothing failed and
    // retrying changes nothing, so a 5xx would be a lie — and a form needs to
    // know to fall back to free text.
    const res = await call('?op=countries');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.loaded).toBe(false);
    expect(body.reason).toBe('not_configured');
  });

  it('never sets a shared cache header — the answer varies by query', async () => {
    const res = await call('?op=countries');
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
  });

  it('forwards ambiguity instead of choosing, and orders nothing', () => {
    // The behaviour the whole location engine is built around. resolveArea()
    // returns 'ambiguous'; a resolver that picked one files a member a level off
    // and shows nobody an error. Asserted on source because reaching the branch
    // needs a loaded register, which tests/geography.test.ts already exercises
    // against a real Postgres.
    const s = read(RESOLVE);
    expect(s).toMatch(/status:\s*['"]ambiguous['"]/);
    expect(s).toMatch(/candidates:\s*r\.candidates\.map\(shape\)/);
    // No sort, slice or [0] on the candidate list anywhere.
    expect(s).not.toMatch(/candidates\s*\[\s*0\s*\]/);
    expect(s).not.toMatch(/candidates\.sort\(/);
  });

  it('does not leak a driver fault to the caller', () => {
    const s = read(RESOLVE);
    expect(s).toMatch(/could not be read/);
    expect(s).toMatch(/console\.error/);
  });
});
