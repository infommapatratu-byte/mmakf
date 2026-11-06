// Every empty state names a way forward — and a page never crashes for lack of one.
//
// THE OUTAGE THIS PINS. /clubs rendered <EmptyState> without its required
// `action` prop, and EmptyState read `action.href`. Production holds no clubs
// yet, so the empty branch ran on every visit and the page died mid-stream:
// "Cannot read properties of undefined (reading 'href')", 24 times in a day,
// on every deployment. The Props type says `action` is required, but .astro
// files are not type-checked in CI, so nothing caught it. This scan does.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.astro')) out.push(p);
  }
  return out;
}

describe('every <EmptyState> passes an action', () => {
  it('no call omits the required action prop', () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const f of walk('src')) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/<EmptyState\b([\s\S]*?)\/>/g)) {
        calls++;
        const rel = f.split('\\').join('/');
        // Admin screens: the component guard keeps them from crashing; each still
        // owes a real way forward and is counted in the next test until it has one.
        if (rel.startsWith('src/pages/admin/')) continue;
        if (!/\baction=/.test(m[1])) offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(calls).toBeGreaterThan(0);
    expect(offenders, 'these empty states would crash the page (action.href of undefined)').toEqual([]);
  });

  it('admin screens still owing an action are counted, and none can crash (the component guard)', () => {
    // timetable, policy, technical-library and schedules render EmptyState
    // without an action. Since the guard they render fine; giving each a real
    // way forward is outstanding work. This number may only go down.
    let missing = 0;
    for (const f of walk('src/pages/admin')) {
      for (const m of readFileSync(f, 'utf8').matchAll(/<EmptyState\b([\s\S]*?)\/>/g)) {
        if (!/\baction=/.test(m[1])) missing++;
      }
    }
    expect(missing).toBeLessThanOrEqual(19);
  });

  it('the component itself survives a missing action instead of crashing the page', () => {
    const c = readFileSync('src/components/states/EmptyState.astro', 'utf8');
    expect(c).toMatch(/action\s*&&|action\?\./);
  });
});
