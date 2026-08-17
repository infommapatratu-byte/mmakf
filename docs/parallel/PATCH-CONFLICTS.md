# Parallel patch conflicts

Conflicts and overlaps found while building the technical knowledge library
against a repository several agents were editing at the same time. Each entry
records what was found, what was done about it, and what somebody still has to
decide.

Nothing here was resolved by overwriting another agent's work.

---

## 1. Migration numbering collision — RESOLVED

**Found.** At the start of this patch the highest migration was `0026`. By the
time the migration was written, `0027_policy_engine.sql`, `0028`, `0029` and
`0030` had appeared from other agents. The file was originally written as
`0027_technical_library.sql`, which collided with `0027_policy_engine.sql`.

**Done.** Renamed to `0031_technical_library.sql` and re-verified. All 31
migration files apply cleanly in filename order to a fresh Postgres.

**Still open.** The migration runner (`scripts/migrate.mjs`) reads the `drizzle/`
directory and sorts filenames; it does not use `drizzle/meta/_journal.json`. The
journal is already inconsistent with the directory — it contains 25 entries, two
of which are both tagged `0024` (`0024_data_api_lockdown` and
`0024_marketplace_platform`), and it has no entry for `0025` or `0026`. This
patch did **not** try to repair that, because the journal is another agent's
in-flight file and only `drizzle-kit generate` consumes it. Whoever owns
drizzle-kit generation should reconcile it.

---

## 2. `rights_status` enum — EXTENDED, ADDITIVELY

**Found.** `education.schema.ts` defines `rights_status` with six values:
`cleared`, `federation_owned`, `licensed`, `permission_pending`, `restricted`,
`not_cleared`. The technical directive requires eight, of which two mattered and
neither could be expressed:

- **`embed_allowed` vs `link_only`** — the difference between a lawful provider
  embed and re-serving somebody else's instructional video from an MMAKF page.
- **`unknown` vs `not_cleared`** — "nobody has checked" versus "we checked, and
  no". Collapsing these removes the review queue's reason to exist.

**Done.** Four values ADDED (`embed_allowed`, `link_only`, `unknown`,
`do_not_use`). Nothing renamed, nothing removed, no existing row or code path
affected. `ALTER TYPE ... ADD VALUE IF NOT EXISTS` in `0031`, matching the
precedent in `0006` and `0011`.

**Mapping for anyone reading the directive against the schema:**

| Directive        | Column value       |
| ---------------- | ------------------ |
| `EMBED_ALLOWED`  | `embed_allowed`    |
| `LINK_ONLY`      | `link_only`        |
| `LICENSED`       | `licensed`         |
| `MMAKF_OWNED`    | `federation_owned` |
| `MMAKF_AUTHORIZED` | `cleared`        |
| `UNKNOWN`        | `unknown`          |
| `RESTRICTED`     | `restricted`       |
| `DO_NOT_USE`     | `do_not_use`       |

`permission_pending` and `not_cleared` have no directive equivalent and are
retained: they are states the existing workflow already writes.

---

## 3. Overlap with the static Shotokan content layer — NOT DUPLICATED

**Found.** Another agent is actively building a file-based Shotokan content
layer (files modified during this session):

```
src/data/kata.ts                    26 kata, terms, video-position discipline
src/data/shotokan/terminology.ts    TERMS: Record<string, Term> — canonical vocabulary
src/data/shotokan/stances.ts        stance catalogue
src/data/shotokan/hand-techniques.ts
src/data/shotokan/kicks.ts
src/data/shotokan/kihon-types.ts    Technique / Mechanics / Fault types
src/data/shotokan/video-register.ts VIDEOS + SOURCES, oEmbed-verified
src/pages/kata/index.astro, [slug].astro
```

That work is high quality and follows the same evidence discipline as this
patch — its video register records the exact verification method and a negative
control.

**Done.** No file above was modified, and no content from them was restated.
`importTerminology()` in `src/db/library-seed.ts` READS `terminology.ts` and
projects it into `technical_terms` / `technical_term_aliases`, so the vocabulary
becomes searchable and citable without becoming a second copy that can drift.
The import is wrapped in a try/catch that reports rather than fails the seed,
because it depends on a file under active development.

**Still open — the integration nobody has done yet.** `video-register.ts`
exports `VIDEOS` with per-video verification evidence, and `SOURCES` with
per-source provenance. These map cleanly onto `media_assets` +
`media_technical_links` (at state `new`) and `technical_sources`. Writing that
importer would put the whole verified register into the review queue, which is
where it belongs — a verified-embeddable video is still not a rights-cleared
one. It was **not** written in this patch because the file was being edited
during the session and the shape would have been a moving target. Owner: whoever
finishes the video register.

---

## 4. Two different meanings of "learn" — FLAGGED, NOT RESOLVED

**Found.** The directive asks for learner-facing technical pages at
`learn.mmakf.in/karate`. In this repository the `learn` surface
(`LEARN_NAV` in `src/lib/surface.ts`) is the **client and training-sales**
surface: schools, corporates, universities, government, communities,
individuals, coaches. The Shotokan technical content lives on the **public**
surface at `/kata` and `/shotokan`.

**Done.** Nothing moved. Putting kata pages under `/learn/` would collide with
an existing, coherent information architecture that another part of the system
depends on.

**Still open.** A decision for whoever owns information architecture: either the
technical library extends the public surface (`/kata`, `/shotokan`, and a new
`/kumite`), or a genuine learner surface is introduced and the sales surface is
renamed. This patch assumed the former and added no learner route, so no route
has to be un-picked either way.

---

## 5. `verificationStatus` symbol collision — RESOLVED

**Found.** `seller.schema.ts` already exports a TypeScript symbol named
`verificationStatus` (its SQL enum is `seller_verification_status`). The new
library enum needed the SQL name `verification_status`, which is free, but the
obvious TS name was taken; `export *` from the schema barrel made it a compile
error.

**Done.** The TS symbol is `technicalVerification`; the SQL type is
`verification_status`. No existing symbol was renamed.

---

## 6. RBAC — TWO ACTIONS ADDED

**Found.** No existing action expressed "may decide that a technique, an
application, or a third party's video meets the federation's technical
standard". `content:write` is editorial authority over federation copy and is
held by `MEDIA_OFFICER`.

**Done.** Added `technical:read` and `technical:review` to the `Action` union,
to `NATIONAL_FULL`, and to `TECHNICAL_DIRECTOR`. Purely additive — no role lost
an action, and no existing action changed meaning.

**Note for other agents:** if your patch needs to read the technical library,
gate on `technical:read`, not `content:read`.
