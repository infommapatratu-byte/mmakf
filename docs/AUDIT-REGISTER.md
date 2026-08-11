# MMAKF Engineering Audit Register

**Phase 2 — second-pass audit from production baseline `914cabd`**

| Field | Value |
|---|---|
| Baseline commit | `914cabd` (v1.9.0) — verified live at www.mmakf.in |
| Audit started | 2026-08-11 |
| Method | 5 parallel investigation tracks (UX desktop, UX mobile, content, engineering, adversarial security), every P0–P2 finding independently re-verified by a second agent before entry |
| Register status | **OPEN** — see §3 for live counts |

## 1. Severity definitions

| Level | Meaning |
|---|---|
| **P0** | Security, data loss, incorrect official information, payment/data integrity, broken core workflow |
| **P1** | Important operational or institutional defect |
| **P2** | Meaningful UX / content / engineering issue |
| **P3** | Polish |

Status values: `OPEN` · `FIXED` · `VERIFIED` · `REQUIRES MMAKF DECISION`

## 2. Carry-over: the five unverified findings from the Phase 1 audit

The Phase 1 audit ran 30 agents; five verification runs terminated on session limits, so their
findings entered `914cabd` **unverified**. They are re-tested in this phase.

| ID | Original finding (Phase 1) | Was it fixed in 914cabd? | Phase 2 action |
|---|---|---|---|
| C-1 | `/about` — anonymous "Parent of Student" testimonial reads fabricated; initials-avatar shows "PO" | No | Re-tested this phase |
| C-2 | `/about` — duplicate agent on the same testimonial finding | No | Merged into C-1 |
| C-3 | All pages — footer nav links dark-on-dark contrast (`.ft-col a` token) | Theme changed since (light redesign) | Re-tested this phase |
| C-4 | `/shop` — price/action row collision, inconsistent wrapping of struck-through MRP | Row markup changed (UPI + WhatsApp links added) | Re-tested this phase |
| C-5 | `/belt-system` — Dan credential pills overflow on mobile | Yes — wrap rule added at ≤560px | Verification pending |

## 3. Findings register

*Populated from the Phase 2 audit as findings are confirmed. Counts updated on each pass.*

| ID | Sev | Area | Finding | Evidence | Status | Fix | Verification |
|---|---|---|---|---|---|---|---|
| — | — | — | *audit in progress* | — | — | — | — |

## 4. Method notes

- **No finding is entered on assertion alone.** Each is reproduced by an independent agent
  (command + observed output, or file:line, or a screenshot that was actually read) before entry.
- **Refuted findings are recorded too** (§5), so the same false positive is not re-investigated.
- Findings that require federation policy input (real fees, official titles, approved recognitions)
  are marked `REQUIRES MMAKF DECISION` and never silently invented.

## 5. Refuted / not-reproduced

*Populated after verification.*
