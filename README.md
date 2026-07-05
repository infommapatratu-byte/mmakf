# MMAKF — Modern Martial Arts Karate-Do Federation of India

The official website + admin panel for **MMAKF**.

- **Established:** 1983
- **Style:** Shotokan Karate (Tiger Lee lineage)
- **Headquarters:** Patratu, Jharkhand, India
- **Grandmaster:** Shihan Pramod Kumar Pathak (VI Dan)
- **Affiliation:** WKF International Pathway

Built with **Astro** + **Vercel** + **Vercel KV**. Bold black/red/gold martial-arts identity, structured like the modern Bharat-tech ecosystem (italic-emphasis headings, status pills, restrained voice).

---

## What's inside

```
src/
├── pages/
│   ├── index.astro        # Homepage (hero → contact)
│   ├── about.astro        # Story, dojo kun, lineage, leadership, achievements
│   ├── programs.astro     # All training programs + methodology
│   ├── facilities.astro   # Dojo facilities & safety standards
│   ├── schedule.astro     # Weekly timetable + dojo etiquette
│   ├── belt-system.astro  # Kyu/Dan grading + kata syllabus
│   ├── events.astro       # Tournaments, gradings, seminars + news
│   ├── gallery.astro      # Filterable gallery
│   ├── shop.astro         # Equipment & merchandise with category filter
│   ├── faq.astro          # Accordion FAQ
│   ├── contact.astro      # Contact cards + map + enrolment form
│   ├── affiliation.astro  # Dojo charters, officials certification, branch network
│   ├── admin/
│   │   └── index.astro    # Password-gated admin (login + dashboard)
│   └── api/
│       ├── data.ts        # GET all content
│       ├── data/[key].ts  # POST single content key (admin only)
│       ├── enroll.ts      # POST enrol lead from public form
│       └── auth/
│           ├── login.ts   # Admin login
│           └── logout.ts  # Admin logout
├── components/
│   ├── PageHero.astro     # Shared sub-page header (kanji watermark)
│   ├── EnrollCTA.astro    # Reusable free-trial CTA + form
│   ├── Icon.astro         # Inline SVG icon set
│   ├── Crest.astro        # Federation crest
│   └── ListPanel.astro    # Generic list editor for admin
├── layouts/
│   └── Base.astro         # Site shell, nav, footer, PWA hook
├── lib/
│   ├── storage.ts         # Upstash Redis → in-memory fallback
│   └── auth.ts            # HMAC-signed cookie session
├── data/
│   └── seed.ts            # Default federation content (16 editable keys)
└── styles/
    └── global.css         # Black / crimson / antique-gold design tokens

public/
├── manifest.webmanifest   # PWA install metadata
├── sw.js                  # Service worker (offline support)
└── robots.txt
```

---

## Local development

```bash
npm install
npm run dev
```

- Public site: http://localhost:4321
- Admin:       http://localhost:4321/admin
- Default password (dev): `mmakf2025`

In dev mode without Vercel KV configured, the storage layer keeps data **in memory** — restarting the server resets to seed data. That's fine for development; production runs against KV.

---

## Deployment to Vercel

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial MMAKF site"
git remote add origin git@github.com:YOUR_USERNAME/mmakf.git
git push -u origin main
```

### 2. Create the Vercel project

1. Go to **https://vercel.com/new** and import the repo.
2. Framework will auto-detect as **Astro**. Leave defaults.
3. **Do not deploy yet** — set up KV first.

### 3. Add Upstash Redis (data store)

Vercel KV was retired in late 2024 and replaced by the Upstash Redis marketplace integration. The setup is similar:

1. On your Vercel project page, open the **Storage** tab.
2. Click **Browse Marketplace** → choose **Upstash Redis** → **Connect**.
3. Vercel will walk you through creating an Upstash account (or connecting an existing one) and provisioning a free Redis database in the region closest to your project.
4. When it completes, Vercel auto-injects `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` into your project's environment variables.

### 4. Set admin env vars

In **Settings → Environment Variables**, add:

| Variable | Value | Environments |
|---|---|---|
| `ADMIN_PASSWORD` | (choose a strong password) | Production, Preview |
| `ADMIN_SESSION_SECRET` | (run `openssl rand -base64 32`) | Production, Preview |

### 5. Deploy

Click **Deploy**. First deploy seeds default content. After that, edit everything in `/admin`.

### 6. Custom domain

In **Settings → Domains**, add `www.mmakf.in` and `mmakf.in`. Point your DNS A/CNAME records as Vercel instructs. SSL is automatic.

---

## Admin guide

`/admin` is password-gated. Once signed in, you can edit:

- **Federation Profile** — name, tagline, address, UPI, contact details
- **Leadership** — office bearers and senseis
- **Programs** — training programs and fees
- **Schedule** — weekly class timetable
- **Events** — upcoming tournaments and gradings
- **News** — announcements
- **Facilities** — dojo facilities on /facilities
- **FAQs** — questions on /faq
- **Gallery** — items on /gallery
- **Syllabus** — grading requirements on /belt-system
- **Branches** — federation network on /affiliation
- **Shop Products** — equipment and merch
- **Achievements** — institutional recognition
- **Testimonials** — words from warriors
- **Enrolment Leads** — captured from the public form

All edits write to Vercel KV and reflect on the public site on next load (60s edge cache).

---

## Tech notes

- **Astro** server-rendered output (`output: 'server'`) so that `/api/*` and admin auth work on Vercel's serverless functions.
- **Storage** uses Upstash Redis (Vercel marketplace integration). The same `storage.ts` falls back to an in-memory map for local development — no separate code paths to maintain.
- **Auth** uses a signed cookie (HMAC-SHA256) — no JWT library, no database session table. The signing secret is the `ADMIN_SESSION_SECRET` env var.
- **PWA** is enabled — the service worker caches the home page and static assets for offline use. Admin and API are excluded from cache.
- **Edge caching** — `/api/data` is cached at the edge for 5 minutes. Trigger a redeploy or wait the TTL to see admin changes on the public site immediately; otherwise the public site picks them up on the next cache miss.

---

## Changing styles

All design tokens live in `src/styles/global.css` under `:root`. Swap `--red`, `--gold`, `--bg` and the entire site re-themes.

The signature display heading style (`.display-1`, `.display-2`) uses Oswald for the bulk of the text and Cormorant Garamond *italic* for emphasis words — change either font in the `@import` at the top of `global.css` and across `--font-display` / `--font-accent` tokens.

---

© MMAKF · Made in Bharat with discipline.
