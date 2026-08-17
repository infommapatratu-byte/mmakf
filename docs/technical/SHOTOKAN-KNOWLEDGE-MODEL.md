# The Shotokan knowledge model

**How the technical library is put together, and which part of it is allowed to
say what.**

Written 17 August 2026. Every number in this document was produced by running
the command shown beside it, not by reading a previous version of this file —
`docs/IMPLEMENTATION-STATUS.md` records why that distinction is enforced here.

---

## The one idea the whole thing turns on

Four different kinds of claim get made about karate, and a system that files
them together will eventually present one as another. So they are separated at
the level of *storage*, not just at the level of wording:

| Kind of claim | Example | Where it lives | Who may assert it |
| --- | --- | --- | --- |
| **Public martial-arts knowledge** | Gyaku-zuki is driven by hip rotation against a planted rear foot | `src/data/shotokan/*`, `src/data/kata.ts` | Anyone; it is common to every Shotokan dojo in the world |
| **MMAKF curriculum** | This technique is examined at this grade | `technical.schema.ts` — syllabus versions, grade requirements | The federation, by publishing a syllabus. **Nothing has been published.** |
| **External reference** | JKA India's kihon footage | `src/data/shotokan/video-register.ts` → `media_assets` | Recorded with attribution; never restated as MMAKF's |
| **Reviewed interpretation** | This kata movement means this | `kata_applications`, `technical_reviews` | A named MMAKF technical reviewer, in the database |

The first column is the only one an agent may write. The second is empty by
design and stays empty until the federation fills it. The third carries its
source with it everywhere it goes. The fourth needs a person's name attached,
and the migration's `CHECK` constraints refuse a row that claims approval
without one.

**Collapsing any two of these is the failure mode.** A library that stores
"Heian Nidan — 8th kyu" as though it were the same kind of fact as "Heian Nidan
has 26 movements" has invented federation policy, and members plan their
training around exactly that.

---

## The parts, and where they are

### Static content — public knowledge

```
src/data/kata.ts                     26 kata, the canon (pre-existing)
src/data/shotokan/kihon-types.ts     the technique record shape, and the rules
src/data/shotokan/stances.ts         10 stances
src/data/shotokan/hand-techniques.ts 22 punches, blocks and strikes
src/data/shotokan/kicks.ts            8 kicks + 2 movement categories
src/data/shotokan/kumite.ts           6 systems, 16 principles, 8 combination families
src/data/shotokan/terminology.ts     83 terms, and the KihonFamily vocabulary
src/data/shotokan/video-register.ts  121 verified recordings, 4 sources, 3 barren
src/data/shotokan/index.ts           assembly, the graph, and search
```

Counted with:

```
grep -c "  T({" src/data/shotokan/{stances,hand-techniques,kicks}.ts
grep -c "  V({" src/data/shotokan/video-register.ts
```

Static rather than database-backed **on purpose**. This material is not
federation policy, does not change per environment, has no per-tenant variation,
and is the thing a public page must render even when `DATABASE_URL` is unset.
Putting it in Postgres would mean the kata library goes dark during an outage,
for content that is identical in every deployment.

### Database — provenance, review and endorsement

Built in parallel with this work; see `docs/technical/TECHNICAL-LIBRARY.md`.

```
src/db/technical.schema.ts   syllabus, grades, gradings, certificates (authority)
src/db/library.schema.ts     sources, citations, movements, applications,
                             rulesets, terms, media links, chapters, reviews
src/db/library.ts            review queue, rights gate, endorsement
src/db/library-seed.ts       seeds from src/data/technical-reference.ts and
                             imports terminology.ts
src/db/education.schema.ts   media_assets, channels, broadcasts, live classes
src/lib/youtube.ts           OAuth, broadcast detection, classification
```

The database holds the things that **change, need an owner, or need approving**.
The static files hold the things that are true regardless.

### Surfaces

```
/shotokan                        the hub — what Shotokan is, and where each part is documented
/shotokan/kihon                  the technique library, grouped by family
/shotokan/techniques/[slug]      one technique, in depth (§35)
/kata, /kata/[slug]              the kata library (pre-existing)
/shotokan/kumite                 systems, principles, combination families
/shotokan/kumite/[slug]          one system or principle
/shotokan/terminology            the glossary, anchored per term
/shotokan/videos                 the source register and the research matrix
/admin/technical-library         the review queue (parallel work)
```

---

## The graph

`src/data/shotokan/index.ts` assembles three neighbourhoods:

- `techniqueGraph(slug)` → the technique, the kata it appears in, the kumite
  principles that use it, the glossary, registered recordings, siblings in its
  family, and the combination families it is part of.
- `kataGraph(slug)` → the kata, the techniques whose own records name it, the
  kumite concepts that name it, and its registered recordings split by rights
  standing.
- `researchMatrix()` → per-kata coverage by source, for §50.

**Every edge comes from a hand-written field. Nothing is inferred.** A
technique-to-kata edge exists because somebody wrote `relatedKata: ['bassai-dai']`
on that technique, not because a string matched. `tests/shotokan-library.test.ts`
asserts this both ways: every slug referenced must resolve, and every edge in an
assembled graph must be traceable back to a field on the record.

Movement-level application edges are deliberately **absent** from the static
layer. §27 and §39 both require technical review before an application becomes
authoritative, so a reviewed application is a database row with a reviewer's
name on it (`kata_applications`), never a constant in a source file.

---

## Search

`searchTechnical(query)` indexes techniques, kata, kumite systems, kumite
concepts and terminology under one normaliser. Normalisation strips case,
hyphens, spaces, apostrophes and combining diacritics, so `gyaku zuki`,
`gyaku-zuki`, `gyakuzuki` and `GYAKU ZUKI` are one query — which §31 requires by
name.

Transliteration aliases live in `KATA_ALIASES` in `index.ts` and are **only
spelling variants**. The Okinawan names Funakoshi renamed the kata from are
already in `src/data/kata.ts` as `formerName` and are indexed from there; a
second copy would be a second thing to keep correct. The directive's own
`HANGESTU` spelling is in the alias list, because syllabuses really do print it.

Scoring: exact key 100, prefix 60, substring 30, body text 10. A term and a
technique may share a name — `gyaku-zuki` is both — and both are returned,
technique first, because a student typing it wants the mechanics as well as the
definition.

---

## What is deliberately absent, and why

| Absent | Reason |
| --- | --- |
| Any grade on any technique or kata | MMAKF has published no syllabus. `curriculum` is a declared field, null on every record. |
| Numbered MMAKF combinations | §12. Combinations are described as conceptual families; federation-approved ones are curriculum data entered through admin. |
| Any competition rule value | §20. No score, no bout length, no contact level. Principles survive a rule change; values do not. |
| Movement-level bunkai | §27, §39. Requires a named reviewer; lives in the database. |
| Embedded third-party video | §23, §49. See `VIDEO-RIGHTS.md`. |
| Pronunciation audio | §32 permits it "where authorized". MMAKF has recorded none. |
| Hindi for most technique names | §32. The Japanese term is what is used on the floor; a machine translation in a federation glossary is worse than a blank, because students learn it. 8 of 83 terms carry Hindi. |

---

## Tests

```
npx vitest run tests/shotokan-library.test.ts     61 tests
npx vitest run tests/technical-library.test.ts    (parallel DB work)
npx vitest run tests/routes-live.test.ts         144 tests, incl. the library routes
npx vitest run tests/kata.test.ts                 (pre-existing kata guards)
```

The library suite is not a smoke test. It reads the source files and refuses:

- any grade-to-technique or grade-to-kata mapping, in either direction, in data
  **or in prose** — including in comments, because prose that spells out a
  forbidden claim is prose that can be lifted into a surface;
- any numbered combination;
- any competition rule value;
- a register entry with a non-ISO date, a mismatched thumbnail, a duplicate id,
  or a source whose counts do not match what is actually in the file;
- a third-party upload reaching the publishable set;
- a glossary key, kata slug, technique slug or kumite slug that does not resolve;
- a "common error" whose cause or fix is too short to be teaching anything.

Three of those guards found real bugs during the build: an `enpi`/`empi` slug
mismatch that would have produced dangling kata links on three technique pages,
a date parser that had written `"Jan 15, 20"` — a truncated human-readable date
that looks like an ISO one — into 121 register entries, and two glossary entries
carrying a translation where an explanation was required.

---

## Related documents

- `docs/technical/KIHON-LIBRARY.md` — the technique catalogue
- `docs/technical/KUMITE-LIBRARY.md` — partner practice and tactics
- `docs/technical/KATA-LIBRARY.md` — the canon, and what the library adds to it
- `docs/technical/VIDEO-SOURCE-REGISTER.md` — the research, and how to repeat it
- `docs/technical/VIDEO-RIGHTS.md` — what may be shown, and what may not
- `docs/technical/TECHNICAL-REVIEW.md` — the review pipeline
- `docs/technical/MASTER-TEACHER-INTEGRATION.md` — channel and live detection
- `docs/technical/TECHNICAL-LIBRARY.md` — the database layer (parallel work)
