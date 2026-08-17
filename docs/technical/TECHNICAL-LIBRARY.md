# Technical knowledge library

Covers the foundation for P05 (Heian kata), P16 (bunkai), P20 (WKF sport
kumite) and P41 (master teacher channel). Migration `0031_technical_library`.

This document is honest about what is finished and what is not. See
[Status by patch](#status-by-patch) before relying on any of it.

---

## What was researched

Primary sources only. Every claim below was read out of the cited document, not
out of a search-result summary.

| Source | What was taken | Verified |
| --- | --- | --- |
| [JKA — Techniques](https://www.jka.or.jp/en/about-jka/techniques/) | The three-pillars statement, quoted | Yes — page read |
| [JKA — Kyu/Dan Grading Guideline (PDF)](https://www.jka.or.jp/wp/wp-content/uploads/2022/03/f421fec70fb6a7004d4e58a7cf567bb9.pdf) | Full kihon/kata/kumite requirements, 10th Kyu – 3rd Dan | Yes — PDF extracted and transcribed |
| [JKA — Technical Manual for the Instructor (PDF)](https://www.jka.or.jp/wp/wp-content/uploads/2017/04/tech_manual_instructor.pdf) | Kata evaluation criteria; the movement-count requirement | Yes — PDF extracted |
| [WKF Kumite Competition Rules 2026.01 (PDF)](https://www.wkf.net/files/pdf/documents/WKF%202026%20Kumite%20Competition%20Rules%20MASTER%20COPY_V11.pdf) | Articles 1.1, 8.1–8.11, 9.1.1–9.1.2, verbatim | Yes — PDF extracted |
| [Pramod Pathak Martial Art (YouTube)](https://www.youtube.com/@PramodPathakMartialArt) | Channel URL only | **No** — see below |

### The finding that shaped the whole patch

**Per-kata movement counts could not be verified, so none were recorded.**

A web search returns, confidently and repeatedly, that the Heian kata have
21 / 26 / 20 / 27 / 23 movements, attributed to the JKA instructor manual. The
manual was fetched and read. It says:

> verify that there is an accurate number of movements

> one count is equal to one movement; be aware of proper rhythm in counting

It does **not** publish per-kata counts. So `kata.movement_count` is left null
for the Heian series, `kata_movements.verification` defaults to `'unverified'`,
and there is a test — `asserts no movement count that the cited source does not
contain` — that fails if anybody adds one.

This is the single most likely number for a grading candidate to rely on, and
"everyone prints it" is not a source.

### The other thing that could not be verified

**The Pramod Pathak channel is registered at tier `educational`, not
`mmakf_official`.** The directive describes it as the MMAKF master teacher
source. The channel page could not be read — YouTube serves an application
shell, so no channel id, upload count or statement of MMAKF affiliation was
obtainable without the Data API. Registering it as Tier A on the strength of the
brief alone would be exactly the unverified claim this system exists to prevent.

Promoting it is one column change, and it should be a recorded federation
decision. `technical_sources.notes` says so in the row.

---

## Schema

14 tables, migration `0031`. Nothing existing was renamed or dropped.

**Provenance**
- `technical_sources` — the registry, so a trusted source is assessed once.
- `technical_citations` — polymorphic; one row per (record, source). A record
  with no citation is, by construction, unsourced and findable in one query.

**Kata (P05, P16)**
- `kata_movements` — one row per counted movement. Every descriptive column is
  nullable; `count_label` holds what a source calls it ("3", "3a", "5-6") while
  `ordinal` is our stable ordering.
- `kata_applications` — bunkai, carrying `interpretation_kind`
  (`traditional` / `instructor` / `mmakf_approved` / `historical` /
  `self_defence`).

**Sport kumite (P20)**
- `sport_kumite_rulesets`, `sport_kumite_provisions` — deliberately NOT merged
  with `kumite_forms`. One is regulation with an effective date; the other is a
  teaching progression.

**Terminology and search**
- `technical_terms`, `technical_term_aliases`, `technical_translations`.

**Media graph (P41)**
- `media_technical_links` — the edge from a video to what it teaches, optionally
  timecoded, carrying `proposed_by` and `confidence`.
- `media_chapters` — chapters, stored independently of the curriculum edges.

**Review**
- `technical_reviews` — append-only decision trail.

**External reference**
- `reference_curricula`, `reference_curriculum_items` — another organisation's
  syllabus, unreachable from the MMAKF grading engine.

### The constraints that carry the rules

The directive's guarantees are in the database, not only in code:

```sql
-- "AI CANNOT declare MMAKF approval."
CHECK (kind <> 'mmakf_approved'
       OR (approved_by_person_id IS NOT NULL AND approved_on IS NOT NULL))

-- The same for the media graph.
CHECK (state NOT IN ('approved','published')
       OR (reviewed_by_person_id IS NOT NULL AND reviewed_at IS NOT NULL))

-- A citation that cites nothing is not provenance.
CHECK (source_id IS NOT NULL OR source_url IS NOT NULL)
```

Each is covered by a test that issues a raw `INSERT`, bypassing every function
in `src/db/library.ts`, and expects the database to refuse.

---

## Rights

`mediaUse()` in `src/db/library.ts` is the only place that decides what may be
done with a video.

| Rights | Use | Meaning |
| --- | --- | --- |
| `federation_owned`, `licensed`, `cleared`, `embed_allowed` | `embed` | May be served from an MMAKF page |
| `link_only` | `link` | May be linked to, never re-served |
| `unknown`, `permission_pending`, `not_cleared`, `restricted`, `do_not_use` | `none` | Not shown at all |
| anything unrecognised | `none` | Refuses to guess |

Two independent gates, both enforced:

1. **Write path** — `reviewLink()` refuses to approve or publish a link whose
   asset's rights are `none`, *even for a fully authorised technical reviewer*.
   The rights answer is a fact, not a preference a senior reviewer can overrule.
2. **Read path** — `mediaFor()` filters on rights again, so a link that reached
   `approved` by any route still does not surface if the rights do not permit it.

The four rights values added to the shared `rights_status` enum are documented
in [PATCH-CONFLICTS.md](../parallel/PATCH-CONFLICTS.md#2-rights_status-enum--extended-additively).

---

## Authority

Two new RBAC actions, purely additive:

- `technical:read` — read the library and the review queue.
- `technical:review` — decide on it.

Deliberately **not** folded into `content:*`. `MEDIA_OFFICER` holds
`content:write` and must not be able to declare that a stranger's kata
demonstration is fit to teach, nor that MMAKF may lawfully publish it. Granted
to `TECHNICAL_DIRECTOR` and to `NATIONAL_FULL`.

The admin screen resolves the deciding person from the **session**, never from
the form. A posted `reviewerPersonId` would let any reviewer attribute a
decision to a colleague; the audit trail would then be confidently wrong, which
is worse than absent. A shared-credential session resolves to no person and
therefore cannot approve anything.

---

## Status by patch

Per the directive's own standard — a feature is complete only when data → API →
UI → workflow → search → rights → admin → audit → tests are connected.

### Foundation — COMPLETE

Schema, migration, rights engine, review workflow, audit trail, admin queue,
search, seed, 38 tests. Verified: all 31 migrations apply to a fresh Postgres and
every constraint refuses what it should.

### P20 — WKF sport kumite — DATA COMPLETE, NO PUBLIC PAGE

Ruleset 2026.01 and 14 provisions seeded verbatim with citations, kept apart
from traditional kumite. `getRuleset()` reads it. **No learner-facing page** —
see conflict 4 in PATCH-CONFLICTS: which surface owns technical content is an
open architecture question and guessing would create a route somebody has to
un-pick.

### P41 — Master teacher channel — SOURCE REGISTERED, LIVE PIPELINE NOT RUN

The channel is in the source registry with its rights recorded as unknown.
`src/lib/youtube.ts` (pre-existing, 687 lines) already implements OAuth, channel
authorisation, broadcast sync, live detection and classification. **No YouTube
credentials are configured on this deployment**, so no live ingestion has run and
nothing was faked.

What DOES flow end to end today is the offline register:
`importVideoRegister()` takes the 125 verified videos and 7 sources in
`src/data/shotokan/video-register.ts` into `media_assets`, `technical_sources`
and `media_technical_links` at state `new` — 59 of them carrying a kata
classification. Every one arrives at `rights: 'unknown'`, so the queue has real
work in it and the learner surface shows none of it. That is the pipeline
working, not the pipeline waiting.

### P05 — Heian kata — SCHEMA ONLY, NO MOVEMENT DATA

`kata_movements` exists, is tested, and holds nothing for the Heian kata. This
is the honest outcome of the research: movement-level data for Heian Shodan–Godan
requires a source that documents each count's stance, technique, direction and
target, and no such source was verified in this pass. Populating it from an
unverified secondary source would produce exactly the confident, untraceable data
the directive forbids.

**What it needs:** either an MMAKF technical committee sitting that documents the
federation's own reading, or a licensed reference text with page-level citations.
Either way the rows land at `verification = 'source_documented'` at best, and
only the committee can move them to `'committee_verified'`.

### P16 — Bunkai — SCHEMA ONLY, NO APPLICATIONS

`kata_applications` exists with the interpretation-kind distinction and the
approval constraint, both tested. No applications are seeded. Bunkai is the area
where authorship blurs most easily, and seeding a "traditional interpretation"
from an unattributable source would be the exact failure the table was designed
to make impossible.

---

## Tests

`tests/technical-library.test.ts` — 38 tests, all passing.

- **Rights** — every enum value maps to exactly one use; unknown values refuse;
  attribution labels never present third-party video as MMAKF content.
- **Approval** — proposals always land at `new` whatever the caller claims;
  approval refused on unresolved rights, on refused rights, with no named
  reviewer, and for a principal without `technical:review`; the raw-SQL
  endorsement is refused by the database.
- **Learner reads** — rights-blocked video never returned even when its link row
  says `approved`; unpublished kata hidden; sparse movements still returned.
- **Queue** — the rights blocker is visible before the technical question;
  refused without `technical:read`.
- **Seed** — idempotent; the JKA guideline loads without touching
  `syllabus_versions` or `grade_requirements`; verbatim grade labels preserved;
  no movement counts asserted; the master teacher channel not promoted.
- **Search** — `oi-zuki` / `oi zuki` / `oizuki` / `oi tsuki` all reach one term;
  zuki⇄tsuki in both directions; exact match ranked first.
- **Provenance** — a citation citing nothing refused, in code and in SQL.
- **Video register import** — verified videos arrive `unknown`, never cleared;
  provenance strength recorded without deciding rights; links land at `new`;
  unmatched kata reported rather than dropped; learners see none of it;
  idempotent.

---

## Files

**Created**
```
src/db/library.schema.ts                    14 tables, 6 enums
src/db/library.ts                           rights, reads, review, search
src/db/library-seed.ts                      idempotent seed, terminology + video-register imports
src/data/technical-reference.ts             the researched primary-source data
src/pages/admin/technical-library.astro     the review queue
drizzle/0031_technical_library.sql          migration
tests/technical-library.test.ts             38 tests
docs/technical/TECHNICAL-LIBRARY.md         this file
docs/parallel/PATCH-CONFLICTS.md            conflicts with parallel agents
```

**Modified — all additive**
```
src/db/schema.ts             one export line
src/db/education.schema.ts   4 values added to rights_status
src/lib/rbac.ts              technical:read / technical:review
src/lib/surface.ts           one admin nav entry
```

---

## What is deliberately absent

- **No movement counts.** See above.
- **No bunkai.** See above.
- **No Tier A claim** for the master teacher channel.
- **No fabricated transcripts or chapters.** `media_chapters` is empty; the
  directive says not to fabricate a transcript when none is available.
- **No learner route.** Pending the surface decision.
- **No LIVE YouTube ingestion run.** No credentials on this deployment; the
  provider interface already exists and is not faked. The offline register import
  does run.

---

## The Shotokan corpus (migration 0034)

### The problem this solved

The federation had **two Shotokan libraries that could not see each other**.

`src/data/shotokan/` and `src/data/kata.ts` hold a substantial, carefully
written corpus — 26 kata, 42 techniques, 6 kumite systems, 16 kumite concepts,
a terminology set and a 125-video verified register — rendered as static pages
at `/shotokan/*` and `/kata/*`.

The database held the tables that make a corpus *reviewable*: provenance,
movement-level detail, bunkai with attributed authorship, the media graph, the
approval queue. **Every one of them was empty.** Nothing anywhere inserted into
`kata`, `techniques` or `kumite_forms`.

The consequence was concrete rather than theoretical:

- `kata_movements.kata_id` had nowhere to point.
- `technicalLookup('gyaku-zuki')` returned a definition and no appearances.
- `importVideoRegister()` skipped **all 59** of its kata-tagged videos, because
  no kata row existed to link them to.

`importShotokanCorpus()` is the bridge. The data files stay canonical and are
not modified; the database becomes a queryable, citable, reviewable projection.

### What crosses, and at what strength

| Corpus | Table | Rows |
| --- | --- | --- |
| `KATA` | `kata` | 26 |
| `TECHNIQUES` (stances, punches, blocks, strikes, kicks) | `techniques` | 42 |
| `SYSTEMS` | `kumite_forms` | 6 |
| `Technique.relatedKata` | `technique_kata_appearances` | the knowledge-graph edge |
| `Technique.aliases` | `technical_term_aliases` | hand-authored, better than generated |
| `Technique.contested` | `technical_citations` at `disputed` | the corpus already noticed these |

### The two-strengths rule

`kata_movements` says *"movement 17 of Heian Nidan is a chudan gyaku-zuki in
zenkutsu-dachi"* and needs a source that counted.
`technique_kata_appearances` says only *"gyaku-zuki appears in Heian Nidan"* —
which is exactly what the corpus documents.

Forcing the weaker claim into `kata_movements` would mean inventing an
`ordinal`, because that column is `NOT NULL` and unique per kata. **One invented
ordinal is indistinguishable from a researched one the moment it is stored**,
and the whole discipline of migration 0031 would be undone by a convenience.

So there are two tables, and `technicalLookup()` returns both — each tagged with
its `precision` (`'movement'` or `'kata'`), and a kata already answered
precisely is not repeated at the weaker strength. A test enforces that every
`movement_ordinal` written by the importer is null.

### The movement-count disagreement, recorded rather than resolved

`src/data/kata.ts` asserts a movement count for **all 26 kata**. The research
behind migration 0031 found the JKA instructor manual requires an accurate count
and *does not publish one*.

Two agents, one repository, one fact that members plan their grading around. The
directive is explicit: do not silently combine; store the source, the variant,
the explanation.

What the importer does:

- The count **is** imported. Suppressing it would discard deliberate work.
- A citation is written beside it recording where it came from and how strong
  the claim is. With no verification determination, that is `unverified`,
  attributed to the in-repository corpus, with the note *"No primary source was
  verified for this figure; the JKA instructor manual requires an accurate count
  but does not publish one."*
- A verification pass can supply a `CorpusDetermination` to raise a count to
  `source_documented` with a real quote and URL.
- Where authoritative sources **verifiably disagree**, `movementCount` is set to
  `NULL` and every competing figure is stored as its own `disputed` citation.
  Storing either number would make this system the thing that settled a
  disagreement it has no authority to settle.

### Sport kumite stays out of the traditional material

`KumiteSystem.world` distinguishes `'traditional'` from `'sport'`. Sport systems
are imported but **not published** as Shotokan teaching progression — competition
kumite has its own home in `sport_kumite_rulesets`, where it carries a rules
version, an effective date and a governing authority. Publishing it in both
places is how a learner ends up reading a competition convention as doctrine.
