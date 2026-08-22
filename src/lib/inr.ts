/**
 * Rupees, for the BROWSER. One implementation, no arithmetic on money.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * formatINR() already lives in src/db/fees.ts and is the federation's rupee
 * formatter. It cannot be used in a client script: that module imports the
 * database layer, the schema and the RBAC module, and shipping any of that to a
 * browser is out of the question.
 *
 * So every page that renders a price in JavaScript wrote its own. There were
 * three, in three files, and they had already begun to differ — one grouped
 * with a hand-written regex, one leaned on `toLocaleString('en-IN')`, and the
 * third existed only in the half of a page nobody had compared with the other
 * two. Three implementations of one format is the same defect two
 * implementations of one rounding rule is, one step further along.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHY IT DOES NO ARITHMETIC
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The versions this replaces all did `Math.floor(minor / 100)` and
 * `minor % 100`. That is exact for every integer JavaScript can hold, so it was
 * not producing wrong figures — but it is arithmetic on money, and
 * tests/money-safety.test.ts is right to flag every instance of that on sight
 * rather than to maintain a list of the ones that happen to be safe. A rule
 * with exceptions is a rule people learn to argue with.
 *
 * Here the paise and the rupees are taken out of the integer as DIGITS and
 * never computed. It is the same discipline rupeesToPaise() applies going the
 * other way in the marketplace route: read the digits, do not scale the value.
 * Nothing to round, nothing to overflow, and nothing for the money-safety
 * pattern to match — so this file needs no exemption from it.
 *
 * INDIAN GROUPING, deliberately: ₹12,34,567.89 and never ₹1,234,567.89. The
 * last three digits, then pairs.
 */

/**
 * Integer paise → a rupee string.
 *
 * A non-finite or non-integer input returns the em dash rather than `NaN`:
 * this runs in a template, and "₹NaN" on a checkout page is worse than an
 * honest blank.
 */
export function formatMinor(minor: number): string {
  if (!Number.isFinite(minor)) return '—';

  const negative = minor < 0;
  // `trunc` rather than `round`: a fractional paisa has no meaning, and
  // rounding one would invent a figure. Callers are expected to pass integers;
  // this is what happens if one does not.
  const digits = String(Math.abs(Math.trunc(minor))).padStart(3, '0');

  const paise = digits.slice(-2);
  const rupees = digits.slice(0, -2);

  const head = rupees.slice(0, -3);
  const tail = rupees.slice(-3);
  const grouped = head
    ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail
    : tail;

  return `${negative ? '-' : ''}₹${grouped}.${paise}`;
}
