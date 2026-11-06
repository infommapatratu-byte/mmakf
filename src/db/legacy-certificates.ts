// Historical certificates: bringing the federation's past into the register, honestly.
//
// Many members hold certificates issued before this system existed, each with
// its own number. They belong in the SAME register as new certificates
// (`certificates`), so a holder sees them in their member area and anyone can
// check the number at /verify — not in a side list nobody reads.
//
// HONESTY IS THE DESIGN CONSTRAINT. These were not examined through this
// system, so every imported certificate is stamped `provenance:
// 'unverified_legacy'` in its snapshot, and /verify says so in public, in the
// federation's own words (src/pages/api/verify.ts NOTE.unverified_legacy). The
// original number is kept exactly as printed; nothing is renumbered.
//
// NO DUPLICATE PEOPLE. A holder is matched to the register by member ID, or by
// exact name AND date of birth. Only when neither finds anyone is a record
// created — once per holder (idempotent source ref), so five old certificates
// of one person make one person, and a re-import makes nothing new. An
// ambiguous row (two people share the name and birth date, or a name alone
// matches someone already registered) is refused with the fix, never guessed.
//
// IDEMPOTENT. A certificate number already in the register is skipped, never
// overwritten. Running the same file twice changes nothing.

import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { createPersonForSource, writeAudit, type AuditContext } from '@/db/federation';
import { assertCanAnywhere } from '@/lib/rbac';

type DB = any;

export const MAX_ROWS = 2000;

export type CertificateKind =
  | 'kyu_grade' | 'dan_grade' | 'instructor' | 'examiner' | 'official'
  | 'course_completion' | 'affiliation' | 'event_participation' | 'other';

export interface LegacyRow {
  line: number;
  certificateNo: string;
  holderName: string;
  dob: string | null;
  memberId: string | null;
  kind: CertificateKind;
  title: string;
  issuedOn: string;
  issuingAuthority: string;
  notes: string | null;
}

export interface PlannedRow {
  line: number;
  certificateNo: string;
  holderName: string;
  title: string;
  issuedOn: string;
  kind: CertificateKind;
  outcome: 'import' | 'exists' | 'error';
  holder: 'member_id' | 'name_and_dob' | 'new_record' | null;
  federationId: string | null;
  error: string | null;
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/** RFC 4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

const HEADERS: Record<keyof Omit<LegacyRow, 'line'>, string[]> = {
  certificateNo: ['certificate_no', 'certificate no', 'certificate number', 'cert no', 'cert_no', 'certificate', 'number'],
  holderName: ['holder_name', 'holder name', 'name', 'full name', 'student name', 'holder'],
  dob: ['date_of_birth', 'date of birth', 'dob', 'birth date'],
  memberId: ['member_id', 'member id', 'federation_id', 'federation id', 'membership id', 'membership_id'],
  kind: ['kind', 'type', 'category'],
  title: ['title', 'grade', 'rank', 'belt', 'certificate title'],
  issuedOn: ['issued_on', 'issued on', 'issue date', 'date of issue', 'issued', 'awarded on', 'date'],
  issuingAuthority: ['issuing_authority', 'issuing authority', 'issued by', 'authority', 'issuer'],
  notes: ['notes', 'remarks', 'note'],
};

/** A date as YYYY-MM-DD from YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY or DD.MM.YYYY; null if not a real date. */
export function parseDate(v: string): string | null {
  const t = String(v ?? '').trim();
  let y: number, m: number, d: number;
  let mt = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
  else return null;
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  if (y < 1950 || y > 2100) return null;
  return iso;
}

export function kindOf(kindText: string, title: string): CertificateKind {
  const k = `${kindText} `.toLowerCase().trim();
  const t = title.toLowerCase();
  if (/^dan|black belt|dan grade/.test(k)) return 'dan_grade';
  if (/^kyu|belt|kyu grade/.test(k)) return 'kyu_grade';
  if (/instructor|coach/.test(k)) return 'instructor';
  if (/examiner/.test(k)) return 'examiner';
  if (/referee|judge|official/.test(k)) return 'official';
  if (/course/.test(k)) return 'course_completion';
  if (/affiliat/.test(k)) return 'affiliation';
  if (/event|tournament|participation|championship/.test(k)) return 'event_participation';
  if (k) return 'other';
  if (/\b(dan|shodan|nidan|sandan|yondan|godan|rokudan|nanadan|hachidan|black belt)\b/.test(t)) return 'dan_grade';
  if (/\b(kyu|belt)\b/.test(t)) return 'kyu_grade';
  return 'other';
}

/** Rows from CSV text, or the reasons the file cannot be read. */
export function readLegacyCsv(text: string): { rows: LegacyRow[]; errors: string[] } {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], errors: ['The file needs a header row and at least one certificate.'] };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col: Partial<Record<keyof typeof HEADERS, number>> = {};
  for (const [key, names] of Object.entries(HEADERS) as Array<[keyof typeof HEADERS, string[]]>) {
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) col[key] = i;
  }
  const missing = (['certificateNo', 'holderName', 'title', 'issuedOn'] as const).filter((k) => col[k] == null);
  if (missing.length) {
    return { rows: [], errors: [`Missing column(s): ${missing.map((k) => HEADERS[k][0]).join(', ')}. The header row must name them.`] };
  }
  if (table.length - 1 > MAX_ROWS) return { rows: [], errors: [`At most ${MAX_ROWS} certificates per import. Split the file.`] };
  const get = (r: string[], k: keyof typeof HEADERS) => (col[k] == null ? '' : String(r[col[k]!] ?? '').trim());
  const rows: LegacyRow[] = table.slice(1).map((r, i) => {
    const title = get(r, 'title');
    return {
      line: i + 2,
      certificateNo: get(r, 'certificateNo').replace(/\s+/g, ' '),
      holderName: get(r, 'holderName').replace(/\s+/g, ' '),
      dob: get(r, 'dob') ? parseDate(get(r, 'dob')) ?? `INVALID:${get(r, 'dob')}` : null,
      memberId: get(r, 'memberId') ? get(r, 'memberId').toUpperCase() : null,
      kind: kindOf(get(r, 'kind'), title),
      title,
      issuedOn: parseDate(get(r, 'issuedOn')) ?? `INVALID:${get(r, 'issuedOn')}`,
      issuingAuthority: get(r, 'issuingAuthority') || 'MMAKF',
      notes: get(r, 'notes') || null,
    };
  });
  return { rows, errors: [] };
}

// ─── Planning (also the preview) ────────────────────────────────────────────

const normName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ');
const holderRef = (row: LegacyRow) =>
  `legacy-holder:${crypto.createHash('sha256').update(`${normName(row.holderName)}|${row.dob ?? `cert:${row.certificateNo}`}`).digest('hex').slice(0, 32)}`;

async function resolveHolder(db: DB, row: LegacyRow): Promise<
  { kind: 'member_id' | 'name_and_dob'; personId: number; federationId: string } | { kind: 'new_record' } | { kind: 'error'; error: string }
> {
  if (row.memberId) {
    const p = (await db.select().from(s.persons).where(sql`upper(${s.persons.federationId}) = ${row.memberId}`).limit(1))[0];
    return p ? { kind: 'member_id', personId: p.id, federationId: p.federationId }
      : { kind: 'error', error: `No member record has the ID ${row.memberId}.` };
  }
  const sameName = await db.select({ id: s.persons.id, federationId: s.persons.federationId, dob: s.persons.dob, sourceRef: s.persons.sourceRef })
    .from(s.persons).where(sql`lower(regexp_replace(trim(${s.persons.fullName}), '\\s+', ' ', 'g')) = ${normName(row.holderName)}`);
  if (row.dob) {
    const both = sameName.filter((p: any) => p.dob && String(p.dob) === row.dob);
    if (both.length > 1) return { kind: 'error', error: 'Several member records share this name and date of birth. Add the member ID.' };
    if (both.length === 1) return { kind: 'name_and_dob', personId: both[0].id, federationId: both[0].federationId };
    return { kind: 'new_record' };
  }
  // No date of birth: a same-named person might be this holder or a namesake.
  const others = sameName.filter((p: any) => p.sourceRef !== holderRef(row));
  if (others.length) return { kind: 'error', error: 'A member with this name is already registered. Add the member ID or date of birth so the certificate is linked to the right person.' };
  return { kind: 'new_record' };
}

function rowProblem(row: LegacyRow): string | null {
  if (!row.certificateNo) return 'No certificate number.';
  if (row.certificateNo.length > 80) return 'The certificate number is too long.';
  if (!row.holderName || row.holderName.length < 2) return 'No holder name.';
  if (!row.title) return 'No title or grade.';
  if (row.issuedOn.startsWith('INVALID:')) return `The issue date "${row.issuedOn.slice(8)}" is not a date (use DD-MM-YYYY or YYYY-MM-DD).`;
  if (row.dob?.startsWith('INVALID:')) return `The date of birth "${row.dob.slice(8)}" is not a date.`;
  return null;
}

/** What an import WOULD do, row by row. Writes nothing. */
export async function planLegacyImport(db: DB, rows: LegacyRow[]): Promise<PlannedRow[]> {
  const seen = new Set<string>();
  const out: PlannedRow[] = [];
  for (const row of rows) {
    const base = {
      line: row.line, certificateNo: row.certificateNo, holderName: row.holderName,
      title: row.title, issuedOn: row.issuedOn, kind: row.kind, holder: null, federationId: null,
    } as const;
    const problem = rowProblem(row);
    if (problem) { out.push({ ...base, outcome: 'error', error: problem }); continue; }
    const key = row.certificateNo.toUpperCase();
    if (seen.has(key)) { out.push({ ...base, outcome: 'error', error: 'This certificate number appears twice in the file.' }); continue; }
    seen.add(key);
    const exists = (await db.select({ id: s.certificates.id }).from(s.certificates)
      .where(eq(s.certificates.certificateNo, row.certificateNo)).limit(1))[0];
    if (exists) { out.push({ ...base, outcome: 'exists', error: null }); continue; }
    const holder = await resolveHolder(db, row);
    if (holder.kind === 'error') { out.push({ ...base, outcome: 'error', error: holder.error }); continue; }
    out.push({
      ...base, outcome: 'import', error: null,
      holder: holder.kind,
      federationId: holder.kind === 'new_record' ? null : holder.federationId,
    });
  }
  return out;
}

export interface ImportReport {
  imported: number;
  existing: number;
  errors: number;
  newRecords: number;
  matchedRecords: number;
  rows: PlannedRow[];
}

/** Import every row the plan accepts. Gated on certificate:issue; audited per certificate. */
export async function importLegacyCertificates(
  db: DB,
  ctx: AuditContext,
  rows: LegacyRow[],
  opts: { sourceLabel: string; now?: Date } = { sourceLabel: 'legacy import' },
): Promise<ImportReport> {
  assertCanAnywhere(ctx.principal, 'certificate:issue');
  const now = opts.now ?? new Date();
  const plan = await planLegacyImport(db, rows);
  const byLine = new Map(rows.map((r) => [r.line, r]));
  const report: ImportReport = { imported: 0, existing: 0, errors: 0, newRecords: 0, matchedRecords: 0, rows: plan };
  const who = (ctx.principal as any)?.label ?? 'an administrator';

  for (const item of plan) {
    if (item.outcome === 'exists') { report.existing++; continue; }
    if (item.outcome === 'error') { report.errors++; continue; }
    const row = byLine.get(item.line)!;
    try {
      // Re-resolve inside the write: an earlier row may have created this holder.
      const holder = await resolveHolder(db, row);
      let personId: number;
      if (holder.kind === 'error') { item.outcome = 'error'; item.error = holder.error; report.errors++; continue; }
      if (holder.kind === 'new_record') {
        const created = await createPersonForSource(db, { ...ctx, reason: `Holder of historical certificate ${row.certificateNo}` }, {
          fullName: row.holderName,
          dob: row.dob,
          sourceRef: holderRef(row),
          status: 'inactive',
        });
        personId = created.id;
        item.federationId = created.federationId;
        if (created.created) report.newRecords++;
        else report.matchedRecords++;
      } else {
        personId = holder.personId;
        item.federationId = holder.federationId;
        report.matchedRecords++;
      }
      const [cert] = await db.insert(s.certificates).values({
        certificateNo: row.certificateNo,
        kind: row.kind,
        personId,
        title: row.title.slice(0, 200),
        issuedOn: row.issuedOn,
        issuingAuthority: row.issuingAuthority.slice(0, 200),
        status: 'issued',
        verifyToken: crypto.randomBytes(18).toString('base64url'),
        // Keys follow the register's snapshot convention (holder, federationId,
        // grade, awardedOn), which is what verifyCredential() reads.
        snapshot: {
          provenance: 'unverified_legacy',
          legacy: true,
          holder: row.holderName,
          federationId: item.federationId ?? undefined,
          awardedOn: row.issuedOn,
          grade: row.kind === 'kyu_grade' || row.kind === 'dan_grade' ? row.title : undefined,
          evidence: `Original certificate ${row.certificateNo}, issued ${row.issuedOn} by ${row.issuingAuthority}.`,
          notes: row.notes ?? undefined,
          source: opts.sourceLabel,
          importedAt: now.toISOString(),
          importedBy: who,
        },
      }).returning({ id: s.certificates.id });
      await writeAudit(db, { ...ctx, reason: `Historical certificate imported from ${opts.sourceLabel}` }, {
        entityType: 'certificate', entityId: cert.id, action: 'create',
        newValue: { certificateNo: row.certificateNo, personId, kind: row.kind, provenance: 'unverified_legacy' },
      });
      report.imported++;
    } catch (err: any) {
      item.outcome = 'error';
      item.error = String(err?.message ?? err).slice(0, 200);
      report.errors++;
    }
  }
  return report;
}
