# Video rights

**What MMAKF may show, what it may only link to, and what it may not touch.**

Written 17 August 2026.

---

## The rule in one sentence

**Finding a video is not permission to publish it, and another organisation's
editorial judgement is not a rights clearance.**

---

## Three things that are constantly confused

| | Question | Answered by |
| --- | --- | --- |
| **Classification** | What is this about? | A human, possibly proposed by a model |
| **Rights** | May MMAKF host, embed, or merely link to it? | A human, from evidence |
| **Endorsement** | Is this fit to teach as Shotokan? | A named MMAKF technical reviewer |

A video can be perfectly classified, technically excellent, and still not
MMAKF's to publish. Treating relevance as permission is how a federation ends up
republishing someone else's footage under its own banner — which §49 forbids by
name.

`src/db/library.ts` enforces the order: the rights question is answered
**first**, and `reviewLink()` refuses an approval on a rights-blocked row
server-side, not merely by hiding a button.

---

## The structural test the register can answer

There is exactly one rights question a script can settle, and the register
records it as `channelIsSourceOrganisation`:

> **Did the organisation being cited upload this to its own channel, or did
> somebody else upload it and the organisation then embed it?**

### Group 1 — the organisation's own channel (70 recordings)

JKA India's camp, kihon and kumite footage on `@JKAIndiahq`; Cambridge
University Karate Club's footage on `@cukarate`. The organisation published it,
left embedding switched on, and is the party with standing to say so.

**Standing:** citable and linkable, with attribution.

### Group 2 — third-party uploads (51 recordings)

The complete 26-kata collection on `skif.co.nz` plays from a channel called
`shotokankataman`. Colchester JKA's kata page plays Enoeda and Ohta Sensei's JKA
demonstrations from `iZafod` and `1000MOSHT`.

These are **the best technical material in the whole register**, and nobody in
this repository knows whether the uploader had the right to upload them. SKIF
NZ's decision to embed them is SKIF NZ's; it is not a rights clearance, and it
is certainly not MMAKF's.

**Standing:** listed with full attribution, **not embedded**, held pending a
technical-committee decision.

`tests/shotokan-library.test.ts` asserts that no third-party channel can reach
the publishable set. `tests/routes-live.test.ts` asserts that no page in the
library emits a YouTube `<iframe>` at all.

---

## Absolute prohibitions

None of these is a judgement call.

- **No downloading.** Not one file. The test suite greps the source for
  `youtube-dl` and `yt-dlp`, and for any phrasing about downloading or rehosting
  a video.
- **No rehosting.** The register stores ids and canonical URLs, nothing else.
- **No claiming another organisation's material as MMAKF's.** JKA and SKIF are
  cited constantly and claimed never; there is a guard for that phrasing too.
- **No adopting another organisation's grading syllabus.** The JKA grading
  guideline is loaded into `reference_curricula` with `adopted_by_mmakf` false
  and is unreachable from the MMAKF grading engine.

---

## What the surfaces actually do

| Surface | Group 1 | Group 2 | MMAKF's own |
| --- | --- | --- | --- |
| `/shotokan/videos` | Listed, linked, attributed | Listed and attributed, standing shown | Listed and linked |
| `/shotokan/techniques/[slug]` | "Watch on YouTube" link | An explanation of why it is held | — |
| `/kata`, `/kata/[slug]` | — | — | Federation footage only, described as training footage rather than as a performance of a named form |

**No page embeds a player.** That is a deliberate position, not an oversight:
until the technical committee has recorded a rights decision, an embed on an
MMAKF page presents a stranger's recording as federation material to every
visitor who does not read the caption.

---

## Competition footage — §42

Every competition recording is labelled **COMPETITION REFERENCE** and never as a
teaching standard. A winning performance shows what won on that day under those
rules. It is not automatically the canonical version of a form, and presenting
it as one teaches students to copy a performance optimised for a scoring system
that will change.

14 of the 121 registered recordings are competition performances.

---

## Where the authoritative rights state lives

The register is the *research*. The authoritative per-asset state is
`media_assets.rights` — `cleared`, `federation_owned`, `licensed`,
`permission_pending`, `restricted`, `not_cleared` — with `rights_holder`,
`rights_note` and `consent_evidence` beside it.

`technical_sources.rights_policy` records a source's general position, and it is
**context, not a verdict**: an individual video on an otherwise permissive
channel can still be restricted, so rights remain a per-asset decision.
