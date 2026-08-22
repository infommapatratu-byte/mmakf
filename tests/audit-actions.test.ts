// Every audit action a script writes must exist in the audit_action enum.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FAILURE THIS CATCHES, WHICH COST A FEDERATION ITS ADMIN CONSOLE
// ─────────────────────────────────────────────────────────────────────────────
//
// scripts/reset-password.ts wrote action = 'password_reset' into audit_events.
// audit_action did not hold that value, so Postgres rejected the INSERT — and
// because the audit row is written inside the SAME transaction as the password
// update (deliberately: one account or none), THE PASSWORD UPDATE ROLLED BACK
// WITH IT. Every reset appeared to run and changed nothing.
//
// It was invisible from every direction. The script printed the credential it
// had generated, under "probably NOT changed". The sign-in console answered the
// unchanged password with "Invalid email or password", the same words it uses
// for an unknown address. The only trace was users.session_epoch never leaving
// zero, and nothing read that until scripts/user-status.ts was written.
//
// Type-checking cannot catch it: these are raw postgres.js template literals, so
// the action is a string in a string. This test reads the strings back out and
// holds them to the enum the migrations actually build.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

/** The enum as the MIGRATIONS build it — not as schema.ts declares it. The two
 *  drifting apart is the same class of bug one level up. */
let enumValues: string[] = [];

beforeAll(async () => {
  const db = new PGlite();
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const s = stmt.trim();
      if (s) { try { await db.exec(s); } catch { /* already applied */ } }
    }
  }
  const r = await db.query<{ v: string }>(
    `SELECT e.enumlabel AS v FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'audit_action'`);
  enumValues = r.rows.map((x) => x.v);
  await db.close();
}, 120_000);

/** Action literals in raw `INSERT INTO audit_events (...) VALUES (...)` blocks. */
function scriptActions(): Array<{ file: string; action: string }> {
  const out: Array<{ file: string; action: string }> = [];
  for (const f of readdirSync('scripts').filter((x) => /\.(ts|mjs)$/.test(x))) {
    const src = readFileSync(`scripts/${f}`, 'utf8');
    const blocks = src.match(/INSERT INTO audit_events[\s\S]{0,600}?`/g) || [];
    for (const b of blocks) {
      // The action is the fourth VALUES column: label, entityType, entityId, action.
      const m = b.match(/VALUES\s*\([^)]*?'([a-z_]+)'\s*,[\s\S]*?\$\{[^}]*\}\s*,\s*'([a-z_]+)'/);
      if (m) out.push({ file: `scripts/${f}`, action: m[2] });
    }
  }
  return out;
}

describe('audit actions written by scripts exist in the enum', () => {
  it('the enum was actually read', () => {
    expect(enumValues.length, 'audit_action enum not found in the migrated schema').toBeGreaterThan(5);
    expect(enumValues).toContain('create');
  });

  it('password_reset is a member — the value whose absence rolled back every reset', () => {
    expect(enumValues).toContain('password_reset');
  });

  it('every action literal in scripts/ is a member', () => {
    const found = scriptActions();
    expect(found.length, 'no audit inserts found — the scanner has stopped matching').toBeGreaterThan(0);
    for (const { file, action } of found) {
      expect(enumValues, `${file} writes audit action "${action}", which audit_action does not hold`)
        .toContain(action);
    }
  });
});
