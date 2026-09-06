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

---

## PRODUCTION FAULT — every form on the site was refused

**Reported 6 September 2026** ("this showing from months"), reproduced against
`www.mmakf.in` the same day. Two separate defects, one of which is not ours.

### 1. The cause: Vercel's edge blocks form-encoded POSTs

Every POST carrying an encoding an HTML form can produce is answered

```
403  Cross-site POST form submissions are forbidden
```

**That string is not in this repository and never has been** — `git log -S`
finds no commit containing it, and the middleware's own refusal reads
`{"error":"Request refused"}`. It is Vercel's, emitted at the edge.

The evidence, run against production:

| request | result |
|---|---|
| `POST /start/individual` urlencoded | 403 `Cross-site POST form submissions are forbidden` |
| …plus `Origin` + `Sec-Fetch-Site: same-origin` | 403 — a *perfectly formed same-origin* submission |
| `POST /robots.txt` | 403 — **a static file. No function runs.** |
| `POST /no-such-path-xyz` | 403 — before routing |
| `POST` multipart / `text/plain` / no content-type | 403 |
| `PUT /start/individual` | 403 `{"error":"Request refused"}` — **our** message |
| `POST` `application/json` | reaches the function |
| `GET /start/individual` | **200** |

So the rule is keyed on CONTENT TYPE, applies before the application, and
`application/json` is the only body that gets through. Which means **a plain
`<form method="post">` could not work anywhere on this deployment** — not the
institutional intake, not registration, not a single admin write.

**THE ACTUAL FIX IS A VERCEL PROJECT SETTING and only the account holder can
make it.** Nothing in this repository can turn that rule off.

### 2. What was fixed in code, so the site works meanwhile

`src/lib/form-intake.ts` — `readSubmission(request)` reads a submission
whichever way it arrives and always returns a `FormData`, so all **31** page
handlers changed by one function name and nothing else. Their
`String(form.get(k) ?? '')` helpers and checkbox tests are untouched.

`src/scripts/form-upgrade.ts`, loaded once from `Base.astro` — intercepts
same-origin form posts and re-sends them as `application/json`.

**This is not a CSRF hole.** The middleware still runs its origin check on
every mutating request, unchanged, and `/api/` paths still require JSON as they
always have — a cross-site form cannot send `application/json` without a CORS
preflight this application never answers, which is the property that rule was
always built on. A live test asserts an `/api/` route still refuses a
form-encoded body.

**It does break the no-JavaScript guarantee, and that is stated rather than
hidden.** While the edge rule stands, a no-JS submission cannot reach the
application at all — with or without this code. The choice was between forms
working for everybody running JavaScript and forms working for nobody.
**When the Vercel setting is changed, `src/scripts/form-upgrade.ts` should be
deleted** and nothing else undone.

### 3. A second, genuine defect found underneath it

`src/middleware.ts` passed `url.host` into `isSameOrigin()`. That same file
records, twenty lines above the call, that **behind Vercel's proxy `url.host` is
the internal invocation host** — it is why `publicHost` exists there.

So `isTrustedHost(host)` was asking whether an internal Vercel hostname is one
of the federation's public hosts. It never is. The `same-site` branch could
never be satisfied, and every POST crossing the apex-to-www redirect was refused
**by our own middleware** — the exact fault `eb1004e` had already fixed once and
believed closed.

It went unnoticed because the unit tests pass `'www.mmakf.in'` as `host` by
hand, and **no test ever called the function with the value the caller actually
supplies.**

Fixed by making the decision rest on the INITIATOR allowlist, which is where the
protection always came from: `Origin` and `Sec-Fetch-Site` are browser-set and
unforgeable by script, and the host a request arrived on adds nothing. Also
fixed: `initiator()` returned null on the first unparseable header, so an opaque
`Origin: null` discarded a good `Referer` behind it.

`employee.mmakf.in` was added to `TRUSTED_HOSTS` in the same change — a surface
missing from that list has every form on it refused, which is this same bug.

**11 unit tests** in `tests/hardening.test.ts` now call the function with the
internal-host shape the caller really passes, and **5 live tests** in
`tests/routes-live.test.ts` prove it over HTTP, including that a hijacked
sibling subdomain and a genuine cross-site POST are still refused.

### What the operator has to do

1. In the Vercel project, find the setting producing
   `Cross-site POST form submissions are forbidden` — check **Deployment
   Protection** and **Firewall** — and turn it off for this project.
2. Confirm with:
   `curl -sS -X POST -H "Content-Type: application/x-www-form-urlencoded" --data "p=1" https://www.mmakf.in/robots.txt -o - -w "\n%{http_code}\n"`
   A 403 with that message means it is still on; anything else means it is off.
3. Then delete `src/scripts/form-upgrade.ts` and its `import` in `Base.astro`.
