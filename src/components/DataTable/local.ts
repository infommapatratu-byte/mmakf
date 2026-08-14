// Filtering, ordering and paging a set the table already holds, on the server.
//
// This is what makes a register of a few hundred rows filterable with
// JavaScript switched off: the work happens during the render, and the reader
// gets a finished page of HTML back from a plain <form method="get">. Nothing
// in here runs in the browser.
//
// A caller with a large table should not use any of it — see Dataset in
// types.ts. There is no clever threshold: a component cannot tell whether it
// was handed forty rows or forty thousand until it already has them, so the
// choice belongs to whoever wrote the query.

import type { Column, Filter, Row } from './types';
import type { Sort } from './query';

/**
 * Ordering for text.
 *
 * `numeric` so that "Round 2" sorts before "Round 10" — federation data is full
 * of numbered rounds, categories and belt levels written as text, and the
 * default lexical order puts 10 before 2 in every one of them.
 */
const COLLATOR = new Intl.Collator('en-IN', { numeric: true, sensitivity: 'base' });

function comparableOf(row: Row, column: Column): unknown {
  const raw = row[column.key];
  if (raw !== undefined && raw !== null) return raw;
  // A column that only exists as rendered text still has to be sortable, or a
  // derived column becomes the one column nobody can order by.
  return column.render ? column.render(row) : raw;
}

/**
 * Compare two values for a sort.
 *
 * MISSING VALUES SINK, in both directions. This matters more here than in most
 * products: the federation has published no service standard, so every deadline
 * column in this system is NULL for every row. Sorting by "due" ascending and
 * getting a screenful of blanks at the top would read as the most urgent work
 * in the queue, which would be a lie about records that have no due date at all.
 */
function compare(a: unknown, b: unknown, numeric: boolean): number {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  if (numeric || (typeof a === 'number' && typeof b === 'number')) {
    const an = typeof a === 'number' ? a : Number(a);
    const bn = typeof b === 'number' ? b : Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an === bn ? 0 : an < bn ? -1 : 1;
  }

  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : Date.parse(String(a));
    const bt = b instanceof Date ? b.getTime() : Date.parse(String(b));
    if (Number.isFinite(at) && Number.isFinite(bt)) return at === bt ? 0 : at < bt ? -1 : 1;
  }

  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const ab = a ? 1 : 0;
    const bb = b ? 1 : 0;
    return ab === bb ? 0 : ab < bb ? -1 : 1;
  }

  return COLLATOR.compare(String(a), String(b));
}

/**
 * Every string a free-text search may look inside, for one row.
 *
 * THE DECLARED COLUMNS ONLY, and never the whole row object.
 *
 * A row handed to this table is a record straight out of storage, and it
 * carries far more than the page chose to show: an internal note, a contact
 * address, the id of the officer who last touched it. Searching the whole
 * object turns the filter box into an oracle — type a guess, and a row
 * appearing tells the reader the guess was right about a field the page had
 * deliberately not put on screen. That is a disclosure with a filter over it,
 * and it is not made safe by the value never being printed.
 *
 * So a search sees what the reader sees: the value of each declared column,
 * through the column's own `render` where it has one.
 */
function searchableText(row: Row, columns: Column[]): string {
  const parts: string[] = [];
  for (const column of columns) {
    const value = column.render ? column.render(row) : row[column.key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Apply the reader's filters.
 *
 * A filter with no declared behaviour compares for equality — the honest
 * default, because a select whose options came from the data should match the
 * data. Anything cleverer than that is the caller's `match`.
 *
 * `columns` is required rather than optional so that a caller cannot reach the
 * old behaviour by leaving it out: a free-text search reads the declared
 * columns and nothing else. See searchableText above for why.
 */
export function applyFilters(
  rows: Row[],
  filters: Filter[],
  values: Record<string, string>,
  columns: Column[],
): Row[] {
  const active = filters.filter((f) => (values[f.key] ?? '') !== '');
  if (active.length === 0) return rows;

  return rows.filter((row) =>
    active.every((f) => {
      const value = values[f.key]!;
      if (f.match) return f.match(row, value);
      if (f.type === 'search') return searchableText(row, columns).includes(value.toLowerCase());
      return String(row[f.key] ?? '') === value;
    }),
  );
}

export function applySort(rows: Row[], sort: Sort | null, columns: Column[]): Row[] {
  if (!sort) return rows;
  const column = columns.find((c) => c.key === sort.key);
  if (!column) return rows;

  const direction = sort.dir === 'desc' ? -1 : 1;
  // A copy: the caller's array is theirs, and a component that reorders its own
  // props has changed something the page may render again further down.
  return [...rows].sort(
    (a, b) => compare(comparableOf(a, column), comparableOf(b, column), !!column.numeric) * direction,
  );
}

export function applyPage(rows: Row[], page: number, per: number): Row[] {
  const start = (page - 1) * per;
  return rows.slice(start, start + per);
}
