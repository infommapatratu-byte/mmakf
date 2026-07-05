# MMAKF Ops Runbook

*For the site maintainer. Spec references: docs/MASTER-SPEC.md §14.*

## Environments

| Env | URL | Data | Notes |
|---|---|---|---|
| Local | `npm run dev` → :4321 | in-memory (resets on restart) | password `mmakf2025` |
| Preview | Vercel preview URLs | set preview-scoped `UPSTASH_*` to a **separate** DB | never point previews at prod Redis |
| Production | www.mmakf.in | Upstash prod DB (Mumbai) | strong secrets required |

## Required production env vars

`ADMIN_PASSWORD` (≥12 chars) · `ADMIN_SESSION_SECRET` (`openssl rand -base64 32`) · `UPSTASH_REDIS_REST_URL` · `UPSTASH_REDIS_REST_TOKEN`.
Login returns **500 "Server not configured"** if the first two are missing in prod — by design.

## Deploy & rollback

- Deploy: push to `main` → Vercel builds and promotes. CI (GitHub Actions) runs `npm test` + `npm run build` on every push/PR.
- Verify after deploy: `GET /api/health` → `{"ok":true,"redis":true,...}`; spot-check `/`, `/admin` login, one admin save, one enroll POST.
- Rollback: Vercel → Deployments → previous deployment → **Promote to Production** (content lives in Redis, not the deployment — it is unaffected).

## Monitoring

- UptimeRobot (or equivalent): `GET /` and `GET /api/health` every 5 min → alert office email after 2 failures. Alert on `"redis":false` in the health payload if the monitor supports keyword checks.
- Logs: Vercel → Functions → filter for `Redis read failed` / `Redis write failed` / `not configured`.

## Backup & restore

- Enable Upstash daily backups (console → database → Backups).
- Weekly logical export: save the response of `GET https://www.mmakf.in/api/data` as `backup-YYYY-MM-DD.json` in private storage. Leads: export from Upstash console (`GET mmakf:leads`).
- Restore a key: Upstash console → `SET mmakf:{key} <json>` — or sign in to `/admin` and re-save the panel from the backup values.

## Common operations

**Rotate admin password / kill stolen sessions**
Vercel → env vars → change `ADMIN_SESSION_SECRET` (kills every session instantly) and/or `ADMIN_PASSWORD` → redeploy.

**Reset a key to seed (factory content)**
Upstash console → `DEL mmakf:{key}` → the site immediately serves the built-in seed for that key only.

**Erasure request (DPDP)**
Upstash console → `GET mmakf:leads` → remove the matching entries from the JSON → `SET mmakf:leads <edited json>`. Respond to the requester within 30 days.

**Redis outage**
Public site keeps serving (seed/last HTML). Admin saves fail with toasts. No action usually needed — confirm recovery via `/api/health`.

## Local-dev gotcha (Windows)

A stray `postcss.config.js` in any parent folder (e.g. `Downloads`) breaks Vite. The repo's root `postcss.config.cjs` (empty plugins) guards against this — **do not delete it**.
