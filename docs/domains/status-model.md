# The status model

§102 — *"Never use Active / Enabled / Live / Running interchangeably unless they
mean different states. Define a federation-wide status dictionary."*

`src/lib/status.ts` is that dictionary. `src/components/Status.astro` is the only
place a status becomes something a person reads.
`tests/status-dictionary.test.ts` is what stops both from quietly rotting.

---

## What was wrong

Twenty-eight status enums across ten schema files, and each surface invented its
own colour and wording for them. `active` meant four different things —

- this dojo holds a current charter
- this coach is available for assignment
- this membership is paid up
- this competition is happening right now

— four facts wearing one word, each painted whatever colour the page author
reached for. `failed` was amber on one screen and red on another. `active`
appeared as ACTIVE, Active and active on three surfaces of the same product.

**The dictionary does not replace those enums.** The database is right to have
distinct vocabularies: a booking status and a coach status are genuinely
different, and collapsing them would let a coach be `rescheduled`. What it
replaces is the twenty-eight private opinions about how each one *looks* and
what it *means*.

---

## Eight tones

A tone is a promise to the reader about what kind of fact they are looking at,
and it is the **only** thing that decides colour.

| Tone | The promise | Entries | Painted from |
|---|---|---|---|
| `neutral` | A fact with no charge. Draft. Archived. | 29 | `--muted` on `--border` |
| `progress` | Something is underway and **nobody is waiting on the reader**. | 31 | `--off-white`, transparent |
| `waiting` | **Somebody must act.** | 21 | `--gold-3` on `--gold-dim` |
| `good` | The desired end state. Approved. Confirmed. Paid. | 37 | `--gold-3` on `--gold-dim` |
| `live` | Happening **now**. | 5 | `--red-2` |
| `warn` | Recoverable, and the reader should look. | 22 | `--numeral` |
| `bad` | Failed, rejected, cancelled. Terminal and unwanted. | 14 | `--red` on `--red-3` |
| `stopped` | **Deliberately halted by a person.** | 7 | `--off-white` on `--control-border` |

166 statuses in the dictionary. Every colour is an existing palette token —
several were chosen to clear a measured contrast ratio, and a tone that
introduced its own hex would sit outside that work entirely. The test asserts
no `toneVars()` branch contains a literal hex.

The tones are deliberately few. Nine would mean nobody could remember which to
use.

### The distinctions that earn their place

Four tones would cover the colour wheel. These are the four that do real work,
and each is asserted by a named test.

**`waiting` vs `progress` — somebody must act, versus something is happening.**
`submitted` and `under_review` look alike to a reader and are not alike to a
queue: one is being worked, the other is not. A queue that cannot tell them
apart is a queue nobody works. `submitted` is `waiting` and actionable;
`under_review` is `progress` and is not.

**`stopped` vs `bad` — a decision, versus an outcome.**
`suspended` is somebody's decision about a person's standing. `failed` is an
outcome. Painting them the same colour tells a coach their suspension is a
system error, or tells an operator that a failure was deliberate. `withdrawn` is
`stopped`; `rejected` is `bad`.

**`live` vs `good` — because `live` decays.**
A live match needs watching; a completed one does not. `live` is the only tone
that moves: the dot pulses, because it is the one state a reader must notice
without reading, and it is rare enough on a screen not to become wallpaper. The
global `prefers-reduced-motion` rule reduces it to a stopped frame.

**`warn` vs `bad` — for the cases where the difference is a person.**
`referred` on a grading candidate means *not awarded this time, and you may
present again*. Telling somebody they failed when the panel said "come back" is
a misrepresentation of a decision, so it is `warn`, not `bad`.

### Four tonings that were judgement calls, and why

- **`deceased` is `neutral` and carries no colour.** A person is not a failure
  state, and rendering this in red would be indefensible on a register a family
  may read.
- **The three push suppressions are `neutral`, not `bad`.**
  `suppressed_quiet_hours`, `suppressed_preference` and `suppressed_duplicate`
  mean the system honoured a preference or a quiet hour — the behaviour that was
  asked for. Painting them as failures would push somebody to "fix" them.
- **`walkover` is `neutral`, not `good` or `bad`.** It is won without a contest,
  which is a different fact from winning one.
- **`partially_failed` is `warn` and actionable, not `bad`.** Its meaning is the
  most consequential sentence in the file: *"SOME EFFECTS ALREADY HAPPENED.
  Check what completed before re-running."* An operator who reads it as "it
  failed, run it again" duplicates whatever the first run completed. A test
  asserts the meaning still matches `/already/i`.

---

## What a status carries

```ts
interface StatusMeaning {
  label: string;        // Sentence case. Never SCREAMING_SNAKE at a human.
  tone: Tone;
  meaning?: string;     // The operational explanation. Tooltip and legend.
  actionable?: boolean; // Somebody must do something for this to move.
  terminal?: boolean;   // Nothing follows.
}
```

41 statuses are `actionable`; 40 are `terminal`.

`actionable` drives the §19 dashboard question — *what needs my attention?* —
without every surface re-deciding which of its twenty statuses count as pending.
`terminal` lets a surface grey out actions that cannot apply.

### The API

| Function | Returns |
|---|---|
| `statusOf(value, domain?)` | The `StatusMeaning`. **Never throws.** |
| `needsAction(value, domain?)` | `actionable === true` |
| `isTerminal(value, domain?)` | `terminal === true` |
| `toneVars(tone)` | The CSS custom properties, as an inline `style` string |
| `humanise(value)` | `results_published` → `Results published` |
| `knownStatuses()` | Every raw value. Used by the drift guard. |
| `LIFECYCLES` | 13 named lifecycles, in the order work flows |

`toneVars` returns a style string rather than a class so a status can be
rendered anywhere without that surface having imported a stylesheet — and so
there is exactly one place where a tone becomes a colour.

**Nothing throws at a surface.** An unrecognised value returns the humanised raw
value with a `neutral` tone and no meaning — deliberately not "Unknown status",
because the reader is not helped by being told the software is confused. They
are helped by seeing the raw value, which is at least the truth and is what they
will quote when they report it. `null`, `undefined` and whitespace all render as
`—`.

### Domains, for the words that genuinely differ

`BY_DOMAIN` overrides six domains: `membership`, `coach`, `institution`,
`venue`, `motion`, `program`.

`active` is the value that forced it. For a coach it means "available for
assignment"; for a membership it reads **"Current"** and means "paid up and in
good standing"; for a venue it reads **"In use"**. A competition would mean
"happening now", which is why competitions use `live` and do not appear here.

`referred` is the other one, and the difference is a person's grading result
against a committee's paperwork: in grading it means "not this time, present
again"; under `motion` it is re-toned to `neutral` and means "sent to a
committee rather than decided here".

### Lifecycles are listed in the order work flows

`LIFECYCLES` covers `application`, `lead`, `task`, `ticket`, `coach`,
`assignment`, `booking`, `session`, `quote`, `contract`, `payment`,
`program_template` and `workflow`.

Ordering is lifecycle order, not alphabetical. A filter menu reading
`approved, cancelled, draft, rejected, submitted` tells the reader nothing about
how work actually moves. A test asserts the application lifecycle is **not**
sorted, and that `draft` precedes `submitted` precedes `approved` — which
asserts the ordering was a decision rather than an accident.

### Payments get their own guarantees (§46)

Never show an ambiguous payment state. Three tests hold it:

- every value in `LIFECYCLES.payment` has a tone, and **no two read the same
  label**;
- `processing` says *"With the payment provider. Do not retry."*;
- `failed` says *"Did not complete. No money moved."*

---

## How the drift guard works

`tests/status-dictionary.test.ts`. The failure mode it exists for is silent and
certain: somebody adds a value to a `pgEnum`, no page breaks, and that one
status renders as a grey chip with a humanised label while every other status on
the same screen carries a tone and a meaning. It looks fine. It is wrong, and
nobody finds out.

So the guard does not check the dictionary against itself. **It reads the actual
enum labels out of the migration files.**

1. Walk `drizzle/*.sql` for `CREATE TYPE "public"."<name>" AS ENUM(...)`.
2. Keep only enums whose name ends in `status` or `outcome`. `audience_kind` and
   `fee_rule_kind` are taxonomies, not lifecycles, and forcing them through a
   status chip would be the opposite of what the dictionary is for.
3. Assert the dictionary knows every label, and name every one it does not.
4. A separate test asserts more than ten enums were found — otherwise every
   test below it would pass vacuously against an empty set.

**It caught 94 untoned statuses the first time it ran.** Every one existed in
the database and rendered as a bare grey chip. They are marked in the source
with a comment recording where they came from.

The rest of the file guards the properties that make the dictionary worth
having: every known status has a tone; no tone paints with a raw hex; no label
contains an underscore or renders in caps; the four distinctions above hold; and
`statusOf` survives `null`, `undefined`, `''` and an unseen value.

---

## Rules

**DO** pass the raw database value to `<Status>` and let the dictionary decide.
**DO** add the value to `DICTIONARY` in the same change that adds it to a
`pgEnum` — the guard will fail the build otherwise, which is the intent.
**DO** give a new entry a `meaning` if a reader could plausibly misread it.

**DON'T** render a status any other way. Not a hand-written chip, not a
capitalised column value, not a coloured `<span>`.
**DON'T** add a ninth tone. If a status does not fit, the question is which of
the eight promises it actually makes.
**DON'T** introduce a hex colour in `toneVars()`. The palette was fixed by the
federation and several values were chosen to clear a measured ratio.
**DON'T** put a taxonomy through this. A kind is not a lifecycle.

---

## What this model does not do

- **It does not validate transitions.** The dictionary says what a status
  *means*; it has no opinion on whether `draft → approved` is legal. That lives
  in the domain modules (`coaches.ts` refuses skipped stages, for instance), and
  `LIFECYCLES` is an ordering for menus and legends, not a state machine.
- **It does not cover non-status enums**, deliberately. Taxonomies are excluded
  by the guard's own filter.
- **`LIFECYCLES` is hand-maintained**, and only 13 of the enums have one. A
  domain with no entry gets no ordered filter menu; nothing fails, and nothing
  points it out.
- **The tone histogram is uneven by construction** — `good` has 37 entries and
  `live` has 5. That reflects the domain rather than a gap.
- **`domain` is opt-in at the call site.** A page that omits `domain="membership"`
  gets "Active" rather than "Current". Nothing detects the omission, because
  nothing can tell the difference between a missing domain and a value that
  genuinely has no override.

- **`good` and `waiting` are not distinguishable by colour.** Read from
  `toneVars()`:

  ```
  good     --st-fg: var(--gold-3);  --st-bd: var(--gold-dim);  --st-bg: rgba(160,124,30,0.08);
  waiting  --st-fg: var(--gold-3);  --st-bd: var(--gold-dim);  --st-bg: rgba(160,124,30,0.06);
  ```

  Identical foreground and border; a two-percent difference in background
  alpha, which is not a perceptible difference. So the file's claim that a tone
  is "the only thing that decides colour" holds, but the reverse does not: the
  `waiting` / `good` distinction — the one the model argues hardest for — is
  carried in practice by the **label**, the **meaning** and the `actionable`
  flag, not by the chip's colour. A reader scanning a queue for what needs
  action cannot do it on colour alone.

  This is a finding, not a defect with an obvious fix. The palette is small and
  fixed, `--gold-3` is the only text-safe gold, and inventing a colour to
  separate them would breach the rule that every tone paints from an existing
  token. Resolving it properly means either a non-colour affordance on
  `actionable` statuses, or a federation decision to extend the palette.
  Nothing currently tests for it, and no test would have caught it — the guard
  checks that each tone paints *something* and that it contains no raw hex,
  not that any two tones differ.

---

## Related

- [design-system.md](design-system.md) — the `<Status>` API and the tokens
- `src/lib/status.ts`, `src/components/Status.astro`
- `tests/status-dictionary.test.ts`
