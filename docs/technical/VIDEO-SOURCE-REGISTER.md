# The video source register

**What the federation looked for, where it looked, what came back, and how to
repeat the whole thing.**

Written 17 August 2026. Source: `src/data/shotokan/video-register.ts`.

---

## Headline

| | |
| --- | --- |
| Source pages fetched | 7 |
| Pages that yielded ids | 4 |
| Candidate ids discovered | 130 |
| Verified live and embeddable | **121** |
| Dead (oEmbed 404) | 8 |
| Embedding disabled (oEmbed 401) | 1 |
| Kata of the canon with at least one recording | **26 of 26** |
| Citable without a rights decision | 70 |
| Held for a technical-committee rights decision | 51 |

Reproduce with `node scripts/discover-videos.mjs`; re-check with
`node scripts/check-video-links.mjs`.

---

## The method, and why it is written down

An earlier agent on this project published a video link and recorded evidence of
a check it had never performed. `src/data/kata.ts` carries the scar tissue in
its header and `tests/kata.test.ts` turns it into a rule. This register inherits
the rule and widens it: **a recording is entered only with the result of a real
check attached.**

For every id:

1. **Discovered from the source page itself.** The page HTML is fetched and the
   YouTube ids it embeds are extracted. No search engine, no "probably this
   one". If a source does not embed it, this pass never saw it.
2. **Verified against the platform.** oEmbed must return HTTP 200 with an embed
   iframe in the response.
3. **Metadata taken from the platform, not from the page.** Title, channel and
   channel URL come from oEmbed. Collection pages caption their embeds by hand
   and captions drift — a form is relabelled, a video is swapped, a typo
   outlives everyone who noticed it. Where the two disagree, the platform wins,
   and the disagreement is a fact about the source worth knowing.
4. **Duration, upload date and playability read from the watch page.**
   `playabilityStatus` must be `OK` and `blockedRegions` empty.
5. **A negative control run in the same pass** — an id of eleven `A` characters.
   Nothing is written unless that control fails. A check that cannot fail is not
   a check; it manufactures confidence.

### The date bug, recorded because it is instructive

The watch page carries **two** dates: an ISO one (`"uploadDate":"2018-01-15T…"`)
and a localised human one (`"publishDate":{"simpleText":"Jan 15, 2018"}`). The
first version of the extractor matched the human one first and sliced ten
characters, producing `"Jan 15, 20"` — a string that looks like a date, is not
one, and had been written into all 121 entries before a test caught it.

The parser now tries the ISO forms only and **leaves the field null** rather
than falling back to a form it cannot read unambiguously. `tests/shotokan-library.test.ts`
asserts `/^\d{4}-\d{2}-\d{2}$/` on every entry and that `Date.parse` accepts it.

---

## The sources

Ordered by seed authority rank. **The rank is a starting position, not a
doctrine** — §41 forbids encoding a permanent hierarchy of other organisations
in code, so it seeds `technical_sources.authority_rank` and an administrator
changes it thereafter.

| Rank | Organisation | Page | Found | Verified | Channel ownership |
| --- | --- | --- | --- | --- | --- |
| 20 | Japan Karate Association India | `jkaindia.com/VideoGallery.html` | 65 | 64 | **Its own** — `@JKAIndiahq` |
| 30 | SKIF New Zealand | `skif.co.nz/katas.html` | 26 | 26 | Third party — `shotokankataman` |
| 40 | Colchester JKA | `colchesterjka.co.uk/kata` | 25 | 25 | Third party — `iZafod`, `1000MOSHT` |
| 60 | Cambridge University Karate Club | `cukc.org/videos.php` | 6 | 6 | **Its own** — `@cukarate` |

### What each source actually gave

- **JKA India** — the largest and most varied haul: national and state camps,
  kihon and kihon-renzoku instruction, kumite explanation and drills, national
  championship footage, and a handful of kata (Tekki Shodan, Heian Nidan, Heian
  Sandan, Heian Yondan, Bassai Dai, Jion, Chinte). On the organisation's own
  channel, so citable.
- **SKIF NZ** — the **only source with complete canon coverage**: exactly 26
  recordings, one per kata. All on a third-party channel.
- **Colchester JKA** — 25 kata demonstrations by Enoeda and Ohta Sensei.
  Technically the strongest material in the whole haul. All third-party hosted.
- **Cambridge** — kumite and Varsity footage on the club's own channel. Useful
  as competition reference; labelled as such, and not as a technical authority.

---

## The sources that yielded nothing

Kept and published, because "we looked there" is information and a silently
absent source reads as one nobody thought of.

### Yale Shotokan Karate Club — and why link health is checked per id

`karate.sites.yale.edu/kata-videos` returns **HTTP 200**. It embeds eight kata
recordings. **All eight are dead** — every id returns oEmbed 404.

This is precisely the failure §55 names: *"A 200 response alone does not prove
that an embedded video is actually playable."* A conventional link checker
pointed at that page would have reported a healthy source with eight videos on
it, indefinitely.

It is the reason `scripts/check-video-links.mjs` never fetches a page.

### Japan Karate Association

`jka.or.jp/en/about-jka/techniques/` is written and illustrated rather than
embedded video, so the discovery pass found no ids. It remains the most
authoritative reference the library links to — **as a link**, which is what it
is.

### JKA Migenkan, Canada

`jkamigenkan.ca/videos/` loaded but embeds no YouTube ids reachable from the
served HTML; its media is loaded another way. Recorded as checked-and-empty
rather than dropped, so a later pass knows it was tried.

---

## The research matrix

Rendered at `/shotokan/videos` and produced by `researchMatrix()`. One row per
kata, columns per source, plus totals and how many are citable.

Every kata in the canon has at least one registered recording. **Almost none has
one MMAKF may currently show** — because the two sources with kata coverage are
both third-party hosted. That is a fact about the world, and the library does
not quietly resolve it.

---

## The scripts

### `node scripts/discover-videos.mjs`

Re-runs the pipeline: DISCOVER → DEDUPLICATE → VERIFY → SOURCE SCORE → CLASSIFY
→ RIGHTS CHECK → REVIEW QUEUE. Reads its source list **out of the register**, so
the script and the data cannot drift into disagreeing about where the federation
looks. Barren sources are re-checked too: a source that was empty last time can
acquire material.

It **never writes** to the register or to the database. §40 forbids
auto-publishing and §39 makes machine classification candidate data. Output
labels every classification as a machine guess.

`--new-only` reports just ids the register does not already hold. `--json` for
machine consumption.

### `node scripts/check-video-links.mjs`

Link health, per id, never per page. States:

| State | Meaning | Fails the run |
| --- | --- | --- |
| `OK` | Live, embeddable, title and channel still match the register | No |
| `DRIFTED` | Live and embeddable, but retitled or the channel renamed | No — a curation task |
| `NO_EMBED` | oEmbed 401 — owner disabled embedding. Link only now | **Yes** |
| `GONE` | oEmbed 404 — deleted, private, or a wrong id | **Yes** |
| `UNREACHABLE` | Network failed | No — treating a timeout as a dead video is how a register quietly empties itself during an outage |

A negative control runs first and the script aborts if it passes.

Last run: **121 checked, 121 OK.**
