# The kihon library

**40 techniques, described as mechanics rather than as a list of names.**

Written 17 August 2026.
Source: `src/data/shotokan/{kihon-types,stances,hand-techniques,kicks}.ts`.

---

## Contents

| Family | Count | File |
| --- | --- | --- |
| `dachi` — stances | 10 | `stances.ts` |
| `tsuki` — thrusting | 8 | `hand-techniques.ts` |
| `uke` — receiving | 8 | `hand-techniques.ts` |
| `uchi` — striking | 6 | `hand-techniques.ts` |
| `geri` — kicking | 8 | `kicks.ts` |
| `tai_sabaki` / `ashi_sabaki` — movement | 2 | `kicks.ts` |

Counted with `grep -c "  T({" src/data/shotokan/{stances,hand-techniques,kicks}.ts`.

Every technique the directive names in §7 through §11 is present, and
`tests/shotokan-library.test.ts` asserts each one **by slug** — so a directive
entry that is missing fails the suite rather than being noticed by a reader.

---

## The record

```ts
interface Technique {
  slug, name, kanji, english, family, aliases
  summary        // what it is and what it is for — prose, not a stub
  mechanics      // labelled points, rendered in the order the body performs them
  principles     // what survives when the Japanese is forgotten
  commonErrors   // { error, why, fix } — a name alone teaches nobody
  drills
  application    // what it is for against a person
  relatedKata    // slugs, only where uncontroversial
  relatedKumite  // slugs into the kumite library
  terms          // keys into terminology.ts
  contested      // a genuine disagreement between organisations, or null
  curriculum     // ALWAYS null — see below
}
```

`Mechanics` fields are all optional and the interface is deliberately wide: a
stance has no hikite and a punch has no support foot. An interface that demanded
both would be filled with filler, and filler is how a library stops being read.

The technique page renders them in a **fixed order** — start, travel, arrival,
recovery — driven by a label list, not by `Object.entries`, so the reading order
is the order a body actually performs the technique in rather than whatever
order the fields happened to be typed.

---

## What it may not say

### No grade

`curriculum` is a declared `CurriculumPlacement | null` and is null on all 40
records. The field exists so that the day MMAKF publishes a syllabus it is
**filled in rather than designed**; the null is the honest current state, and
`/shotokan/techniques/[slug]` prints that absence at full weight with a link to
`/belt-system` rather than quietly omitting it.

The suite refuses any grade-to-technique mapping in either direction, in data or
in prose — **including in comments**. That guard fired during the build on the
library's own warning text, which had spelled out an example of the forbidden
claim. The prose was reworded rather than the guard weakened, because prose that
spells out a forbidden claim is prose that can be lifted into a surface.

### No invented combination

§12. Combinations live in `kumite.ts` as conceptual families described by what
they do. None is numbered, graded, or attributed to MMAKF.

### No false precision

Where Shotokan organisations genuinely differ, `contested` records the
disagreement and the page prints it at full weight rather than in a footnote.
Five techniques carry one:

- **`zenkutsu-dachi`** — exact length and permitted back-foot angle differ
  measurably between organisations, and between decades of the same one.
- **`kokutsu-dachi`** — 70/30 is the JKA-line figure; others teach 60/40.
- **`soto-uke` / `uchi-uke`** — whether *soto* names the direction of travel or
  the contact surface is answered differently by different organisations, with
  the result that the two names are **swapped** in some schools. The mechanics
  described are the JKA-line convention; the name is the part that varies.
- **`fudo-dachi`** — whether fudo-dachi and sochin-dachi are one stance or two.
- **`mae-geri`** — keage or kekomi as the primary training form.

`sanchin-dachi` carries an explicit flag that **it is not a Shotokan stance**.
It is documented because the directive lists it "where applicable" and because
students meet it in cross-style training; it is not presented as canon, and a
test asserts the flag is still there.

---

## Teaching, not naming

§9 asks for principles rather than names, and the suite enforces it
structurally: every `commonErrors` entry must carry a cause and a fix of real
length, so the field cannot degrade into a list of faults.

That guard failed twice during the build — on `ura-mawashi-geri` ("Over-rotating.")
and `tai-sabaki` ("Anxiety.") — and both were rewritten to say something a
student could act on.

One idea is stated once per file rather than forty times:

- `hand-techniques.ts` — *the arm does not supply the power.* Every shoulder
  fault in the file is a symptom of an arm trying to do the body's job.
- `kicks.ts` — *the knee travels first, and the foot comes back before it goes
  down.* Every kick repeats the retraction instruction, because in practice it
  is the first thing to disappear under fatigue.

---

## Surfaces

- **`/shotokan/kihon`** — grouped by family, and **deliberately not ordered
  beginner-to-advanced**, because an ordered list is a grading ladder by
  implication and MMAKF has published no ladder.
- **`/shotokan/techniques/[slug]`** — summary, application, mechanics,
  principles, errors with fixes, drills, the contested note, the
  kihon ↔ kata ↔ kumite graph, the glossary, and registered recordings.

Both are indexable. `/shotokan/techniques/[slug]` has an expansion policy
recorded in `DYNAMIC_ROUTE_POLICY` and is expanded into `/sitemap.xml` from the
same array the pages render from, so the sitemap cannot advertise a slug that
404s.
