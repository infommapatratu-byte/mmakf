# MMAKF API Reference

Base URL: site origin. All request/response bodies are JSON. Errors use `{"error": "<message>"}`. No versioning — endpoints are additive-only; breaking shapes go to `/api/v2/*`. Full contracts: MASTER-SPEC §8.

## GET /api/data

All public content (16 keys; **never** `leads`). No auth.
Cache: `public, max-age=60, s-maxage=300`.

```
200 → { "federation": {...}, "stats": [...], "leadership": [...], "programs": [...],
        "schedule": [...], "events": [...], "news": [...], "products": [...],
        "achievements": [...], "testimonials": [...], "beltGrading": {...},
        "facilities": [...], "faqs": [...], "gallery": [...], "syllabus": [...],
        "branches": [...] }
```

## POST /api/enroll

Create an enrolment lead. No auth. Fields truncated to name ≤120, phone ≤32, program ≤120 chars; newest-first list capped at 500.

```
POST /api/enroll
{ "name": "Anita Sharma", "phone": "+91 98xxxxxx01", "program": "Kids Program" }

200 → { "ok": true }
400 → { "error": "Invalid JSON" } | { "error": "Name & phone required" }
```

## POST /api/auth/login

Mint the admin session cookie. Failed attempts are delayed 400 ms.

```
POST /api/auth/login
{ "password": "..." }

200 → { "ok": true }  + Set-Cookie: mmakf_admin=<payload>.<hmac>; Path=/;
       Max-Age=604800; HttpOnly; SameSite=Lax [; Secure]
400 → { "error": "Invalid request" }
401 → { "error": "Invalid password" }
500 → { "error": "Server not configured" }   (prod without ADMIN_* env vars)
```

## POST /api/auth/logout

Clears the session cookie. Idempotent, no auth required. `200 {"ok":true}`.

## POST /api/data/{key}

Replace one content key wholesale. **Requires the admin cookie.**
`key` must be one of the 16 public keys (see GET /api/data). Body = the complete new value (object for `federation`/`beltGrading`; array for the rest).

```
POST /api/data/faqs
Cookie: mmakf_admin=...
[ { "q": "New question?", "a": "Answer." }, ...rest-of-list ]

200 → { "ok": true, "key": "faqs" }
401 → { "error": "Unauthorized" }
400 → { "error": "Invalid key" } | { "error": "Invalid JSON" }
```

## GET /api/health

Monitoring probe. Always 200; alert on payload.

```
200 → { "ok": true, "redis": true|false, "version": "<git sha|dev>" }
```

## GET /sitemap.xml

XML sitemap of the 12 public routes. Cache: 1 h browser / 24 h edge.
