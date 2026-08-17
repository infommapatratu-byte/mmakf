# MMAKF — Regulatory Gap Analysis

**Companion to:** [KARATE-ACADEMY-SOURCE-REGISTER.md](./KARATE-ACADEMY-SOURCE-REGISTER.md)
**Date:** 2026-08-17
**Status:** ANALYSIS. Nothing in this document is an adopted MMAKF regulation.

---

## 0. The question this document answers

The source register says what Karate Academy Bharat publishes. This document says what MMAKF would
still be missing **if it adopted every word of it tomorrow** — and which of those words it must not
adopt at all.

The distinction that runs through the whole file:

> A federation that inherits an academy's rules inherits an academy's *scope*. An academy answers to
> its students. A national federation answers to its members, to minors in its dojos, to the people
> it refuses, and to anyone who wants to challenge a decision it made. Those obligations have no
> source on karateacademy.in because an academy website is not where they live.

Filling that in with plausible text is the failure mode this project treats as unforgivable. Every
gap below therefore ends in **REQUIRES MMAKF APPROVAL**, not in draft rule text.

---

## 1. Existing source rules — what can actually be carried forward

Source-derived material that is concrete enough to become a rule, and what has to happen first.

| Ref | Source rule | Federation instrument it belongs in | Blocker before adoption |
|---|---|---|---|
| KAB-001.1–.8 | Dojo conduct: discipline, permission to speak, uniform, greeting, equipment, respect, humility, personal kit | **DojoCode** / **StudentCodeOfConduct** | None of substance. Needs a consequence model — the source states obligations with no stated consequence for breach. |
| KAB-001.10 | Doping prohibited | **Anti-Doping Policy** | Must be adopted **by reference to NADA's National Anti-Doping Rules**, never by restating them. MMAKF has no results-management authority of its own. |
| KAB-002 (lateral, downward) | Kindness to peers; patience with juniors | **StudentCodeOfConduct** — peer conduct, anti-bullying | None. |
| KAB-010.5 | Tournament fees announced ≥30 days before the event | **MMAKF Fee Policy** — service standard | Adopt on its own merits. Do not inherit the amounts around it. |
| KAB-012.1 | `minimum_grade = 4th Kyu` for an instructor-intern | **Instructor Appointment Regulation** | Needs an MMAKF grade register the requirement can be evaluated against, and an equivalence rule for grades awarded by other bodies. |
| KAB-012.2 | `E.1 = 40, E.2 = 40, E.3 = 20` | **ExaminationPolicy** | **E.2 is blocked.** See §4.3. E.1 and E.3 are adoptable once a rubric and a panel composition exist. |
| KAB-012.3 | Required documents for an instructor application | **Instructor Appointment Regulation** | Needs a retention period and a lawful basis; the source states neither. |
| KAB-013 / KAB-014 | `minimum_grade = 2nd Dan` for instructor and disciple-instructor tracks | **Instructor Appointment Regulation** | Same grade-register dependency. The $5 application fee is **not** carried forward (§4.5). |
| KAB-018 | Competition gi must be WKF-approved | **UniformPolicy** | Adopt by reference to the WKF specification. **Do not name brands** (§4.6). |
| KAB-019 | ID cards carry a QR an instructor may require | **Identity & Credential Regulation** | Needs validity, replacement, revocation and misuse provisions — none exist on the source. |
| KAB-011 | Three award categories with stated eligibility bases | **Scholarship & Concession Policy** | Needs decision-maker, amounts, timeline, renewal condition and an appeal route. |
| KAB-017 | A dated notice board with vacancy states | **Circular** instrument type | Adopt the *form*, not the entries. ISO dates required. |

**Everything else in the register is either doctrine, a biography, a third party's rule, or a fee
that belongs to the Academy.**

---

## 2. Missing rules — no source exists, and MMAKF must author them

Grouped by how badly their absence hurts. **"MISSING"** here means: not on karateacademy.in, and not
in MMAKF's own published register at [`/regulations`](../../src/pages/regulations.astro), which
currently lists ten of MMAKF's own instruments as *unpublished*.

### 2.1 Blocking — a federation training minors cannot operate without these

| Area | What is missing | Why it blocks |
|---|---|---|
| **Child safeguarding** | Entire framework: minor registration, guardian consent, authorised pickup, one-to-one training rules, online contact rules, travel and overnight accommodation, designated safeguarding officer, reporting route, referral to authority, restricted access to case files. | The source has none of it. The schema already isolates the casework (`safeguarding_cases`, HIGHLY RESTRICTED) — but a case table with no policy behind it records incidents against a standard nobody published. |
| **Complaints** | Intake channels, case ID, category, priority, owner, SLA, decision, appeal. | Without it, a member with a grievance has nowhere to go but the person they are complaining about. |
| **Disciplinary procedure** | Grounds, notice, evidence standard, hearing rights, representation, available sanctions, sanction limits, publication rules. | `disciplinary_cases` exists and can record a sanction today. A sanction imposed under no published procedure is unenforceable and unfair in the same breath. |
| **Appeals** | Grounds, time limit, fee (if any), **independence of the appeal body from the original decision-maker**, remedies. | Named as a requirement in the brief; **NOT FOUND in any source.** Every decision surface in this system — grading, selection, discipline, concession, marketplace review — currently terminates in a decision with no route past it. |
| **Medical & emergency** | Injury reporting, first-aid provision at sessions, emergency contact, emergency response, medical clearance, return-to-training, return-to-competition. | KAB-025 shows an instructor *holds* CPR/AED/First Aid. A held certificate is not a procedure, and it is not a requirement on anyone else. |
| **Data protection** | Privacy notice, lawful basis, retention schedule, minors' data, third-party processors (the admission form is a Google Form), subject rights. | The academy collects academic credentials, recommendation letters and grade proofs through a third-party form with no published notice. |

### 2.2 High — required for the federation's own core functions to be defensible

| Area | What is missing |
|---|---|
| **Grading regulation** | Syllabus per grade, pass mark, examiner appointment and qualification, panel composition, conduct of examination, re-examination interval, result recording, certificate issue, **appeal against a grading result**. Source gives duration and fee only, and nothing above 1st Kyu. |
| **Dan grading** | Everything. The source stops at 1st Kyu; the instructor vacancies require 2nd Dan; nothing published says how a Dan is obtained or recognised. **This is a live contradiction — see §5.1.** |
| **Referee & judge certification** | Everything. Source page is an empty stub (KAB-027). |
| **Competition regulation** | Entry and eligibility, age and weight divisions, sanctioning of events, protest procedure, results finalisation, safety equipment. |
| **Selection policy** | Criteria, selectors, conflict declarations, publication of the decision, challenge route. |
| **Affiliation regulation** | Chartering a dojo, a district body, a state body: requirements, documents, fee, obligations, inspection, renewal, suspension, withdrawal. The source uses the word to mean something else entirely (KAB-020). |
| **Attendance policy** | Scheduled / present / late / excused / absent / cancelled; thresholds; the effect (if any) of attendance on grading eligibility. Source publishes a timetable, not a policy. |
| **Leave policy** | Four separate domains — student absence, coach availability, instructor leave, staff HR leave. Source has none. |
| **Certificate integrity** | Numbering, the chain from candidate → exam → syllabus version → examiner → result → approval, revocation. |
| **Conflict of interest** | Declaration duty for examiners, selectors, disciplinary panels, finance and procurement. `interest_declarations` exists as a table; the *duty to declare* has no instrument. |
| **Anti-corruption** | Gifts, hospitality, bribery, procurement thresholds, sponsorship, documented exceptions. |

### 2.3 Moderate — needed, not blocking

| Area | What is missing |
|---|---|
| **Instructor code** | Technical competence, teaching duty, confidentiality, parent communication, minor protection, assessment and grading integrity, continuing development, conflict of interest, financial conduct, anti-abuse, anti-harassment. |
| **Staff code** | Professionalism, confidentiality, data protection, financial integrity, anti-bribery, workplace conduct, safeguarding duty. |
| **Social media policy** | The separation of a personal account from an official MMAKF account; who may speak for the federation. |
| **Media & photography consent** | Person, minor, event, medium, purpose, duration, withdrawal. |
| **Equipment policy** | Required / optional / competition-specific / safety-critical; the safety-critical list (mitts, shin-instep, gum shield, groin guard) has no source. |
| **Dojo facility standards** | Floor, space per student, ventilation, first-aid kit, coach-to-student ratio, parent access, incident reporting. |
| **Instructor career ladder** | Intern → assistant → associate → instructor → senior → expert → master → examiner → technical authority, held **separately from Dan grade**. The source publishes no ladder at all; the honorifics it uses (Soke, Renshi) are attached to named individuals, not defined as ranks. |

---

## 3. Ambiguous rules — source says something, but not enough to act on

| Ref | The ambiguity | What MMAKF must decide |
|---|---|---|
| KAB-008 | "3 months", "6 months" — of what? Elapsed time since the last grading, or attendance-weighted training time? | Define the clock. Elapsed-time and trained-time produce different eligibility for the same student. |
| KAB-010.2 | "Should be submitted for the upcoming belt duration together" — is advance payment a *condition of enrolment* or a *preference*? | If it is a condition, it needs a hardship route; the academy has one (KAB-011) but does not connect them. |
| KAB-010.4 | "A-level and B-Level" examination fees — the levels are named but never defined. | Define the levels, or drop the terminology. |
| KAB-012.4 | "3 months (Active Athlete)" — is "Active Athlete" a further eligibility condition or a description? | Decide, and if it is a condition, define what makes an athlete active. |
| KAB-011 | "continuous performance review" with no criteria; "Limited seats as per Resource availability" with no allocation rule. | An award that can be withdrawn against an unpublished standard is not a policy. Define both. |
| KAB-017 | Dates written `DDMMYYYY` with no separator; the intern vacancy is marked closed with a date reading as 16 Nov 2026, ahead of retrieval. | MMAKF circulars carry ISO dates. Do not import the format. |
| KAB-018 | "Practice Gi" is a distinct category with no specification at all. | Either specify the training-gi standard or state that there is none. |
| KAB-020 | "affiliation … only limited to our student" collides head-on with MMAKF's chartering domain. | Keep the words apart. MMAKF must not use "affiliation" in the academy's sense anywhere. |
| KAB-026 | Kata pages are organised by grade band, which *implies* a syllabus the site never states. | Either publish the syllabus per grade or stop implying one. |

---

## 4. Conflicts — where adopting the source would create a problem

### 4.1 "Only two relationships: Master and Disciple" (KAB-001.9) vs institutional accountability

The source states a **complete** relational model. A federation needs at least five relationships the
model does not contain: member↔federation, complainant↔investigator, subject↔disciplinary panel,
appellant↔independent appeal body, and child↔safeguarding officer. Every one of those exists
precisely so that the master–disciple relationship is not the only channel available when something
goes wrong.

**Resolution required:** MMAKF may honour the teaching relationship in a code of conduct. It may not
adopt KAB-001.9 as an exhaustive statement, because doing so would make a complaint against a master
structurally unmakeable. **PROPOSED — REQUIRES MMAKF APPROVAL:** an express provision that
institutional routes (complaint, safeguarding, appeal) operate *independently of and in addition to*
the teaching relationship, and that no person may discourage their use.

### 4.2 The four regulative principles (KAB-003) vs a national federation's duty of access

The source addresses four abstinence requirements — diet, intoxicants including tea and coffee,
gambling, and private sexual conduct — to parents and guardians.

As **ACADEMY POLICY** this is recorded and left alone. As **MMAKF REGULATION** it fails on four
counts: it conditions a child's access to sport on a parent's private conduct; it is not a
sport-related requirement; it is unverifiable without intrusion the federation has no basis for; and
it would exclude on grounds a national body cannot defend.

**Resolution required:** **DO NOT ADOPT.** Recorded in the register, flagged here, and excluded from
every proposed instrument. If the federation wants a nutrition or a welfare position, it must be
authored on sports-medicine grounds and issued as a **GUIDELINE**.

### 4.3 "Maturity Test in Normal Life" (KAB-012.2 · E.2) — 40 marks, no rubric

E.2 carries **40% of an appointment decision** and the source publishes no criterion, no rubric, no
evidence standard, no examiner qualification, no record requirement and no appeal.

This is the exact failure the brief names: *"Do not permit subjective personality judgment without an
approved rubric."*

**Resolution required — PROPOSED, REQUIRES MMAKF APPROVAL.** E.2 may be carried into an MMAKF
examination policy only when all seven of the following exist as approved artefacts:

1. named criteria, each **defined, observable and assessable**;
2. a rubric with anchored descriptors per band;
3. an evidence standard — what an assessor may rely on, and what they may not;
4. an assessor qualification and a **minimum panel of two**;
5. a written record of the score and the reason, disclosable to the candidate;
6. a privacy rule — assessment of "normal life" collects personal information, so its scope and
   retention must be bounded in advance;
7. an appeal to a body that did not conduct the assessment.

Until then, **E.2 is recorded as source material and is not evaluable by the rule engine.**
`evaluate()` returns `not_approved` for any rule whose version has not reached `approved`, which is
what stops this from being scored by accident.

### 4.4 Advanced techniques published with no prerequisite (KAB-026)

Kansetsu-waza and kyusho-jutsu are described in terms of incapacitation and pain, with no grade
prerequisite, no supervision requirement, no age restriction and no safety warning, on a site whose
audience includes children.

**Resolution required — PROPOSED, REQUIRES MMAKF APPROVAL:** minimum grade, minimum age, direct
supervision by a qualified instructor, and an incident-reporting requirement, before any MMAKF
technical regulation cites this material.

### 4.5 Application fee charged to job applicants (KAB-013, KAB-014)

$5 USD to apply for a salaried instructor post. This is an employment-practice question with legal
exposure, and it is not a sporting rule.

**Resolution required:** **DO NOT ADOPT** into any MMAKF instrument without employment-law advice.

### 4.6 Named uniform suppliers (KAB-018)

"Hanna, USI, GOKIADO etc." is a recommendation on the source. A federation naming mandatory brands
creates procurement and competition-law exposure.

**Resolution required:** adopt the **WKF standard by reference**; publish no brand list.

### 4.7 CEO post conditioned on $1M investment for 40% equity (KAB-016)

An equity-for-investment proposition attached to an executive title. It has no federation-policy
analogue.

**Resolution required:** **DO NOT MIGRATE.** A national federation's chief executive appointment
cannot be conditioned on a capital contribution.

### 4.8 The word "affiliation" (KAB-020)

The source restricts it to the academy–student relationship; MMAKF uses it for chartering units.
Adopting the source definition would silently redefine an existing federation domain.

**Resolution required:** keep the vocabularies separate; MMAKF retains its own meaning.

### 4.9 Academy fees vs federation fees (KAB-008, KAB-010)

Two fee schedules, one federation. Loading academy amounts into the MMAKF fee engine would make an
academy's 2025 pricing look like a federation determination.

**Resolution required:** **ACADEMY FEE POLICY** and **MMAKF FEE POLICY** stay separate documents,
and no academy amount enters `fee_rules`. The fee framework already ships empty of amounts for this
reason.

---

## 5. Contradictions inside the source itself

### 5.1 The Dan gap

Instructor vacancies require **2nd Dan (Nidan)** (KAB-013, KAB-014). The published examination ladder
stops at **1st Kyu** (KAB-008). Nothing on the site says how a Dan is obtained, by whom it is
awarded, or whose Dan is recognised.

**Consequence:** the published eligibility condition for the academy's own paid roles cannot be
satisfied through the academy's own published pathway. MMAKF cannot adopt KAB-013/.014 as a rule
until a Dan pathway or a recognition rule exists — a rule engine asked to evaluate
`grade >= 2nd Dan` against a register that has no route to 2nd Dan will refuse every applicant, which
is arguably correct and certainly not what was intended.

### 5.2 Recruitment states vs the notice board

The careers page presents the intern and CEO roles as live listings; the notice board records both as
closed. **Resolution:** one register, one state. MMAKF's `Circular` instrument carries the state, and
the vacancy surface reads it — it does not keep its own copy.

### 5.3 "Quality over quantity" vs 30 instructor positions

Not a legal conflict; a coherence one. Recorded because a federation adopting the academy's stated
motto alongside its stated recruitment scale should do so knowingly.

---

## 6. What requires formal MMAKF approval before it can exist

Nothing below has been drafted. This is the approval agenda.

| # | Instrument | Type | Approval body | Depends on |
|---|---|---|---|---|
| 1 | Child Safeguarding & Child Protection Policy | POLICY | Executive + safeguarding lead | — |
| 2 | Complaints Policy | POLICY | Executive | 1 |
| 3 | Disciplinary Regulation | REGULATION | General body | 2 |
| 4 | Appeals Regulation | REGULATION | General body | 3; **independence requirement** |
| 5 | Medical & Emergency Policy | POLICY | Executive + medical officer | — |
| 6 | Data Protection & Privacy Policy | POLICY | Executive | — |
| 7 | Grading Regulation (kyu) | REGULATION | Technical committee | curriculum & grade versions |
| 8 | Dan Grading & Recognition Regulation | REGULATION | Technical committee | 7; resolves §5.1 |
| 9 | Examination Policy (incl. E.1/E.2/E.3) | POLICY | Technical committee | 7; **§4.3 rubric** |
| 10 | Instructor Appointment Regulation | REGULATION | Executive | 8, 9 |
| 11 | Instructor Code of Conduct | CODE | Executive | 1 |
| 12 | Student Code of Conduct | CODE | Executive | 1 |
| 13 | Dojo Code | CODE | Technical committee | 12 |
| 14 | Staff Code | CODE | Executive | 6 |
| 15 | Referee & Judge Certification Regulation | REGULATION | Technical committee | WKF reference |
| 16 | Competition Regulation | REGULATION | Technical committee | WKF reference |
| 17 | Selection Policy | POLICY | Executive | 19 |
| 18 | Affiliation Regulation (dojo/district/state) | REGULATION | General body | — |
| 19 | Conflict of Interest Policy | POLICY | Executive | — |
| 20 | Anti-Corruption Policy | POLICY | Executive | 19 |
| 21 | Anti-Doping Policy (by reference to NADA) | POLICY | Executive | NADA rules |
| 22 | Attendance Policy | POLICY | Training directorate | — |
| 23 | Leave Policy (4 domains) | POLICY | Executive + HR | — |
| 24 | Uniform Policy | POLICY | Technical committee | WKF reference; **§4.6** |
| 25 | Equipment Policy | POLICY | Technical committee | 24 |
| 26 | Social Media Policy | POLICY | Executive | — |
| 27 | Media & Photography Consent Policy | POLICY | Executive | 1, 6 |
| 28 | Identity & Credential Regulation | REGULATION | Executive | — |
| 29 | Certificate Integrity Regulation | REGULATION | Technical committee | 7, 9 |
| 30 | Scholarship & Concession Policy | POLICY | Executive + finance | 4 (appeal) |
| 31 | MMAKF Fee Policy | POLICY | Executive + finance | **§4.9** |
| 32 | Character & Ethics Framework | GUIDELINE | Technical committee | **§4.3** — criteria must be defined, observable, assessable, reviewable, appealable |
| 33 | Disciple Instructor Pathway Regulation | REGULATION | Executive | 10, 11; **no invented spiritual obligation (KAB-014)** |
| 34 | Instructor Career Ladder Regulation | REGULATION | Technical committee | 10; **technical grade and professional role stored separately** |

---

## 7. How the engine keeps this honest

The gaps above are enforced by code, not by this document.

- **No hard-coded policy.** Rules live in `policy_rules` / `policy_rule_versions`
  ([`src/db/policy.schema.ts`](../../src/db/policy.schema.ts)), not in components, API routes or SQL
  conditions.
- **Nothing evaluates before approval.** `evaluate()` returns a typed
  `not_approved` / `no_rule_in_force` refusal rather than a decision. An unapproved rule cannot
  produce an eligibility answer, so a half-built policy fails visibly instead of quietly.
- **Layer is a column.** `academy_source`, `mmakf_regulation` and `external_reference` are values in
  `policy_layer`, and the query has to name the one it wants. Academy material cannot reach a
  federation surface by omission.
- **Adoption needs an approver.** A source provision becomes federation policy only through
  `adoptSourceProvision()`, which records who approved it, on what date and under which instrument
  version — and refuses when the target version has already been published.
- **History is answered by date.** Rule resolution is `effective_from <= on < effective_to`, so a
  2027 amendment cannot change what applied in 2026, and a determination stores the exact rule
  version that decided it.
- **Every decision is provable.** `policy_determinations` records subject, rule version, facts,
  outcome and reason — which is what lets MMAKF answer "what rule applied to this person, who issued
  it, when did it take effect, what was it based on, and can they appeal".

[`tests/policy-engine.test.ts`](../../tests/policy-engine.test.ts) proves each of those, including
the boundary cases: the day a rule takes effect, the day it expires, a future rule, an expired rule,
and a historical determination that must not move when the rule is amended.
