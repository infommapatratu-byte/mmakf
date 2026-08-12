# PRIVACY

MMAKF holds personal data about **children**. That fact shapes every decision in this document.

Written for the engineer implementing a feature and the officer answering a member's question. Where
the law requires something MMAKF has not yet decided, that is marked **REQUIRES MMAKF DECISION**
rather than resolved by guesswork — a privacy notice nobody approved is worse than none.

---

## 1. What is held, and why

| Data | Purpose | Classification |
|---|---|---|
| Name, federation ID, city, state, dojo | Membership and public verification | `public` |
| Grade and grading history | The federation's core function | `public` |
| Competition results, medals, rankings | Happened in front of an audience | `public` |
| Date of birth | **Age category, and identifying minors.** The site publishes birth *year* only | `member` |
| Email, phone, address | Correspondence | `member` |
| Guardian name and contact | Consent and emergency contact for a minor | `member` |
| Emergency contact | A contact sport | `member` |
| Medical declaration, clearance, injury | Fitness to compete, emergency response | `restricted` |
| Safeguarding case material | Child protection | `highly_restricted` |
| Disciplinary case material | Federation discipline | `confidential` |
| Payment records | Financial record and reconciliation | `official` |
| Hashed IP on audit and verification rows | Attribution and abuse detection | `official` |

**Data minimisation is enforced structurally**, not by policy alone. Medical records are deliberately
minimal — fitness to compete and emergency contact, not a clinical record. Collecting more than the
purpose requires is itself the risk.

---

## 2. Children

This is the part that matters most.

MMAKF's published programmes start at **age 5**. Before this work, the registration form collected
**no date of birth at all** — which meant the federation could not identify which of its applicants
were children, and therefore could not apply a single protection to them.

**What is now enforced in code** (`src/lib/registration.ts`, 27 tests):

| | |
|---|---|
| Date of birth is **required** | Without it a minor cannot be identified |
| Under 18 → guardian block appears | Name, relationship, mobile |
| Guardian consent is **mandatory** for a minor | The application is refused without it |
| Consent to emergency treatment is **mandatory** for a minor | |
| Photography consent is **optional** | And unticked by default — a consent that is pre-ticked is not consent |
| Emergency contact is required for every athlete | |

The day *before* the eighteenth birthday is a minor; the birthday itself is not. Both are tested,
because an off-by-one here decides whether a child's application proceeds without guardian consent.

### DPDP Act 2023

India's Digital Personal Data Protection Act imposes specific duties for children's data:
**verifiable parental consent**, and a prohibition on **tracking, behavioural monitoring and targeted
advertising** directed at children.

**Where the system stands:**

| | |
|---|---|
| Guardian consent captured at registration | ✅ Built |
| No tracking, no behavioural monitoring, no advertising | ✅ **Structurally true** — the site carries no analytics script, no advertising pixel and no third-party tracker. The CSP is enforced and would block one |
| **Verifiable** parental consent | ⚠️ A ticked box and a guardian's phone number is consent, but "verifiable" has a higher bar. **REQUIRES MMAKF DECISION** on the verification method |
| Privacy notice at the point of collection | ⚠️ The form states the purpose. A full notice is **REQUIRES MMAKF DECISION** — see §6 |
| Grievance mechanism | ⚠️ `support_tickets` exists with confidentiality support; the published route and named officer are MMAKF's to appoint |

---

## 3. How privacy is enforced technically

Not by remembering. By structure.

**Public and private projections are separate functions**, never one function with a flag.
`publicAthleteProfile()` and `athletePassport()` are distinct. A boolean defaulting the wrong way
leaks a date of birth; two functions cannot.

**Classification is a column**, checked in queries. Defence in depth: RBAC should already have
refused the read; this is the second gate.

**Safeguarding and medical are separate tables**, not flags on `persons`. Merging them would put
child-protection material one careless join — or one `SELECT *` — from a general admin list.

**A safeguarding subject need not be a member.** The schema does not require a `persons` row. A
child, a parent, a spectator or an unknown person must be reportable.

**`FEDERATION_ADMIN` does not hold `safeguarding:read`.** Only `SUPER_ADMIN` and
`SAFEGUARDING_OFFICER` do, deliberately, and it is proven by test.

**Search cannot become an export.** Certificates are findable by exact number, **never by holder
name** — a search listing everyone called "Kumar" with their grades is a bulk export of the register
wearing a search box. Safeguarding, medical and disciplinary records are unsearchable at every
permission level including `SUPER_ADMIN`.

**IP addresses are hashed before storage**, everywhere.

**Logs carry no personal data.** Redaction matches key names as substrings, so `email`, `phone`,
`dob`, `guardian` and `medical` are caught without enumerating every field. `federationId` is
deliberately kept — it makes a problem traceable to a record without naming a human being.

> **A defect this closed:** `/api/data` served the **entire member register** — every member's name,
> grade, unit and state — unauthenticated and CDN-cached for five minutes. A verification service
> that was actually a bulk export.

---

## 4. Retention

**REQUIRES MMAKF DECISION.** Purpose limitation requires that data not be kept indefinitely, and the
periods are the federation's to set — they turn on commitments MMAKF makes to its members.

Engineering's input:

| Data | Consideration |
|---|---|
| Grading records, certificates | Arguably **permanent**. A Dan grade is a lifelong credential and a federation that discards its own grading history cannot honour it |
| Competition results | Permanent. They are public records of public events |
| Membership contact details | Should lapse some period after membership ends |
| Applications not proceeded with | Should be shortest of all |
| Safeguarding | Sector guidance points to **long** retention. **Take advice** |
| Medical | Should lapse; the purpose is current fitness, not history |
| Audit logs | Long, but they contain actor labels — pseudonymised, not anonymous |
| Payment records | Governed by tax law, not preference |

**Nothing implements automated deletion yet.** The classification column is the foundation; the
policy is not written, and it must not be invented here.

---

## 5. Member rights

DPDP gives a data principal rights of access, correction, erasure and grievance redress.

| Right | Status |
|---|---|
| **Access** | ✅ `/my/passport` returns their whole record. `/application` returns their own application by reference and access code |
| **Correction** | ⚠️ No self-service. Corrections go through the office. **A correction must never rewrite history** — a grade is superseded, never edited |
| **Erasure** | ⚠️ **Genuinely difficult, and it must not be pretended otherwise.** Grading records and competition results are append-only by design because a federation that can quietly delete a grading cannot be trusted. A member asking for erasure needs a real answer combining contact-data deletion with retention of the credential record. **REQUIRES MMAKF DECISION**, and probably legal advice |
| **Grievance** | ⚠️ `support_tickets` supports confidential submission. The published route and the named officer are MMAKF's to appoint |

---

## 6. What MMAKF must supply

Blocked on the federation, not on engineering.

1. **A privacy notice.** What is collected, why, how long, who sees it, and how to complain. It must
   be shown at the point of collection. Engineering will publish it through the versioned document
   register; it must not be drafted here.
2. **Retention periods** (§4).
3. **A verifiable parental consent method** (§2).
4. **A named grievance officer** and a published route.
5. **An erasure position** (§5).
6. **A decision on photography.** Consent is captured; how event photography of minors is published
   is a policy question.
7. **A data-processing agreement with each processor** — the hosting provider, the database provider,
   the payment gateway. Each holds personal data on MMAKF's behalf.

---

## 7. Breach

**No breach-response procedure exists.** DPDP requires notification, and there is currently no
documented process, no named responsible person, and no notification template.

What exists to support one: the audit trail records who did what to which record; `verification_log`
records credential lookups; the classification column identifies what a compromised table would have
exposed.

**REQUIRES MMAKF DECISION** — this is a gap, recorded plainly rather than left to be discovered
during an incident.

---

## 8. Third parties

| Processor | Data | Note |
|---|---|---|
| Vercel | Everything in transit; function logs | Logs are redacted before emission |
| Upstash Redis | Editorial content, submission lists | Contains applicant contact details |
| Postgres provider (to be chosen) | The federation record | Mumbai region recommended — data residency |
| Razorpay (when configured) | Payer name, email, phone | The gateway is the record of the transaction |
| YouTube (when configured) | Nothing about members. Read-only channel access | Attendance is recorded in MMAKF, not YouTube |

**No analytics provider. No advertising network. No third-party tracker.** For a site used by
children, that is a deliberate architectural position, and the enforced CSP would block one.
