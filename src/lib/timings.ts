// Published training timings for a centre.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE SOURCE PER CENTRE
// ─────────────────────────────────────────────────────────────────────────────
//
// The headquarters' timings are `federation.contact.hours` and
// `federation.contact.hoursSunday` — the same strings /contact, /facilities and
// /schedule publish. The Hombu row on /network and /affiliation READS THEM
// rather than carrying a second copy, because a second copy drifts the moment
// somebody edits one and not the other, and a parent then reads two different
// answers to the same question on two pages of the same site.
//
// Every other centre carries its own pair on its `branches` record, because
// their timings are genuinely their own: an affiliated club in Bokaro does not
// train when the Hombu trains, and inheriting the headquarters' clock would
// publish a time nobody there keeps.
//
// ─────────────────────────────────────────────────────────────────────────────
// A CENTRE WITH NO TIMINGS RECORDED PUBLISHES NOTHING
// ─────────────────────────────────────────────────────────────────────────────
//
// The federation has not collected timings from every affiliated club. An empty
// field renders as absent — not as the headquarters' timings, and not as a
// plausible-looking default. A guessed timing sends somebody to a locked door,
// which is the one failure this directory exists to prevent.

export interface Timings {
  /** The regular week. Empty when the centre has not published one. */
  hours: string;
  /** Sunday, held separately because it does not follow the weekday clock. */
  sunday: string;
}

/**
 * The Hombu is identified by status or name, not by position in the list —
 * the register is admin-editable and rows get reordered.
 */
export function isHeadquarters(b: any): boolean {
  return /headquarters|hombu/i.test(`${b?.status ?? ''} ${b?.name ?? ''}`);
}

export function centreTimings(branch: any, fed?: any): Timings {
  const hq = isHeadquarters(branch);
  const hours = branch?.hours || (hq ? fed?.contact?.hours : '') || '';
  const sunday = branch?.hoursSunday || (hq ? fed?.contact?.hoursSunday : '') || '';
  return { hours: String(hours).trim(), sunday: String(sunday).trim() };
}

export function hasTimings(t: Timings): boolean {
  return Boolean(t.hours || t.sunday);
}
