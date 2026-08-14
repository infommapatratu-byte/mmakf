// What a table is told about itself.
//
// §97: "If two products need the same interaction, build one shared component."
// Athletes, competitions, registrations, coaches, leads and the disciplinary
// register are six different nouns that all need the same six behaviours —
// filter, sort, page, select, act on the selection, and read on a phone. The
// shape below is the whole vocabulary for describing a table; nothing in the
// component knows what a registration is.
//
// NOTHING HERE CARRIES DATA. A Column says how to render a value, never what
// the value is. There is no sample row, no default option list and no example
// filter anywhere in this directory, because a placeholder that ships is a
// placeholder somebody reads as a fact.

import type { SortDir } from './query';

export type Row = Record<string, unknown>;

export type Align = 'start' | 'end' | 'center';

/**
 * An `.astro` component, for a cell that is not text.
 *
 * Astro publishes no stable public type for a component module, so this is
 * `unknown` and the template casts it once. Typing it `any` here would let a
 * mistyped prop through everywhere it is used.
 */
export type CellComponent = unknown;

export interface Column<R extends Row = Row> {
  /** The row property, and the value submitted when this column is sorted. */
  key: string;
  header: string;
  align?: Align;
  /** A CSS width. Use sparingly — the table is happier deciding for itself. */
  width?: string;
  sortable?: boolean;
  /** Direction the reader gets on the FIRST press. Dates usually want 'desc'. */
  initialDir?: SortDir;
  /** Right-aligned tabular numerals. Sorted numerically in a complete dataset. */
  numeric?: boolean;
  /**
   * Text for the cell. Escaped like any other Astro expression — a column
   * cannot inject markup, which is what stops a member's name from becoming a
   * script tag.
   */
  render?: (row: R) => string | number | null | undefined;
  /**
   * Render the cell through a component instead. This is how a chip, an avatar
   * or a progress bar gets into a cell without this file learning what one is.
   */
  component?: CellComponent;
  componentProps?: (row: R) => Record<string, unknown>;
  /**
   * Render the cell through Status.astro — the ONLY way a status is drawn
   * anywhere in this codebase. Shorthand for `component`, present because
   * roughly every federation table has exactly one status column.
   */
  status?: boolean | { domain?: string };
  /** Turns the cell into a link. Return null for a row that has no target. */
  href?: (row: R) => string | null | undefined;
  /**
   * Kept on screen when a record is collapsed below the breakpoint (§54).
   * The first column is primary unless something else claims it.
   */
  primary?: boolean;
  /** A short clarification, rendered under the header — never a title tooltip. */
  hint?: string;
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface Filter<R extends Row = Row> {
  /** The URL parameter. Chosen by the caller and used verbatim. */
  key: string;
  label: string;
  /** 'select' needs options; 'search' is a free text box; 'date' is one day. */
  type?: 'select' | 'search' | 'date';
  options?: FilterOption[];
  placeholder?: string;
  /** The wording of a select's do-not-filter option. */
  anyLabel?: string;
  /**
   * What the control SHOWS when the URL names no value for it.
   *
   * For the case where the caller applied a narrowing the reader did not ask
   * for — a default date window, say — and the field would otherwise sit blank
   * above rows it plainly restricted, leaving the reader to guess at it.
   *
   * It is a display value and NOTHING ELSE. It is not put into `q.filters`, so
   * it does not count towards "these filters are why the table is empty", it
   * does not offer a Clear link that would clear nothing, and it never reaches
   * `match`. A default the reader cannot clear is not a filter they applied,
   * and an empty state must not blame them for it.
   */
  value?: string;
  /**
   * How this filter decides, when the table holds the complete set.
   *
   * Without one, a select compares `row[key]` for equality and a search box
   * looks for the text anywhere in the row's own string values. Any filter
   * whose meaning is not one of those two — a date range, a "needs action"
   * flag, anything crossing two fields — supplies this.
   */
  match?: (row: R, value: string) => boolean;
}

export interface BulkAction {
  /** Submitted as the form's `action` field. */
  name: string;
  label: string;
  /**
   * Marks an action that destroys or refuses something. It is styled
   * differently and it asks before it runs. It does NOT become the default.
   */
  destructive?: boolean;
}

export interface Bulk {
  /**
   * Where the selection is posted. Required, and never defaulted: a component
   * that guessed an endpoint would post real records to a route nobody wrote.
   */
  action: string;
  actions: BulkAction[];
  /** Field name carrying the selected row ids. */
  field?: string;
  /**
   * Wording for what a row is, used in the announcements — "3 registrations
   * selected". Defaults to "rows", which reads badly and is meant to.
   */
  noun?: string;
  nounPlural?: string;
}

export type TableState = 'ready' | 'loading' | 'error' | 'denied';

/**
 * Whether the caller handed over every matching row, or one page of them.
 *
 *  complete — the table holds the whole filtered set. It applies the filters,
 *             the sort and the paging itself, all of it at render time on the
 *             server, so it still works with JavaScript off. Correct for a
 *             register of a few hundred rows read out of storage.
 *
 *  page     — the caller already filtered, sorted and paged, presumably in SQL.
 *             The table renders exactly the rows it is given and draws the
 *             controls from `query` and `total`. Correct for anything large,
 *             and the only correct answer once row counts leave the hundreds.
 */
export type Dataset = 'complete' | 'page';
