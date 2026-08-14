// The table's state lives in the URL, and this file is the only thing that
// knows how (§79, §80).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE QUERYSTRING AND NOT COMPONENT STATE
// ─────────────────────────────────────────────────────────────────────────────
//
// A filtered table is a QUESTION somebody asked. "Registrations for the state
// championship that are still awaiting payment" is a question an officer will
// ask again tomorrow, will want to send to a colleague, and will reach for the
// Back button to return to after opening one of the rows.
//
// Held in JavaScript, that question survives none of those three. Held in the
// querystring it survives all of them, it survives JavaScript being off, and it
// survives the tab being restored a week later. It also means the SERVER can
// answer it — the page reads the same parameters this file parses and can put
// them straight into a query, instead of shipping every row to the browser so
// the browser can throw most of them away.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY VALUE OUT OF THE URL IS UNTRUSTED
// ─────────────────────────────────────────────────────────────────────────────
//
// `?sort=password` and `?per=100000` are one keystroke away from any reader.
// Nothing here returns a value the caller did not declare: a sort key must be
// one of the columns marked sortable, a page size must be one of PER_OPTIONS,
// a page must be a positive integer. An unrecognised value falls back to the
// default rather than throwing, because a mistyped URL should show the table,
// not an error page.

export type SortDir = 'asc' | 'desc';

export interface Sort {
  key: string;
  dir: SortDir;
}

/**
 * The page sizes on offer.
 *
 * Deliberately short. Every extra option is another thing to choose and
 * another value the server has to be prepared to render; 100 is already more
 * rows than anyone reads in one pass.
 */
export const PER_OPTIONS: readonly number[] = [10, 25, 50, 100];

export const DEFAULT_PER = 25;

export interface TableQuery {
  /** null when the caller declared no default and the reader has not chosen. */
  sort: Sort | null;
  page: number;
  per: number;
  /** Filter values present in the URL, keyed by filter key. Blank ones dropped. */
  filters: Record<string, string>;
  /** Every parameter on the URL, so links can preserve what this table does not own. */
  params: URLSearchParams;
  /** Parameter namespace, so two tables on one page do not fight over `?page`. */
  prefix: string;
}

export interface ReadOptions {
  /** Column keys that may be sorted. Anything else in the URL is ignored. */
  sortable?: readonly string[];
  /** Filter keys this table owns. */
  filters?: readonly string[];
  /** Used when the URL names no sort, or names one that is not sortable. */
  defaultSort?: Sort | null;
  defaultPer?: number;
  /**
   * Prefixes `sort`, `page` and `per` — and nothing else. Filter keys are the
   * caller's own words and are used verbatim, because `?status=submitted` is
   * a URL somebody will type by hand and `?t2_status=submitted` is not.
   */
  prefix?: string;
}

/** The URL parameter a sort is written to: `sort=applied_at:desc`. */
export function sortParam(sort: Sort): string {
  return `${sort.key}:${sort.dir}`;
}

function parseSort(raw: string | null, sortable: readonly string[]): Sort | null {
  if (!raw) return null;
  const at = raw.lastIndexOf(':');
  const key = at === -1 ? raw : raw.slice(0, at);
  const dir = at === -1 ? 'asc' : raw.slice(at + 1);
  if (!sortable.includes(key)) return null;
  return { key, dir: dir === 'desc' ? 'desc' : 'asc' };
}

/**
 * Read this table's state out of the page URL.
 *
 * Called by the component for itself, and exported so a page can call it FIRST
 * and put the answer into its database query — which is the whole reason the
 * state is in the URL rather than in the component.
 */
export function readTableQuery(url: URL, opts: ReadOptions = {}): TableQuery {
  const prefix = opts.prefix ?? '';
  const params = new URLSearchParams(url.search);
  const sortable = opts.sortable ?? [];

  const sort =
    parseSort(params.get(`${prefix}sort`), sortable) ?? opts.defaultSort ?? null;

  const rawPage = Number.parseInt(params.get(`${prefix}page`) ?? '', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const rawPer = Number.parseInt(params.get(`${prefix}per`) ?? '', 10);
  const fallbackPer = opts.defaultPer ?? DEFAULT_PER;
  const per = PER_OPTIONS.includes(rawPer) ? rawPer : fallbackPer;

  const filters: Record<string, string> = {};
  for (const key of opts.filters ?? []) {
    const value = (params.get(key) ?? '').trim();
    // A blank filter is the absence of a filter. Keeping `?status=` would make
    // "no status chosen" and "status chosen and empty" look the same to every
    // caller downstream.
    if (value) filters[key] = value;
  }

  return { sort, page, per, filters, params, prefix };
}

/**
 * The parameter value a sortable header should submit when pressed.
 *
 * Pressing the column already sorted reverses it. Pressing a different column
 * starts it at that column's own natural direction — dates read newest-first,
 * names read A-to-Z, and making the reader press twice to get the obvious one
 * is a small tax charged on every use.
 */
export function nextSort(current: Sort | null, key: string, initial: SortDir = 'asc'): string {
  if (current && current.key === key) {
    return sortParam({ key, dir: current.dir === 'asc' ? 'desc' : 'asc' });
  }
  return sortParam({ key, dir: initial });
}

/** aria-sort for a column header, given the table's current sort. */
export function ariaSort(current: Sort | null, key: string): 'ascending' | 'descending' | 'none' {
  if (!current || current.key !== key) return 'none';
  return current.dir === 'asc' ? 'ascending' : 'descending';
}

/**
 * A link back to this same page with some parameters changed.
 *
 * Query-only (`?page=3`), never absolute. The admin surface is served from a
 * second host that rewrites paths (see src/lib/surface.ts), so a link that
 * rebuilt the pathname would be built from the INTERNAL path and send the
 * reader somewhere that does not exist on the host they are on.
 */
export function withParams(
  q: TableQuery,
  patch: Record<string, string | number | null | undefined>,
): string {
  const next = new URLSearchParams(q.params);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') next.delete(key);
    else next.set(key, String(value));
  }
  const s = next.toString();
  return s ? `?${s}` : '?';
}

/** A link to another page of the same result set. */
export function pageHref(q: TableQuery, page: number): string {
  // Page 1 drops the parameter rather than writing `page=1`, so the first page
  // of a table has one address and not two.
  return withParams(q, { [`${q.prefix}page`]: page > 1 ? page : null });
}

export function totalPages(total: number, per: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, per)));
}

/**
 * The 1-based row numbers on show.
 *
 * `total` may be null: a caller reading from a source that cannot cheaply count
 * knows the page it fetched and not the size of the set. That is a real state
 * and it prints as "Showing 26–50" with no total, never as an invented one.
 */
export function shownRange(page: number, per: number, count: number): { from: number; to: number } {
  const from = count === 0 ? 0 : (page - 1) * per + 1;
  return { from, to: (page - 1) * per + count };
}
