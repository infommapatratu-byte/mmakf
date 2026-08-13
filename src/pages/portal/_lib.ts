// Shared helpers for the portal pages.
//
// Underscore-prefixed so Astro does not route it, and a .ts file rather than an
// .astro partial so tests/accessibility.test.ts is not asked to find an <h1> in
// a fragment.
//
// Everything here is either presentation (dates, money, labels) or a pure
// parser. NO AUTHORISATION LIVES IN THIS FILE. Authorisation is asked of
// src/lib/rbac.ts by the module that performs the act, on the server, on every
// request — putting even a convenience copy of it here would create a second
// answer to a question that must only have one.

import { eq, inArray } from 'drizzle-orm';
import * as s from '@/db/schema';
import type { ScopeType } from '@/lib/rbac';
import { ForbiddenError } from '@/lib/rbac';
import { isOnboardingError } from '@/db/onboarding';
import { isMarketplaceError } from '@/db/marketplace';

type DB = any;

/**
 * What a caller may be told about a failure.
 *
 * The onboarding and marketplace modules write their refusals to be read by the
 * person who hit them, so those are printed verbatim — rewording them here is
 * how the portal and the office start disagreeing about why something was
 * refused. Anything else is a fact about the server, not about the caller, and
 * `err.message` on a page is how a connection string reaches a stranger.
 *
 * Copied in spirit from readableError() in src/pages/my/index.astro, which set
 * this house rule.
 */
export function readableError(err: any, context: string): string {
  if (isOnboardingError(err) || isMarketplaceError(err)) return String(err.message);
  if (err instanceof ForbiddenError) {
    return (
      `The federation’s permission rules do not allow this account to perform "${err.action}" here. ` +
      'The check ran on the server against your bindings; nothing has been changed.'
    );
  }
  console.error(`[portal] ${context}`, err);
  return `${context} could not be completed. The fault has been logged for the federation office; nothing has been changed.`;
}

// ─── Dates ──────────────────────────────────────────────────────────────────

export function fmtDate(v: unknown): string {
  if (v == null || v === '') return '—';
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime())
    ? String(v)
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(v: unknown): string {
  if (v == null || v === '') return '—';
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime())
    ? String(v)
    : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const titleCase = (v: unknown): string => String(v ?? '').replace(/_/g, ' ');

// ─── Money ──────────────────────────────────────────────────────────────────

// ONLY ONE DIRECTION IS DONE HERE. Rupees become paise in exactly one place in
// this codebase — rupeesToPaise() in src/pages/api/marketplace/[...action].ts,
// on the server, where no browser can decide what a price means. A convenience
// copy lived here once and did the arithmetic its own way; two ways of reading
// a price is how the same typed figure reaches two different columns, so it was
// removed rather than kept in step.

/** Integer paise -> the string a form field should be pre-filled with. */
export function paiseToRupeeInput(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.round(paise));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ─── Scopes ─────────────────────────────────────────────────────────────────

export interface ScopeRef {
  scopeType: string;
  scopeId: number | null;
}

/**
 * Human names for a set of (scopeType, scopeId) pairs, in as few queries as
 * possible. A binding rendered as "state 7" tells a state secretary nothing
 * about whether it is their state.
 *
 * A name that cannot be resolved renders as the raw pair rather than as blank —
 * a binding pointing at a unit that no longer exists is a fact worth seeing.
 */
export async function scopeNames(db: DB, refs: readonly ScopeRef[]): Promise<Map<string, string>> {
  const key = (t: string, id: number | null) => `${t}:${id ?? ''}`;
  const out = new Map<string, string>();

  const ids = (type: string) =>
    [...new Set(refs.filter((r) => r.scopeType === type && r.scopeId != null).map((r) => r.scopeId as number))];

  const states = ids('state');
  const districts = ids('district');
  const dojos = ids('dojo');

  if (states.length) {
    for (const row of await db.select({ id: s.stateUnits.id, name: s.stateUnits.name, code: s.stateUnits.code })
      .from(s.stateUnits).where(inArray(s.stateUnits.id, states))) {
      out.set(key('state', row.id), `${row.name} (${row.code})`);
    }
  }
  if (districts.length) {
    for (const row of await db.select({ id: s.districtUnits.id, name: s.districtUnits.name, code: s.districtUnits.code })
      .from(s.districtUnits).where(inArray(s.districtUnits.id, districts))) {
      out.set(key('district', row.id), `${row.name} (${row.code})`);
    }
  }
  if (dojos.length) {
    for (const row of await db.select({ id: s.dojos.id, name: s.dojos.name, code: s.dojos.code })
      .from(s.dojos).where(inArray(s.dojos.id, dojos))) {
      out.set(key('dojo', row.id), `${row.name} (${row.code})`);
    }
  }

  for (const r of refs) {
    if (r.scopeType === 'national') out.set(key('national', r.scopeId), 'National — the whole federation');
  }
  return out;
}

export function scopeLabel(names: Map<string, string>, scopeType: string, scopeId: number | null): string {
  if (scopeType === 'national') return 'National — the whole federation';
  return names.get(`${scopeType}:${scopeId ?? ''}`) ?? `${titleCase(scopeType)} #${scopeId ?? '—'}`;
}

// ─── Unit pickers ───────────────────────────────────────────────────────────

export interface UnitOption {
  scopeType: ScopeType;
  scopeId: number;
  label: string;
}

/**
 * The units an application may name, for the scope picker.
 *
 * Capped, and honest about the cap. This is a convenience list, not an
 * authorisation boundary — applyForRole() proves the named unit exists on the
 * server, and a scope typed by hand gains nothing.
 */
export async function unitOptions(db: DB, cap = 300): Promise<{ options: UnitOption[]; capped: boolean }> {
  const options: UnitOption[] = [];

  for (const row of await db.select({ id: s.stateUnits.id, name: s.stateUnits.name, code: s.stateUnits.code })
    .from(s.stateUnits).orderBy(s.stateUnits.name).limit(cap)) {
    options.push({ scopeType: 'state', scopeId: row.id, label: `State — ${row.name} (${row.code})` });
  }
  for (const row of await db.select({ id: s.districtUnits.id, name: s.districtUnits.name, code: s.districtUnits.code })
    .from(s.districtUnits).orderBy(s.districtUnits.name).limit(cap)) {
    options.push({ scopeType: 'district', scopeId: row.id, label: `District — ${row.name} (${row.code})` });
  }
  for (const row of await db.select({ id: s.dojos.id, name: s.dojos.name, code: s.dojos.code })
    .from(s.dojos).orderBy(s.dojos.name).limit(cap)) {
    options.push({ scopeType: 'dojo', scopeId: row.id, label: `Dojo — ${row.name} (${row.code})` });
  }

  return { options, capped: options.length >= cap };
}

/** The signed-in account's own person row, resolved from the session only. */
export async function ownPerson(db: DB, userId: number | null) {
  if (userId == null) return null;
  const user = (await db.select({ personId: s.users.personId }).from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
  if (!user?.personId) return null;
  return (await db.select().from(s.persons).where(eq(s.persons.id, user.personId)).limit(1))[0] ?? null;
}

// ─── Form reading ───────────────────────────────────────────────────────────

/** A trimmed string field, or null when the field was blank or absent. */
export function field(form: FormData, name: string): string | null {
  const raw = form.get(name);
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text ? text : null;
}

/** A positive integer field, or null. Never NaN, never a float. */
export function intField(form: FormData, name: string): number | null {
  const text = field(form, name);
  if (text == null) return null;
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}
