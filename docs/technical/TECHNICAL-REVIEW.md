# Technical review

**How something gets from "found on the internet" to "taught by MMAKF", and
what stops it skipping a step.**

Written 17 August 2026. Sources: `src/db/library.schema.ts`, `src/db/library.ts`,
`src/pages/admin/technical-library.astro`, `drizzle/0031_technical_library.sql`.

---

## The pipeline — §37

```
DISCOVERED  →  METADATA_FETCHED  →  CLASSIFIED  →  TECHNICAL_REVIEW
                                                          ↓
                        PUBLISHED  ←  APPROVED  ←  RIGHTS_CHECK
```

In the schema this is `library_review_state`:

```
new · classified · rights_review · technical_review ·
approved · published · rejected · archived
```

### Rejection reasons — §37

`wrong_style`, `low_quality`, `technically_unsuitable`, `duplicate`,
`rights_problem`, `misleading_metadata`, `outdated_rules`, `other`.

A rejection is a **record**, not a delete. Something rejected as
`outdated_rules` in 2026 may be perfectly usable historical reference in 2030,
and a row that vanished is indistinguishable from one that was never found.

---

## The three independent axes

The whole design turns on their independence, and collapsing any two is how a
federation ends up either committing copyright infringement or presenting a
stranger's interpretation as doctrine.

| Axis | Question | Column |
| --- | --- | --- |
| **Classification** | What is this about? | `technical_domain`, `media_technical_links` |
| **Rights** | May we host, embed, or only link? | `media_assets.rights` |
| **Endorsement** | Is it fit to teach? | `technical_reviews`, `*_approved_by_person_id` |

**Rights is answered first.** `/admin/technical-library` puts rights standing in
the first column, says so before the title on a blocked row, and does not render
the approve control at all where rights forbid it — and `reviewLink()` refuses
the same thing server-side, because a hidden button is a courtesy and not a
control.

---

## What AI may and may not do — §39

**AI output is candidate data. It is not technical truth.**

- `proposed_by` is an enum of `ai | human | import`, and it travels with every
  classification.
- `confidence` records how sure the model was.
- Every approval column is a nullable reference to a **person**, and the
  migration's `CHECK` constraints refuse an approved row that names no approver.
  The database — not a code path somebody can forget — is what makes "AI cannot
  declare MMAKF approval" true.
- `/admin/technical-library` renders a *Proposed by* column so a reviewer never
  mistakes a model's 94%-confident guess for a colleague's considered
  classification. Those warrant different scrutiny, and a screen that rendered
  them identically would invite rubber-stamping.

The discovery script obeys the same rule outside the database:
`scripts/discover-videos.mjs` labels every classification it emits as a machine
guess and **never writes** to the register or to the database.

---

## Verification states

`verification_status` on stored facts:

| State | Meaning |
| --- | --- |
| `unverified` | Nobody has established it. The honest default. |
| `source_documented` | A named source states it and the citation is on file. |
| `committee_verified` | An MMAKF technical reviewer has checked it. |
| `disputed` | Two credible sources disagree, and the record says so rather than silently picking a winner. |

**Unverified is a first-class state.** An empty field is honest; a plausible
number nobody can trace is not. The clearest example is per-kata movement
counts — see `KATA-LIBRARY.md`.

---

## Interpretation authorship — bunkai

`interpretation_kind` on `kata_applications`:

`traditional` · `instructor` · `mmakf_approved` · `historical` · `self_defence`

Bunkai is where federations most often blur authorship. A long-established
traditional reading, one named instructor's reading, and an MMAKF-endorsed
reading are three different claims, and a learner is entitled to know which one
they are being shown. `mmakf_approved` requires a named approver at the database
level.

---

## Corrections — §52

Technical knowledge must be correctable, and correcting it **must not silently
rewrite history**. A correction records the reason, the reviewer, the old state,
the new state and the effective date, so a member who trained against the
previous version can see what changed and when.

The same principle governs the grading engine in `technical.schema.ts`: a
syllabus revision creates a *new version* and supersedes the old one rather than
editing it, because certificates issued under the old one must keep their
meaning.

---

## Authority

`technical:read` to look, `technical:review` to decide.

Deliberately **not** `content:*`. A media officer who writes federation copy
holds `content:write`, and must not thereby be able to declare that a stranger's
kata demonstration is fit to teach, nor that MMAKF has the right to publish it.

---

## Source authority — §41

`technical_sources.authority_tier`:

```
mmakf_official        Tier A — MMAKF's own production and instructors
primary_reference     Tier B — JKA, recognised Shotokan technical bodies
competition_authority Tier C — WKF, Olympic and national competition bodies
educational           Tier D — established instructors and teaching channels
discovery             Tier E — found, not yet trusted
```

**The tier describes where something came from, never whether it is right.** A
Tier B reference can still be rejected by the technical committee, and a Tier E
discovery can still be excellent — it simply cannot become federation
instruction on its own authority.

§41 forbids encoding a permanent organisational hierarchy in code, so the seed
ranks in `src/data/shotokan/video-register.ts` are a starting position and the
administrator configures the rest.

---

## The static layer, and why it needs no review

`src/data/shotokan/*` and `src/data/kata.ts` hold **public martial-arts
knowledge** — the mechanics of gyaku-zuki, where the weight sits in
kokutsu-dachi, the meaning of a kata's name. This is common to every Shotokan
dojo in the world, is not an MMAKF claim, and is guarded by
`tests/shotokan-library.test.ts` and `tests/kata.test.ts` rather than by a
review queue.

Everything that *is* a claim — an application, an endorsement, a rights
decision, a curriculum placement — lives in the database and goes through the
pipeline above. See `SHOTOKAN-KNOWLEDGE-MODEL.md` for the full split.
