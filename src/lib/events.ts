// Event date handling shared by the homepage and /events.
// Seed events store display strings (day "15", mo "JUN", year "2026"); this
// parses them into real dates so concluded events are never advertised as
// upcoming (audit finding: past events shown as "next" with live Register).

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** Parse an event's display fields into a Date, or null when unparseable. */
export function eventDate(e: any): Date | null {
  const mo = MONTHS[String(e?.mo || '').trim().toUpperCase().slice(0, 3)];
  const day = parseInt(String(e?.day || ''), 10);
  const year = parseInt(String(e?.year || ''), 10);
  if (mo === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  return new Date(year, mo, day);
}

/** Start of today, local time. */
function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Events happening today or later, soonest first. Unparseable dates are kept
 *  (the office may use a custom format) and sort last. */
export function upcomingEvents(events: any[] = []): any[] {
  const t = today().getTime();
  return events
    .filter((e) => {
      const d = eventDate(e);
      return d === null || d.getTime() >= t;
    })
    .sort((a, b) => {
      const da = eventDate(a), db = eventDate(b);
      if (!da) return 1;
      if (!db) return -1;
      return da.getTime() - db.getTime();
    });
}

/** Concluded events, most recent first. */
export function pastEvents(events: any[] = []): any[] {
  const t = today().getTime();
  return events
    .filter((e) => {
      const d = eventDate(e);
      return d !== null && d.getTime() < t;
    })
    .sort((a, b) => (eventDate(b)!.getTime() - eventDate(a)!.getTime()));
}
