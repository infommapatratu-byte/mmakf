# MMAKF Admin Guide

*For the federation office. No technical knowledge required.*

## Signing in

1. Go to **www.mmakf.in/admin** (or `/admin` on any environment).
2. Enter the admin password. Sessions last **7 days** per browser.
3. **Logout** is at the bottom of the left sidebar.

If the password is lost, the site maintainer resets it in Vercel → Settings → Environment Variables → `ADMIN_PASSWORD` (see RUNBOOK).

## What appears where

| Admin panel | Shows up on |
|---|---|
| Federation Profile | Everywhere — name, tagline, address, phone, UPI, hours |
| Leadership | Homepage + About |
| Programs | Homepage, Programs page, and the enrolment form's program list |
| Schedule | Homepage + Schedule page |
| Events | Homepage + Events page |
| News | Homepage + Events page |
| Facilities | Facilities page |
| FAQs | FAQ page |
| Gallery | Gallery page |
| Syllabus | Belt System page (kata table) |
| Branches | Affiliation page (network register) |
| Shop Products | Homepage + Shop page |
| Achievements | Homepage + About |
| Testimonials | Homepage + About |

## Editing rules of thumb

- **New items appear first** on the public site (top of the list).
- **Delete asks for confirmation** and cannot be undone — re-add if needed.
- Changes are visible on the public site **immediately** on the next page load (apps reading the data feed may take up to 5 minutes).
- Keep at least one item in every list — an empty section looks unfinished.

## Icon names

Fields labelled *Icon* accept exactly these names:

`karate-gi, kata, kumite, shield, women, star, medal, globe, black-belt, book, school, users, pin, monitor, mat, target, dumbbell, water, first-aid, locker, cctv, parking, clock`

A misspelled icon shows an empty tile — fix the spelling and re-add.

## Field formats

- **Fees/prices**: plain numbers in ₹ (no commas, no ₹ sign) — e.g. `1200`.
- **Event dates**: three boxes — Day `15`, Month `JUN`, Year `2026`.
- **Schedule Mode**: exactly `dojo` or `online` (lowercase — controls the gold "online" badge).
- **Branch Status**: `Headquarters` gets the highlighted badge; anything else (Affiliated, Community, Digital) shows a plain badge.

## Enrolment leads

The **Enrolment Leads** panel lists free-trial requests, newest first (up to 500 kept; oldest drop off automatically). **Call every lead within 24 hours.** The site never emails or messages leads automatically — contact is always by the office.

If someone asks for their details to be removed, forward the request to the site maintainer (see RUNBOOK "Erasure request").

## If something looks wrong

- A section shows old content → hard-refresh the page (Ctrl+Shift+R).
- Saves fail repeatedly → the database may be down; try again in a few minutes, then contact the maintainer.
- You broke a list badly → the maintainer can reset any single section to its factory content without touching the rest (RUNBOOK "Reset a key to seed").
