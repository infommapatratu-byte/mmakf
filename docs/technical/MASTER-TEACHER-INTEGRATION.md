# Master Teacher integration

**Channel synchronisation, live detection, and the review step that stops a
family video becoming curriculum.**

Written 17 August 2026. Sources: `src/lib/youtube.ts`,
`src/db/education.schema.ts`, `src/db/library-seed.ts`, `src/pages/live.astro`.

---

## The problem being solved — §24, §25

When an authorised Master Teacher goes live on their own channel, the class must
appear inside MMAKF **by itself**. Requiring an administrator to paste a URL
every time is what makes live classes quietly stop happening: the workflow
survives exactly as long as somebody remembers.

YouTube is the streaming **transport**. MMAKF is the authoritative learning
environment — attendance, questions, curriculum links and progress live here.

---

## What is built

| Stage | Where |
| --- | --- |
| OAuth connect (read-only scope) | `authorisationUrl()`, `exchangeCode()` |
| Channel registration | `registerChannel()` → `media_channels` |
| Explicit, revocable authorisation | `setChannelAuthorisation()` |
| Broadcast polling — live and upcoming | `syncBroadcasts()` → `broadcasts` |
| Live class creation | `live_classes`, keyed on the broadcast |
| End detection and recording capture | `closeStaleBroadcasts()` → `media_assets` |
| Classification and rights | `classifyAsset()` |
| Public surface | `/live`, `liveNow()`, `upcomingClasses()` |
| Curriculum mapping | `live_class_resources` (`technique_id`, `kata_id`) |

---

## The two decisions that are deliberately separate

### Connecting a channel is not authorising it

`registerChannel()` sets `authorised: false` **always**. Collapsing the two would
mean a teacher's entire upload history became federation content the moment they
clicked Connect.

### Discovery is not publication

Everything discovered lands `classification: 'pending_review'` and
`rights: 'not_cleared'`. A teacher's channel carries personal and family
material alongside teaching material, and §24 is explicit: *do not automatically
classify every channel upload as curriculum.*

`autoPublishLive` exists and defaults to **false**. A live class is created for
every detected broadcast and published only where the federation has explicitly
configured that channel to auto-publish.

### Relevance is not permission

`classifyAsset()` refuses to publish unless **both** the classification is
federation-relevant **and** the rights are cleared:

```
PUBLISHABLE  federation_official, federation_relevant, master_teaching,
             shotokan_technical, seminar, competition, historical
CLEARED      cleared, federation_owned, licensed
```

The error message says so in words: *"Rights for this asset are X. Clear the
rights before publishing — relevance is not permission."*

---

## Security posture

- Only **refresh tokens** are stored, encrypted with AES-256-GCM (authenticated,
  so a tampered ciphertext fails to decrypt rather than yielding plausible
  garbage that gets sent to Google as a credential). Access tokens are held in
  memory and never persisted.
- No token of any kind reaches a browser. Every API call is server-side.
- Storing a token is **refused** when `MEDIA_TOKEN_KEY` is unset. Writing a
  long-lived Google credential in plaintext because a variable was missing is
  exactly the failure that guard exists for.
- Read-only scope: `youtube.readonly`. The federation never needs to post, edit
  or delete on a channel.
- A channel owner can revoke consent at Google's end at any time. `tokenStatus`
  moves to `revoked` and `lastSyncError` records why, so the office sees why
  syncing stopped rather than watching it silently do nothing.

`integrationStatus()` reports exactly which variables are missing, so a surface
can state the real reason instead of rendering a Connect button that cannot
work.

---

## Idempotency

Broadcasts are keyed on `(channelId, externalId)` with a unique index, so the
same broadcast can never be recorded twice however often the poller runs. That
matters because it runs on a schedule and **will** overlap itself the moment one
run is slow.

`syncBroadcasts()` never throws for one channel's failure. A revoked token on
one teacher's channel must not stop every other channel from syncing; the error
is recorded per channel and the run continues.

A broadcast that has ended moves to `recording_processing` and is **retried**
rather than marked missing on the first look — a recording that had simply not
finished processing must not be permanently written off.

---

## The Pramod Pathak channel — an honest gap

The directive names `https://www.youtube.com/@PramodPathakMartialArt` as the
MMAKF Master Teacher source.

**It is registered at tier `educational`, not `mmakf_official`.**

The channel page could not be read to confirm the affiliation — YouTube serves
an application shell, so no channel id, upload count or statement of MMAKF
affiliation was obtainable without the Data API. Registering it as Tier A on the
strength of the directive alone would be recording an unverified affiliation as
a verified one, which is the specific failure this project has committed before.

Promoting it is a federation decision and takes one row update. Leaving the
honest tier in place until then costs nothing except an accurate label.

Four recordings from that channel and from `@mmak_india` **are** published, in
`FEDERATION_KATA_FOOTAGE` in `src/data/kata.ts`, each with the id, the channel
it resolved to, the date it was checked and the method — and each described as
**training footage rather than a performance of a named kata**, because that is
what the channels say they are.

---

## What is not built

Stated plainly rather than left for a reader to discover:

- **No channel id is stored for the Master Teacher channel.** Polling needs one,
  and obtaining it needs either the Data API with a key or a manual lookup by an
  administrator.
- **Multi-angle synchronised playback** (§28) is not built. The schema has no
  camera-angle grouping, and MMAKF has recorded no multi-angle material for it
  to group.
- **The technical player** (§29) — chapter markers, speed control, loop, frame
  navigation, notes — is not built. `media_chapters` exists to hold the markers;
  nothing consumes it yet.
- **Timeline generation** (§30) is not built, and §30's own rule is why nothing
  was faked: *do not fabricate timestamps; generate only from actual reviewed
  media.* No reviewed media exists to generate from.

See `docs/IMPLEMENTATION-STATUS.md` for how this repository accounts for
unfinished work.
