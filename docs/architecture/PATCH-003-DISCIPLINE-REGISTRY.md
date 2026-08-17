# PATCH 003 — the discipline registry

**Built on branch `patch-003-discipline-registry`, in a git worktree at
`.claude/worktrees/discipline-registry`, off `d45a239`.**

Read [EXISTING-SYSTEM-MAP.md](./EXISTING-SYSTEM-MAP.md) §0 first: it explains
why this patch is not in the main working tree.

---

## 1. WHAT THIS PATCH IS FOR

Every technical table in this repository is Shotokan — not by a column saying
so, but by there being no column at all. `techniques`, `kata`, `kumite_forms`,
`grade_definitions` and `competition_events` carry no discipline and no style.

That is survivable while MMAKF governs one art and unrecoverable the moment it
governs two: the first Judo record makes every existing row ambiguous, and no
later migration can go back and say which art the earlier ones belonged to.

So the discipline comes first, and everything technical hangs off it. This is
why the audit moved PATCH 003 ahead of PATCHES 005–011: building kata depth
before the registry means migrating it twice.

## 2. THE ONE IDEA THE WHOLE PATCH IS BUILT ON

**A RECORD OF AN ART IS NOT AN ADOPTION OF IT.**

A national federation needs the vocabulary to recognise a foreign Kyokushin dan
grade, publish a glossary, and file an applicant's history — none of which is
MMAKF adopting Kyokushin.

So the registry is split in two:

| Describes the world | Describes MMAKF |
|---|---|
| `disciplines`, `styles`, `lineages`, `governing_bodies`, `technical_systems`, `competition_formats`, `grade_systems` | `discipline_adoptions` |
| Written by anyone holding `discipline:write` | Written only by `recordAdoption()`, gated on `discipline:adopt` |
| Every row carries a `source_tier` | Every row carries a named decider and a recorded authority, both NOT NULL |
| Seeded by scripts as `reference` | **Ships empty.** A script cannot create one |

There is no `is_official` boolean anywhere in the registry. The first person to
write `WHERE is_official` would have turned a reference entry into federation
policy nobody voted for.

Every read helper returns `standing`, defaulting to `'reference'` — never null,
never absent, and never inferred from `published`, from `status`, or from the
existence of styles beneath an art. Four tests assert exactly that.

## 3. WHAT WAS BUILT

| Layer | File | Note |
|---|---|---|
| Schema | `src/db/discipline.schema.ts` | 13 tables, 7 enums |
| Migration | `drizzle/0100_discipline_registry.sql` | Hand-written; see §5 on numbering |
| Lockdown | `drizzle/0101_data_api_lockdown.sql` | RLS on the 13 new tables — the standing rule from 0010 |
| Service | `src/db/disciplines.ts` | Authorisation, audit and events all live here |
| API | `src/pages/api/disciplines/[...action].ts` | 9 actions, each one call into the service |
| UI | `src/pages/admin/disciplines.astro` | Registry, coverage panel, registration and adoption forms |
| Navigation | `src/lib/surface.ts` | Added to the Sport group, gated on `discipline:read` |
| Authorisation | `src/lib/rbac.ts` | 4 new actions, granted to 7 roles |
| Events | `src/lib/domain-events.ts` | 6 new event types |
| Status vocabulary | `src/lib/status.ts` | 7 new statuses + 2 domain override sets |
| Tests | `tests/disciplines.test.ts` | 40 tests against real Postgres (PGlite) |

### The 13 tables

`disciplines` · `discipline_versions` · `discipline_aliases` · `styles` ·
`style_versions` · `lineages` · `governing_bodies` · `discipline_authorities` ·
`technical_systems` · `competition_formats` · `grade_systems` ·
`grade_system_levels` · `discipline_adoptions`

### Additive columns on existing tables — nullable, **not backfilled**

`techniques.discipline_id`, `.style_id` · `kata.discipline_id`, `.style_id` ·
`kumite_forms.discipline_id`, `.style_id` · `grade_definitions.grade_system_id` ·
`competition_events.discipline_id` · `event_categories.competition_format_id`

`UPDATE techniques SET discipline_id = (SELECT id FROM disciplines WHERE slug =
'karate')` would have been one line, and it would have been a fabrication: it
asserts, in the federation's own database and with nobody behind it, that every
technique already recorded is karate. Most probably are. "Probably" is not what
a recorded federation fact means.

NULL means UNCLASSIFIED, which is true. `classifyExisting()` classifies one
record at a time, from an actor, with an audit row and a `DISCIPLINE_LINKED`
event. There is deliberately no bulk endpoint and no `classifyAll()`.

## 4. FOUR DECISIONS WORTH ARGUING WITH

**`grade_system_levels.ordinal` ascends with seniority, always.** Kyu grades
count DOWN as they get more senior and dan grades count UP, so any `ORDER BY` on
the printed number orders one half of a karate ladder backwards — and passes any
test written with dan grades alone. The printed number is `label`/`numeral`;
sorting is on `ordinal`; they are never the same column. A test asserts two
rungs share numeral 1 and sit nine ordinals apart.

**`competition_formats` owns the ruleset, not the event.** One championship may
run Shotokan kata, sanda and judo on the same weekend. `competition_events.
discipline_id` says which page an event belongs on;
`event_categories.competition_format_id` says what is actually contested.

**`disciplineKind` was NOT renamed.** `competition.schema.ts` already has an
enum called `discipline_kind` whose values are `kata | kumite | team_kata |
team_kumite` — i.e. event type within karate, not a martial art. Renaming it is
a breaking change across `draws`, `matches`, `rankings` and every stored
category row, to fix a name. It is documented loudly in both files instead, and
`competition_formats` is the successor.

**`discipline:adopt` is modelled on `unit:charter`, not on a narrower role.**
The repository's own precedent is that constitutive acts sit with national
administration and the control is the recorded authority, not a rarer role. The
technical director holds `read`/`write`/`publish` and NOT `adopt`, because the
technical director advising on an adoption is exactly why the two must not be
one action.

## 4a. THE COLLISION THIS PATCH FOUND, AND FIXED

While this patch was being built, the other session committed
`e685c7b` — thirteen more migrations, `0014`–`0033b`, including
`0031_technical_library.sql`.

`0031` creates a type called **`source_tier`**. So did this patch, with a
different set of values:

| | Values |
|---|---|
| `0031_technical_library` | `mmakf_official`, `primary_reference`, `competition_authority`, `educational`, `discovery` |
| `0100` as first written | `mmakf_official`, `governing_body`, `technical_organisation`, `academic`, `educational`, `community` |

Applied in filename order, the second `CREATE TYPE` fails outright — *type
source_tier already exists* — and **every migration after it stops.** This is
the failure `docs/parallel/PATCH-CONFLICTS.md` §1 records for migration
filenames, one level down: the type names collided rather than the files.

**Resolved by one vocabulary, extended additively**, in
`drizzle/0099_source_tier.sql`:

- `0031`'s definition wins, because it landed first. Nothing is renamed and
  nothing removed, so every existing row and code path is untouched — the same
  discipline `0031` itself applied when it extended `rights_status` by four
  values rather than reshaping it.
- Four tiers it has no word for are added: `governing_body`,
  `technical_organisation`, `academic`, `community`. The reasoning for each is
  in the file.
- It is its **own file** because PostgreSQL will not let a value added by
  `ALTER TYPE` be used in the transaction that added it, and
  `scripts/migrate.mjs` wraps each file in one transaction. `0100` defaults
  several columns to `'governing_body'`.
- It works from **both directions**: in this worktree `source_tier` has never
  existed, so the block creates it — with `0031`'s five values verbatim, so a
  database built from this branch alone and one built from merged history are
  identical.

Renaming this patch's enum to `registry_source_tier` would have been easier and
wrong: the federation would then hold two provenance ladders with overlapping
meanings, and the first query ranking a claim from one against a claim from the
other would have to translate between them.

**Verified as a merge rehearsal**, not as a prediction: the other session's 34
committed migrations and this patch's 3 were applied together, in filename
order, to a fresh Postgres.

```
files applied : 37
CREATE TABLE  : 281
actual tables : 281
RLS enabled   : 281
OK
```

### What did NOT collide

`0031` also builds `kata_movements`, `kata_applications`, `technical_terms`,
`reference_curricula` and `sport_kumite_rulesets` — much of PATCHES 006, 011 and
014. None of the 13 registry tables collides with any of them by name, and none
of the other six new enums collides either. The two patches are complementary:
`0031` has the kata movement graph this one deliberately left alone, and this one
has the discipline column `0031`'s tables will eventually need.

## 5. MIGRATION NUMBERING — 0100, DELIBERATELY

Migrations jump from `0013` to `0100`. This is not a renumbering of anything.

A second session was concurrently authoring `0014`–`0026` in the main tree while
this was built in a worktree. Two authors both taking "the next number" produce
two files with the same name; the merge that follows either loses one or applies
the wrong one — against a runner that checksums applied history and refuses
edited files.

Reserving the `01xx` block makes the merge order `0013, 0014 … 0026, 0100, 0101`,
which is exactly what `scripts/migrate.mjs` needs (it sorts by filename) and
what `tests/data-api-lockdown.test.ts` needs (no table-creating migration after
the last lockdown). The gap is cosmetic and documented, as the `0008` gap
already is.

**`drizzle/meta/_journal.json` was NOT touched.** The runner does not read it —
`scripts/migrate.mjs:158` and `scripts/verify-migrate.mjs:22` both
`readdirSync('drizzle')` — and the other session is editing that file.

## 6. VERIFICATION

All run in `.claude/worktrees/discipline-registry`, all against a real Postgres
engine (PGlite) on this machine.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx astro build` | compiles; `dist/server/pages/admin/disciplines.astro.mjs` and `dist/server/pages/api/disciplines/_---action_.astro.mjs` both emitted |
| `tests/disciplines.test.ts` | **40 passed** |
| `data-api-lockdown` + `rbac-adversarial` + `tenant-isolation` | **74 passed** |
| `disciplines` + `data-api-lockdown` + `status-dictionary` + `migration-runner` | **80 passed** |
| Full suite, 80 files | **2,589 passed**, 1 file failed — see below |
| Migrations, this branch alone | 144 → **157 tables**, RLS on all 157 |
| Migrations, **merged with the other session's 34** | **281 tables**, RLS on all 281 |

**The one failing file is `tests/routes-live.test.ts`, and it is not this
patch.** It boots `astro dev` on a free port and polls it. In the full run the
server started — the log carries `astro v5.18.2 ready in 8920 ms` and its
`http://127.0.0.1:51188/` line — but could not be reached within the 90-second
window while 80 test files ran concurrently on a saturated machine. Run on its
own in the same worktree it passes **123/123**, which is the check that
distinguishes a regression from a resource-contention artefact.

`npx astro build` also fails at the very last step, in the Vercel adapter's
`astro:build:done` hook: `EPERM … symlink '..\..\..\node_modules'`. That is
Windows refusing a symlink into a worktree whose `node_modules` is itself a
junction. Astro's own compile and bundle complete first, and both new routes are
in `dist/`.

Baseline before this patch, same worktree: **79 files, 2,670 tests, all
passing.**

## 7. WHAT THIS PATCH DOES NOT DO

- **Ships no content.** Not one discipline, style, governing body or ruleset is
  defined in code. The registry is empty until somebody fills it, which renders
  as "the registry is empty" — credible — rather than as an invented taxonomy.
- **Does not decide whether Kyokushin is a style or a discipline.** Both shapes
  are representable and `disputed` exists so the disagreement can be recorded
  rather than resolved by whoever loaded the data.
- **No kata movement graph.** `kata.sequence` is still one `jsonb` column.
  Movements, embusen, stances and transitions are PATCH 006, and they now have a
  discipline to hang off.
- **No rulesets.** `competition_formats.ruleset_ref` points at a document.
  Scoring tables, legal and illegal techniques, weight and age classes and the
  protest procedure are PATCH 011. Shipping a ruleset here would be inventing
  regulations.
- **The six new domain events have no consumer.** Stated in the catalogue rather
  than left to be noticed: every audience `NOTIFIABLE` knows about resolves to a
  person or body with a stake in the record, and a discipline has none. Naming a
  consumer that cannot act is the wire drawn on a diagram and nowhere else that
  `catalogueDefects()` exists to catch. The audit row is the accountability
  record here.

## 8. MERGING THIS

The patch touches six files the other session is also editing:
`src/db/schema.ts` (one `export *` line at the end), `src/lib/rbac.ts`,
`src/lib/domain-events.ts`, `src/lib/status.ts`, `src/lib/surface.ts`,
`src/db/competition.schema.ts` and `src/db/technical.schema.ts`.

All seven changes are additive — a line appended to a list, an entry added to a
map, a column added to a table literal. None removes or reorders anything, so
each conflict, if git raises one at all, resolves by keeping both sides.

`drizzle/meta/_journal.json` is untouched, and the migrations cannot collide by
filename.
