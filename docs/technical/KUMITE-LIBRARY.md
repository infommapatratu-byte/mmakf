# The kumite library

**Partner practice, from the first five-step exercise to competition tactics.**

Written 17 August 2026. Source: `src/data/shotokan/kumite.ts`.

---

## Contents

| | Count |
| --- | --- |
| Formal systems (`KumiteSystem`) | 6 |
| Principles, footwork, initiatives, tactics (`KumiteConcept`) | 16 |
| Combination families (`CombinationFamily`) | 8 |

---

## The separation the file is built around

§13 asks for traditional kumite development and sport kumite to be kept apart,
and the reason is not tidiness — **they optimise for different things.**

Traditional practice trains a decisive technique against a committed attack; the
exercise is structured so a student can work on distance and timing without
having to survive at the same time. Sport kumite trains a scoring technique
inside a rule set, against an opponent who is also managing a clock, an area
with edges, and a scoreboard.

A student taught the second as though it were the first learns to reach, to
score and to stop. A student taught the first as though it were the second gets
penalised. So every record carries `world: 'traditional' | 'sport' | 'both'`,
and `/shotokan/kumite` renders them in separate, labelled sections that are
never interleaved.

### The six systems

| Slug | World | What it removes from the problem |
| --- | --- | --- |
| `gohon-kumite` | traditional | Everything except distance and timing |
| `sanbon-kumite` | traditional | Everything except selection between blocks |
| `kihon-ippon-kumite` | traditional | The rhythm — one attack, unknown moment |
| `jiyu-ippon-kumite` | traditional | Only the choice of attack |
| `jiyu-kumite` | traditional | Nothing |
| `shiai-kumite` | **sport** | Nothing, and adds rules, a clock and officials |

Each carries a `safety` array, and the suite requires every line in it to be
substantive. Partner work injures people when it is done carelessly, and a
safety section of three-word slogans is decoration.

---

## Rules-dependent material — §20

§20 requires rules-dependent information to be versioned and forbids teaching
outdated competition rules as permanent truth.

**This library's answer is to state no rule at all.** Not one score value, not
one bout length, not one contact level, not one penalty threshold. What is
written is the **tactical principle**, which survives a rule change; the rule
itself belongs in the federation's versioned competition regulations, and every
sport surface links there.

`rulesDependent: true` marks the entries whose content depends on a rule set —
`shiai-kumite`, `competition-distance`, `competition-edge`,
`competition-opponent-analysis` — and both `/shotokan/kumite` and the detail
page render a standing notice on them.

The test greps for the shapes a rule value takes:

```
/\bippon\s+is\s+\w+\s+points?\b/
/\bworth\s+(one|two|three|1|2|3)\s+points?\b/
/\b(bout|match)\s+(is|lasts)\s+\w+\s+minutes?\b/
/\bfirst\s+to\s+\d+\s+points?\b/
```

That guard also fired on the file's own explanatory prose during the build,
which had quoted an example scoring value to explain why one must never be
printed. The prose was reworded. A library that printed a scoring value would be
wrong somewhere in the world on the day it shipped, and wrong everywhere
eventually.

---

## The three initiatives — §18

`go-no-sen`, `sen-no-sen` and `tai-no-sen`, each taught with the full frame §18
asks for. The suite requires all six fields to be present on all three:

| Field | `sen-no-sen` |
| --- | --- |
| **trigger** | The instant of commitment — weight shifting forward, shoulder gathering, breath drawn. Read from the preparation, not from the technique. |
| **distance** | Closing, and fast, because the opponent is doing the closing. |
| **timing** | The narrowest window of the three, and the reason it takes years. |
| **decision** | Against an opponent whose preparation is readable, with a technique short enough to arrive first. |
| **risk** | Read the preparation wrongly and you have attacked into a technique that was never coming, from a distance you closed yourself. |
| **application** | The most valued counter in both traditional practice and competition. |

---

## Combination families — §17

§17 forbids hardcoding combinations as official MMAKF competition doctrine. The
eight here are therefore **conceptual families**: `lead-hand-into-reverse-punch`,
`lead-hand-into-kick`, `kick-into-reverse-punch`, `double-hand`,
`hand-into-kick-into-hand`, `feint-into-attack`, `attack-angle-attack`,
`block-counter`.

None is numbered, none is graded, none is attributed to MMAKF, and the suite
asserts that no slug contains a digit and that no name matches
`combination \d`.

Each carries `why` (the mechanical or tactical reason it works) and
**`countered`** (when it fails, and against whom). The second field is required
by the suite, because a combination library with no answers reads as a list of
things that always work — which is the single most misleading thing a tactics
page can be.

---

## Coverage against the directive

| Directive section | Where |
| --- | --- |
| §13 kumite categories | `SYSTEMS`, six of them |
| §14 fundamentals | `kamae`, `maai`, `zanshin`, `feint`, `kumite-principles` |
| §15 footwork | `kumite-footwork` — six patterns with mechanics, drills and faults |
| §16 attack library | `kumite-attack`, linked to the geri and tsuki records |
| §17 combinations | `COMBINATION_FAMILIES` |
| §18 sen | `go-no-sen`, `sen-no-sen`, `tai-no-sen` |
| §19 defensive kumite | `defensive-kumite` — the six answers as a selection problem |
| §20 competition | `competition-distance`, `competition-edge`, `competition-opponent-analysis`, all `rulesDependent` |

---

## Surfaces

- **`/shotokan/kumite`** — traditional and sport split, then principles by
  category, then the combination families with their caveat.
- **`/shotokan/kumite/[slug]`** — serves **both** kinds of record, because a
  student typing "sen no sen" and one typing "gohon kumite" are both asking the
  kumite library a question and should not have to know which kind of thing they
  are looking for first. The two render differently, because an exercise has a
  structure and a safety brief while a principle has a trigger, a risk and a
  decision, and neither is forced into the other's shape.
