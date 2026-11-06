# MMAKF learning ecosystem — Phase 1 audit and architecture map

Audited 2026-11-06 against the repository (commit `fca04af` and later) and the
production database. This is the map the master prompt asks for before any
build. Rule followed: **wire what exists before writing anything new**. This
repository's characteristic defect is a complete, tested engine that no page,
route or schedule reaches.

## 1. What the platform is today

| Layer | What exists | State |
|---|---|---|
| App | Astro 5, server-rendered, on Vercel Pro (team `edurankai`, functions in `bom1`, Mumbai) | Live at www.mmakf.in |
| Database | Postgres on Supabase (ap-south-1), drizzle-orm + postgres.js, 306 tables, migrations through `0059` | Healthy; schema current |
| Legacy content | Upstash Redis (editorial CMS keys, rate limits) | Live |
| Files | Vercel Blob (`src/lib/blob-store.ts`, `src/pages/api/uploads/*`) — public editorial images | Live; the store still belongs to the old Vercel team |
| Payments | Razorpay (live), signed webhook, orders / payments / invoices / ledger | Live |
| Email | SMTP through the GoDaddy Titan mailbox (`SMTP_*`, `EMAIL_FROM`) | Built; waits for `SMTP_PASS` |
| Push | Web push (VAPID, own implementation, `src/lib/push.ts`) | Live |
| Scheduled jobs | `/api/cron/reconcile` (daily), `/api/cron/notify` (every 5 min), `/api/cron/media-sync` | media-sync **exists but is not scheduled** |

The master prompt suggests Next.js and Supabase Auth. Neither is used and
neither is needed: the platform has its own accounts, sessions, MFA and RBAC.
Replacing them would break every existing account and audit trail, so the
stack stays.

## 2. Audit, item by item

1. **Source** — one Astro application; domain modules in `src/db/*`, shared
   services in `src/lib/*`, admin pages in `src/pages/admin/*` behind
   `AdminShell` (each page declares the permission it needs).
2. **Database** — 306 tables. Learning-relevant ones: `courses`,
   `course_modules`, `lessons`, `quizzes`, `enrolments`, `lesson_progress`,
   `certificates`, `live_classes`, `live_class_attendance`, `media_channels`,
   `media_assets`, `broadcasts`, `training_products`, `training_plans`,
   `training_programs`, `class_sessions`, `schedules`, `fee_schedule`,
   `orders`, `payments`, `invoices`, `notifications`, `push_devices`.
3. **Courses and programmes** — the academy engine is complete (author →
   publish → enrol → learn → assess → certify, plus live classes) and holds
   **0 courses**. There is **no authoring page**: `createCourse`,
   `publishCourse` and `scheduleLiveClass` have no caller. Learners reach it at
   `/my/courses`. The public `/academy` page still reads the legacy Redis CMS.
4. **Accounts** — 29 accounts; Super Admins `admin@mmakf.in` and the owner's.
   About 20 are QA test accounts with no role.
5. **Fees and payments** — `fee_schedule` is what checkout charges. It now has
   a governed door (`/admin/fee-register`: load the 2026 fee master, approve,
   archive). The fee **framework** (`/admin/fees`) prices institutional
   quotations — a separate register, kept.
6. **Authentication and permissions** — own accounts (scrypt), session epochs,
   MFA tables, role bindings scoped national / state / district / dojo. Roles
   include SUPER_ADMIN, FEDERATION_ADMIN, TECHNICAL_DIRECTOR,
   TRAINING_DIRECTOR, EDUCATION_OFFICER, MEDIA_OFFICER, COACH_MANAGER,
   INSTITUTION_ADMIN and others. **No Google Sign-In.**
7. **Video and documents** — video is YouTube only, by design (no rehosting).
   Documents: public uploads to Blob only; no private document store, no Drive.
8. **Google integrations** — only YouTube OAuth (`youtube.readonly`). No
   Classroom, Meet, Drive, Calendar or Sign-In.
9. **YouTube** — a full multi-channel engine exists in `src/lib/youtube.ts`:
   OAuth with encrypted refresh tokens, a channel registry (`media_channels`:
   owner, authorisation, scopes, token status, `autoPublishLive`, sync errors),
   assets with a teacher **classification** workflow and rights/consent fields
   (`media_assets`), and live broadcast detection (`broadcasts`,
   `syncBroadcasts`, `closeStaleBroadcasts`, `liveNow`, `upcomingClasses`).
   **Doors missing:** nothing calls `authorisationUrl`, `exchangeCode`,
   `registerChannel`, `setChannelAuthorisation`, `classifyAsset` or
   `pendingReview`, and media-sync is unscheduled. Only the read side is wired
   (`/live`, `/my`). On the new Vercel project `YOUTUBE_CLIENT_ID`,
   `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`, `YOUTUBE_API_KEY` and
   `MEDIA_TOKEN_KEY` are not set.
10. **Hosting** — Vercel Pro; Supabase free tier (watch pooler limits); cron
    on Vercel.
11. **Reusable** — `AdminShell`, `PageHeader`, `DataTable`, empty/error states,
    `Base` layout with design tokens, the notification queue (in-app, email,
    push), the fee register, the course payment path, the ICS calendar feeds
    (`/calendar.ics`, `/my/calendar/<secret>.ics`).
12. **Gaps and debt** — the doors above; no unified timetable page; no
    provider-independent meeting layer (live classes assume YouTube); no
    Google OAuth framework beyond YouTube; product admin (shop) is uncommitted
    work from another session; Blob and Redis still live in the old team.

## 3. Build order (master prompt phases mapped to reality)

| # | Work | Kind | External setup |
|---|---|---|---|
| A | **Academy authoring** — create courses, modules and lessons (video from approved YouTube assets, text, live), quizzes; attach a fee from the fee register; schedule timed live classes; publish | Door to an existing engine | None |
| B | **Integration Centre** — one page with the true state of every provider (Razorpay, email, push, storage, YouTube, Google), its scopes, last sync and errors | New page over existing status functions | None to view |
| C | **YouTube connect** — OAuth start + callback routes, channel registry, playlist→course mapping, the classification review queue, media-sync on a schedule | Doors to an existing engine | Google Cloud project, YouTube Data API v3, OAuth client, `MEDIA_TOKEN_KEY` |
| D | **Meeting providers** — a live class carries a provider (YouTube Live, Google Meet, Jitsi) and its link; one unified timetable (day/week/month) across classes, broadcasts and deadlines | New, small | None for links; Google OAuth for creating Meet spaces |
| E | **Google OAuth framework** — one connection table for Google scopes per user/institution, token refresh and revocation, then Calendar (+ Meet via conference data), then Classroom, then Drive (`drive.file`) | New | Google Cloud OAuth client; app verification for sensitive scopes; Workspace for Education for some Classroom features |
| F | Storage abstraction for private course material (signed URLs) | New | Private bucket (Supabase Storage or Blob private) |
| G | Design system pass for the learner and teacher dashboards | Refinement | None |

## 4. Open-source recommendation (smallest reliable set)

- **Jitsi Meet (hosted meet.jit.si links first, self-host only if needed)** —
  zero-cost live classes for teachers without Google; links only, no install.
- **YouTube** for video, **Razorpay** for money, **Postgres** as the record.
- **xAPI** later, emitted from the existing lesson progress, when an external
  LRS is wanted. **SCORM / H5P** only when a real package needs importing.
- **Not now:** Moodle, Open edX (duplicate LMS), Keycloak (own auth works),
  Nextcloud / OnlyOffice / Collabora (Drive covers collaboration), Matrix,
  BigBlueButton (hosting burden), n8n, MinIO (no self-hosting need yet).

## 5. External setup the owner must do (cannot be done from code)

1. Google Cloud project for MMAKF; enable YouTube Data API v3 (and later
   Calendar, Classroom, Drive, Meet).
2. OAuth consent screen. `youtube.readonly`, `calendar.events` and Classroom
   scopes are **sensitive**: in "Testing" mode only listed test users can
   connect; publishing to everyone needs Google's verification. Restricted
   scopes (broad Drive read) need a paid security assessment — use
   `drive.file` instead.
3. OAuth client (web) with redirect URI
   `https://www.mmakf.in/api/integrations/youtube/callback`.
4. Then set on Vercel (Production): `YOUTUBE_CLIENT_ID`,
   `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`, optionally
   `YOUTUBE_API_KEY`. `MEDIA_TOKEN_KEY` is generated on our side.

Nothing in this document claims a Google or YouTube capability works until a
real connection has been made and observed.
