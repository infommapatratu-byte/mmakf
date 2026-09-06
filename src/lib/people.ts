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

/**
 * THE LINEAGE, AS THE FEDERATION HAS ACTUALLY STATED IT.
 *
 * /about and / each carried their own hand-written copy of these three cards,
 * and both said the same two things: that no lineage had been published, and
 * that “Junior Tiger Lee” was his own title, “not the name of a lineage”.
 *
 * That was true when it was written and it stopped being true on 2026-08-13.
 * The federation stated in writing — twice, recorded in docs/CLAIMS-AUDIT.md §2
 * — that the name was awarded by his master, GRANDMASTER S N T LEE, and
 * src/data/seed.ts has carried that named person on leadership[].master ever
 * since. These two cards were the last place still saying there was nobody
 * there, and they said it on the two most-read pages on the site.
 *
 * So it is computed ONCE, here, from the record. Two pages restating the same
 * facts in their own words is what let them drift for a fortnight.
 *
 * IT READS THE RECORD AND CANNOT INVENT ONE. No master on file means no master
 * card — the page renders two generations instead of three rather than naming
 * somebody the federation has not named.
 *
 * AND IT IS STILL NOT A SCHOOL OF SHOTOKAN. A master conferring a name on his
 * student is one claim; a Shotokan line that MMAKF descends from is a different
 * one, was asserted here in nine places with nothing behind it, and was removed.
 * Only the first has ever been stated, so only the first is drawn. Shotokan is
 * what the federation practises and examines TODAY, which is a fact about the
 * present and belongs in the section's lead rather than in a generation of it.
 */
export interface LineageStep {
  num: string;
  name: string;
  sub: string;
  body: string;
}

export function lineageSteps(leadership: any[] | null | undefined, founded: string): LineageStep[] {
  const founder = (leadership || []).find((l: any) => l?.master?.name) ?? null;
  const master = founder?.master ?? null;
  const founderName = founder?.name ?? 'Shihan Pramod Kumar Pathak';

  const steps: Array<Omit<LineageStep, 'num'>> = [];

  if (master) {
    steps.push({
      name: master.name,
      sub: master.relation ?? 'Master',
      // Deliberately thin. No grade, no school, no nationality, no dates — none
      // has been supplied, and this card is precisely where a guess would go.
      body: `${founderName}’s master, and the man who awarded him the name `
        + `“${master.conferred}”. ${master.source}.`,
    });
  }

  steps.push({
    name: founderName,
    sub: master?.conferredShort
      ? `Grandmaster ${master.conferredShort} · VI Dan · Soke`
      : 'VI Dan · Soke',
    body: `Founder of MMAKF (${founded}) and the federation’s senior technical `
      + 'authority, teaching under the name his master awarded him.',
  });

  steps.push({
    name: 'Active Senseis',
    sub: 'III–IV Dan · Federation Faculty',
    body: 'Sensei Vikas, Sensei Dhiraj and Sensei Sumitra — the active generation '
      + 'transmitting the system to today’s students.',
  });

  return steps.map((s, i) => ({ ...s, num: String(i + 1).padStart(2, '0') }));
}

/**
 * WHICH CHANNELS ARE THE FEDERATION'S, AND WHICH BELONG TO A PERSON.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SHARED FUNCTION AND NOT A FILTER ON ONE PAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The `social` record carries a mixture: the federation's own accounts, and the
 * personal teaching channels of the people who run it. Exactly one entry is
 * flagged `primary: 'Yes'`, and it is Shihan Pathak's own academy channel.
 *
 * `/people/[slug]` worked this out and filtered correctly. Nothing else did —
 * so `Base.astro` rendered that personal academy channel in the SITE-WIDE
 * FOOTER under the heading "Official channels", appended " — main channel" to
 * it, and then put its URL into the `sameAs` array of the federation's
 * `SportsOrganization` JSON-LD.
 *
 * That last part is the serious half. `sameAs` is an ASSERTION TO SEARCH
 * ENGINES that two identities are the same entity, so the federation was
 * formally telling Google that a private academy's channel is the national
 * federation. That is the misattribution `/people/[slug]` already refuses, made
 * machine-readable and repeated on every page of the site.
 *
 * A channel is claimed BY ADDRESS on a person's own `ownChannels` list. A
 * claimed channel is that person's and appears on their profile; an unclaimed
 * one is the federation's.
 *
 * IT FAILS TOWARDS SILENCE. Given no leadership records — which is what a
 * caller gets when the content store is unreachable — every channel is treated
 * as UNCLAIMED and therefore the federation's, so a temporary read failure
 * cannot make the federation's own accounts disappear from its footer. The
 * inverse default would be worse in the other direction, and this one is
 * recoverable: an unclaimed channel that should have been claimed is a channel
 * listed under the wrong heading for as long as the store is down, whereas the
 * federation losing its own Instagram from its footer is a visible outage.
 */
export interface Channel {
  platform?: string;
  name?: string;
  url?: string;
  primary?: string;
  note?: string;
}

/** Every URL any leadership record claims as personally theirs. */
export function claimedChannelUrls(leadership: unknown): Set<string> {
  const list = Array.isArray(leadership) ? leadership : [];
  return new Set<string>(
    list.flatMap((p: any) => (Array.isArray(p?.ownChannels) ? p.ownChannels : []))
  );
}

/**
 * The channels the federation may present as its own.
 *
 * NOTE what this does NOT do: it does not filter on `primary`. The footer heading
 * is "Official channels", not "the main one" — every unclaimed account is the
 * federation's and belongs there.
 */
export function federationChannels(social: unknown, leadership: unknown): Channel[] {
  const claimed = claimedChannelUrls(leadership);
  const list = Array.isArray(social) ? social : [];
  return list.filter(
    (a: any) => a && typeof a.url === 'string' && a.url && !claimed.has(a.url)
  );
}
