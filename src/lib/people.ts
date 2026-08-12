/**
 * How a person's name becomes a URL.
 *
 * One function, imported everywhere, because a slug computed two different ways
 * is a dead link: the card links to /people/shihan-pramod-kumar-pathak and the
 * profile answers to /people/pramod-kumar-pathak, and nobody notices until a
 * visitor does.
 */

/** Name → URL segment. The inverse is never computed; slugs are matched, not parsed. */
export function slugify(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * A profile link, or null when the name cannot produce one. Returning null
 * rather than '/people/' means the caller renders plain text instead of a link
 * to a page that does not exist.
 */
export function profileHref(name: string): string | null {
  const s = slugify(name);
  return s ? `/people/${s}` : null;
}

/** Initials for the monogram tile shown when no portrait is on record. */
export function initials(name: string): string {
  return (name || '')
    .split(/\s+/)
    .filter((w) => !/^(shihan|sensei|senpai|soke|renshi|kyoshi|hanshi)$/i.test(w))
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase();
}
