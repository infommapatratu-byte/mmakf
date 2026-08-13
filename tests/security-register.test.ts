// The risk register is read to decide what to build next. It has to be right
// about WHEN a risk starts, not only about what the risk is.
//
// THE DEFECT THIS SUITE EXISTS TO STOP COMING BACK. §8 of
// docs/SECURITY-ARCHITECTURE.md listed Postgres row-level security as
// "relevant once more than one system touches the database", and left its
// queue cell as an em dash while MFA, backups, uploads, observability and the
// WCAG audit all carried Q-numbers. Both halves pushed the same way. A
// maintainer choosing the next task reads a gap described as conditional on a
// future event, sees it is the only unscheduled row, and defers it — which is
// exactly what happened, and it was wrong the moment the federation
// provisioned a managed Postgres that ships PostgREST. The second system is
// installed by the provider, is internet-facing from the first minute, and
// never touches src/lib/rbac.ts.
//
// So this file asserts two things a prose review keeps missing:
//   · no gap is unscheduled — an em dash is how an item disappears;
//   · the row states the trigger as fired, names the system that fired it,
//     names the migration that closes the schema, and does NOT claim anything
//     about the federation's own project, which nobody here has connected to.
//
// The schema half of the defence is measured in tests/data-api-lockdown.test.ts.
// This file is about the document, because the document is what decides
// whether anyone looks.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const DOC = 'docs/SECURITY-ARCHITECTURE.md';
const text = readFileSync(DOC, 'utf8');

/** The §8 gap table: three-column rows whose first cell is bold. */
const gapRows = text
  .split('\n')
  .filter((l) => /^\|\s*\*\*/.test(l) && l.split('|').length === 5);

const cell = (row: string, n: number) => (row.split('|')[n] ?? '').trim();
const rlsRow = gapRows.find((l) => /row-level security/i.test(l)) ?? '';

describe('the gap register schedules every gap it lists', () => {
  it('found the register', () => {
    // If this fails the table moved or changed shape, and every assertion
    // below became vacuous without anyone noticing.
    expect(gapRows.length, `${DOC} §8 gap table not found`).toBeGreaterThanOrEqual(5);
  });

  it('gives every gap a queue number', () => {
    const unscheduled = gapRows.filter((l) => !/Q-\d+/.test(cell(l, 3))).map((l) => cell(l, 1));
    expect(
      unscheduled,
      'a gap with no queue number is not scheduled against anything and will be deferred forever',
    ).toEqual([]);
  });

  it('does not reuse a queue number between two gaps', () => {
    // Two rows sharing a number means one of them is not actually tracked.
    const numbers = gapRows.map((l) => (cell(l, 3).match(/Q-\d+/) ?? [''])[0]);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe('the row-level-security gap is stated as live, not as a future condition', () => {
  it('is still listed', () => {
    expect(rlsRow, `${DOC} no longer carries a row-level-security row`).not.toBe('');
  });

  it('no longer makes the second system a condition that has yet to be met', () => {
    // The exact sentence that caused the deferral, in either of the forms the
    // two architecture documents used.
    expect(rlsRow).not.toMatch(/once (more than one|a second) system/i);
    expect(text).not.toMatch(/relevant once more than one system touches the database/i);
  });

  it('names the system that is already there', () => {
    expect(`${rlsRow}\n${text}`).toMatch(/PostgREST/);
    expect(rlsRow).toMatch(/Data API/i);
  });

  it('names the migration that closes the schema, and that migration exists', () => {
    // A register that cites a fix which is not in the tree is worse than one
    // that cites none: it reads as done.
    const cited = rlsRow.match(/\b0010\b/);
    expect(cited, 'the row must name the lockdown migration').not.toBeNull();
    const files = readdirSync('drizzle').filter((f) => /^0010.*\.sql$/.test(f));
    expect(files.length, 'no drizzle/0010*.sql exists, so the row cites nothing').toBeGreaterThan(0);
  });

  it('asks the operator to verify rather than asserting what was never measured', () => {
    // §2 of PROJECT-CONTEXT: never state a measurement that was not taken. No
    // database password has been supplied, so the register cannot say what the
    // federation's project is currently configured to do — only that it must
    // be checked before DATABASE_URL is pointed at it.
    expect(rlsRow).toMatch(/unverified|verif/i);
  });

  it('does not publish the project ref, whose endpoint is derived from it', () => {
    // The vendor's anonymous key is publishable; the endpoint address is the
    // other half. Until the lockdown has been verified against the real
    // project there is nothing to gain from committing the address to a
    // repository, and something to lose.
    expect(text).not.toMatch(/srmlqtdntkizxwnkttvz/i);
  });
});

describe('the section behind the row carries the evidence and its limits', () => {
  const section = (() => {
    const start = text.indexOf('### 8.1');
    expect(start, `${DOC} §8.1 is missing; the row points at nothing`).toBeGreaterThan(-1);
    const rest = text.slice(start);
    const end = rest.indexOf('\n---');
    return end === -1 ? rest : rest.slice(0, end);
  })();

  it('says why the application policy layer does not cover this path', () => {
    expect(section).toMatch(/rbac\.ts/);
    expect(section).toMatch(/over HTTP/i);
  });

  it('states what was measured, with the numbers that were actually taken', () => {
    // 117 tables / 0 RLS / 0 policies was measured on a real Postgres engine
    // with every migration applied. The register previously implied a
    // different schema size entirely.
    expect(section).toMatch(/117 tables/);
    expect(section).toMatch(/0 policies/);
  });

  it('separates what was measured from what was not', () => {
    expect(section).toMatch(/NOT been measured|not been measured/);
    expect(section).toMatch(/no database password|No database password/i);
  });

  it('gives the operator a query to run, not an assurance to accept', () => {
    // A step that says "make sure the Data API is off" is checked by opinion.
    // A step that pastes SQL and reads the row count is checked by Postgres.
    expect(section).toMatch(/aclexplode/);
    expect(section).toMatch(/pg_default_acl/);
    expect(section).toMatch(/relrowsecurity/);
  });

  it('warns that a later migration reopens the RLS half', () => {
    // ENABLE ROW LEVEL SECURITY is per-table. A migration adding a table adds
    // it unsecured, and only a test notices.
    expect(section).toMatch(/per-table|every new migration|Re-verify/i);
  });

  it('does not recommend FORCE, which would lock the federation out', () => {
    expect(section).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(section).toMatch(/deliberately \*\*not\*\* set|not\*\* set|owner is exempt/i);
  });
});
