# The kata library

**The twenty-six forms of the Shotokan canon, and what the technical library
adds around them.**

Written 17 August 2026. Sources: `src/data/kata.ts` (pre-existing),
`src/data/shotokan/index.ts` (the graph), `src/db/library.schema.ts`
(movement-level records, parallel work).

---

## The canon

All twenty-six forms the directive lists in §2 are present in `src/data/kata.ts`
with slug, name, kanji, meaning, the Okinawan name Funakoshi renamed it from,
series, movement count where settled, kiai points where standard, a prose
character description, what the form develops, and glossary keys.

`tests/kata.test.ts` has guarded that file since before this work and continues
to. Nothing here modifies it.

### Transliteration aliases — §2

The directive asks for spelling aliases to be handled in search, and it
demonstrates the need in its own text by writing **HANGESTU**. Aliases live in
`KATA_ALIASES` in `src/data/shotokan/index.ts` and are **only spelling
variants**:

```
hangetsu   → hangestu
empi       → enpi
jitte      → jutte
unsu       → unsuu
bassai-dai → bassai            (the bare family name)
kanku-dai  → kanku, kosokun, kosokun dai
kanku-sho  → kosokun sho
gojushiho-dai → gojushiho, goju shi ho, goju shi ho dai
gojushiho-sho → goju shi ho sho
```

The historical names — Pinan, Naihanchi, Passai, Kushanku, Wanshu, Chinto,
Seishan, Niseishi, Rohai, Useishi — are **not** duplicated here. They are already
`formerName` in `src/data/kata.ts`, and the search index reads them from there.
A second copy would be a second thing to keep correct, and the canon file is the
canon.

`ji'in` and `jiin` need no alias: the normaliser strips apostrophes, so both
reduce to the slug.

---

## What this work added

### The neighbourhood

`kataGraph(slug)` assembles, for one kata:

- the techniques whose **own records** name it — never inferred from a string
  match;
- the kumite concepts whose records name it;
- registered recordings, most authoritative source first;
- of those, the subset MMAKF may show without a rights decision.

`kataTechniqueMatrix()` gives the same relationship in the other direction for
the whole canon.

### Video coverage

Every one of the 26 kata now has at least one verified, live, embeddable
recording in the register — see `VIDEO-SOURCE-REGISTER.md`. Two sources carry
kata material:

- **SKIF New Zealand** — the only source found with complete canon coverage,
  exactly 26 recordings.
- **Colchester JKA** — 25 Enoeda and Ohta Sensei demonstrations, technically the
  strongest material in the haul.

**Both are third-party hosted**, so all 51 are held pending a
technical-committee rights decision and none is embedded. That is a fact about
the world and the library does not quietly resolve it; see `VIDEO-RIGHTS.md`.

MMAKF's own kata footage remains the four recordings in
`FEDERATION_KATA_FOOTAGE`, described as **training footage rather than a
performance of any named form**, because that is what the channels say they are.
Attributing them to a specific kata would be exactly the guess the video rule
exists to forbid.

---

## What the library still does not say

### No syllabus

MMAKF has not published which kata it examines at which grade. `gradeAssociation`
is a declared field, null on all twenty-six, and both `/kata` and `/kata/[slug]`
render that absence out loud with a link to `/belt-system`.

This is the failure the project treats as unforgivable, and it is guarded from
two directions: `tests/kata.test.ts` reads the kata source and refuses any
grade-to-kata mapping, and `tests/shotokan-library.test.ts` applies the same
refusal across the whole technical library including its comments.

### No AI bunkai

§27 and §39 both require technical review before an application becomes
authoritative. So the static layer carries **no movement-level application edges
at all**. A reviewed application is a row in `kata_applications` with an
`interpretation_kind` (`traditional`, `instructor`, `mmakf_approved`,
`historical`, `self_defence`) and, where it claims MMAKF approval, a named
approver that the migration's `CHECK` constraint requires.

A learner is entitled to know whether they are reading a long-established
traditional reading, one named instructor's interpretation, or something the
federation has endorsed. Those are three different claims and the schema keeps
them apart.

### No movement counts that a source does not contain

Recorded by the parallel database work and repeated here because it is the same
discipline: a web search confidently returns per-kata movement counts attributed
to the JKA instructor manual. The manual was fetched. It does not publish them.
So `kata.movement_count` is null for the Heian series in the database and there
is a test that fails if anybody adds one.

`src/data/kata.ts` publishes the JKA-line figure where it is the one everybody
prints, and null where it is genuinely disputed — with `MOVEMENT_COUNT_NOTE`
rendered on the index page explaining that the counts are conventions rather
than facts, and are not identical in every organisation.

---

## Surfaces

| Route | What it shows |
| --- | --- |
| `/kata` | The canon, grouped by series, with the glossary count and the federation footage |
| `/kata/[slug]` | One kata in depth; 404s on an unknown slug rather than rendering an empty one |
| `/shotokan/videos` | The research matrix — per-kata coverage by source, with how many are citable |

The kata pages are pre-existing and unmodified. What is new is that
`/shotokan/techniques/[slug]` now links **into** them from every technique whose
record names the form, and `/shotokan/videos` reports coverage per kata.
