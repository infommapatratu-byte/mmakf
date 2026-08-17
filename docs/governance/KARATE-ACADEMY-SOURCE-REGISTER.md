# Karate Academy Bharat — Source Register

**Source of this work:** Karate Academy Bharat — <https://www.karateacademy.in/>
**Retrieval date for every entry below:** 2026-08-17
**Compiled by:** MMAKF governance engineering
**Status of this document:** SOURCE RESEARCH. It is *not* an MMAKF regulation and confers nothing.

---

## 0. How to read this register

This file records what the public Karate Academy Bharat website **actually says**, in the words it
uses, with the page it says it on. It is a register of *evidence*, not a register of rules in force.

Three layers are used throughout and are **never merged automatically**:

| Layer | Meaning | Who owns it |
|---|---|---|
| **ACADEMY POLICY** | Published by Karate Academy Bharat for its own students, staff and dojo. | Karate Academy Bharat |
| **MMAKF REGULATION** | Formally adopted by MMAKF through its own governance process. | MMAKF |
| **EXTERNAL REFERENCE** | Owned by WKF, JKA, WADA/NADA, IOC, a government or another body. | The issuing body |

**Nothing in this register is an MMAKF regulation.** Every entry below is either ACADEMY POLICY or
EXTERNAL REFERENCE. The `MMAKF ADOPTION` field on every entry reads `NOT ADOPTED` unless and until
MMAKF's governing body records an adoption decision in `policy_provisions` — see
[`src/db/policy.schema.ts`](../../src/db/policy.schema.ts).

`Confidence` values:

- **verbatim** — the wording below is the source's own wording.
- **verbatim-partial** — the source's wording, but the page also carries images whose text could not
  be read; the extraction is complete for text and incomplete for images.
- **paraphrased** — the meaning is the source's; the sentence is not.
- **absent** — the page was retrieved and contains no rule on this topic. Recorded so a later reader
  can tell "checked and empty" from "never checked".

---

## 1. Pages retrieved

Discovery was done by walking the site's own navigation and footer from the root document. **No
`sitemap.xml` is published** — `https://www.karateacademy.in/sitemap.xml` returned HTTP 404 — so
coverage below is nav-complete rather than sitemap-complete.

| # | URL | Policy content found? |
|---|---|---|
| 1 | `/` | Principles only (Rei, Zanshin, Mushin) |
| 2 | `/karate` | Principles only |
| 3 | `/karate-academy` | Operating facts (styles, venue, session times, motto) |
| 4 | `/karate-academy/rules-regulation` | **YES — the primary rules page** |
| 5 | `/karate-academy/rules-regulation/lifestyle-system` | **YES — lifestyle doctrine** |
| 6 | `/karate-academy/examlevels` | **YES — grade durations and examination fees** |
| 7 | `/fee-structure` | **YES — fee schedule and payment rule** |
| 8 | `/fee-structure/scholar-ship-fellow-ship-program` | **YES — award categories and eligibility** |
| 9 | `/serve-with-us-job-career` | **YES — recruitment, eligibility, assessment weighting** |
| 10 | `/notice` | **YES — vacancy states and dates** |
| 11 | `/karate-academy/uniform-standards` | **YES — partial (text thin, most content is imagery)** |
| 12 | `/karate-academy/identity-card` | **YES — authentication practice** |
| 13 | `/karate-academy/instructer` | Instructor credentials (a person, not a rule) |
| 14 | `/karate-academy/instructer/recognition-identity` | **Image-only — no extractable text** |
| 15 | `/karate-academy/affiliation` | **YES — the academy's definition of affiliation** |
| 16 | `/karate-academy/admission-form` | Redirects to an external Google Form; no on-page terms |
| 17 | `/karate-academy/judgerefree-teachings` | **Stub — heading and the word "Terms:" with no terms** |
| 18 | `/karate-academy/wisdombasic-knowledge` | Doctrine (knowledge, the three gunas) |
| 19 | `/karate-academy/japanese-terms` | Etiquette vocabulary; **Dojo Kun named but not reproduced** |
| 20 | `/karate-academy/my-schedule` | Embedded Google Calendar; no text |
| 21 | `/karate-academy/kumite` | Definitions only — **no safety or competition rule** |
| 22 | `/karate-academy/kihon` | Definitions only |
| 23 | `/karate-academy/bunkai` | Definitions only |
| 24 | `/karate-academy/advanced-techniques` | Definitions only — **no prerequisite, no safety warning** |
| 25 | `/karate-academy/kata` (+ 3 grade-band child pages) | Kata lists by grade band |
| 26 | `/karate-academy/upcoming-events` | 2025 international calendar (third-party events) |
| 27 | `/karate-academy/our-pride-lineage` | Lineage and honours |
| 28 | `/karate-academy/our-pride-lineage/our-programs` (+ 3 children) | Programme names only |
| 29 | `/sitemap.xml` | **HTTP 404 — no sitemap published** |

---

## 2. The register

### KAB-001 — Rules of Dojo

- **source_url:** `https://www.karateacademy.in/karate-academy/rules-regulation`
- **source_title:** Rules & Regulation
- **source_section:** Rules of Dojo
- **source_date:** not stated on page
- **retrieval_date:** 2026-08-17
- **source_type:** web page, primary, first-party
- **confidence:** verbatim

**source_excerpt:**

1. "Stay in Discipline"
2. "Think thrice before you speak. (Raise your hand)"
3. "Be in Uniform (GI) appropriately. (NF/WKF Approved)"
4. "Greet everyone while entering the dojo, exiting the dojo, or wherever you meet"
5. "Practice with assigned/own equipment"
6. "Respect everyone and everything around you"
7. "Remember always, you came to learn. So, stay humble"
8. "Kindly bring your water bottle, Lunchbox, & Exercise towel"
9. "There are only two relationships in Karate form Martial-Arts: Master and Disciple"
10. "Usage of anti-doping drugs is strictly prohibited"

**normalized_rule:**

| Ref | Normalised | Category |
|---|---|---|
| KAB-001.1 | Conduct in the training hall shall be disciplined. | DISCIPLINE |
| KAB-001.2 | A student shall seek permission to speak by raising a hand. | TRAINING ETIQUETTE |
| KAB-001.3 | A student shall train in a gi meeting national-federation / WKF approval. | UNIFORM |
| KAB-001.4 | A student shall greet on entering and leaving the dojo and on meeting others. | DOJO ETIQUETTE |
| KAB-001.5 | A student shall train with assigned or personally owned equipment. | EQUIPMENT |
| KAB-001.6 | A student shall show respect to persons and property in the dojo. | RESPECT |
| KAB-001.7 | A student shall maintain humility as a learner. | CHARACTER |
| KAB-001.8 | A student shall bring water, food and a training towel. | SAFETY / WELFARE |
| KAB-001.9 | The academy recognises two relationships in its martial art: Master and Disciple. | RELATIONSHIP MODEL |
| KAB-001.10 | Use of doping substances is prohibited. | ANTI-DOPING |

- **STATUS:** ACADEMY POLICY
- **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** KAB-001.3 cites "NF/WKF Approved" — the *standard* is EXTERNAL REFERENCE (WKF) even
  though the *obligation to wear it* is ACADEMY POLICY. KAB-001.10 is compatible with, but is not,
  the NADA/WADA rules; adopting it must be done **by reference to NADA**, not by restating it.
  **KAB-001.9 requires governance review before any adoption** — see
  [MMAKF-REGULATORY-GAP-ANALYSIS.md](./MMAKF-REGULATORY-GAP-ANALYSIS.md) §4.1.

---

### KAB-002 — Relationship guidelines

- **source_url:** `https://www.karateacademy.in/karate-academy/rules-regulation`
- **source_section:** relationship guidance
- **retrieval_date:** 2026-08-17 · **source_type:** web page, primary · **confidence:** paraphrased

**source_excerpt:** Toward a **Master/Senior** — approach with reverence and respect, serve with
humility. Toward **co-practitioners of equal level** — kindness, encouragement, mutual support.
Toward **juniors/beginners** — patience, guidance, celebrate progress.

**normalized_rule:** Conduct expectations are differentiated by relative seniority: deference
upward, mutual support laterally, patience and encouragement downward.

- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** The lateral and downward limbs map cleanly onto a peer-conduct and anti-bullying
  provision. The upward limb ("serve with humility") is a teaching-relationship statement and must
  not be transposed into a federation instrument as an obligation of obedience.

---

### KAB-003 — Mandates for Parents/Guardians (four regulative principles)

- **source_url:** `https://www.karateacademy.in/karate-academy/rules-regulation`
- **source_section:** Mandates for Parents/Guardians
- **retrieval_date:** 2026-08-17 · **source_type:** web page, primary · **confidence:** verbatim

**source_excerpt:** Four regulative principles required:
"No meat eating"; "No intoxication (including caffeine-containing tea/coffee)"; "No gambling";
"No illicit sex or extra-marital relationship".

**normalized_rule:** The academy states four abstinence requirements addressed to parents and
guardians of students.

- **STATUS:** ACADEMY POLICY
- **MMAKF ADOPTION:** **NOT ADOPTED — AND FLAGGED AS NOT ADOPTABLE WITHOUT LEGAL REVIEW**
- **notes:** Recorded because it is published, and this register does not edit its source. It is
  flagged, not adopted, because a national federation conditioning participation on a member's
  household diet, beverage choice or private sexual conduct engages non-discrimination, privacy and
  child-participation considerations that a sports body cannot resolve by restating the rule. See
  [MMAKF-REGULATORY-GAP-ANALYSIS.md](./MMAKF-REGULATORY-GAP-ANALYSIS.md) §4.2. **No MMAKF surface
  may render this text as a federation requirement.**

---

### KAB-004 — Dietary guidance

- **source_url:** `https://www.karateacademy.in/karate-academy/rules-regulation` · **confidence:** verbatim
- **source_excerpt:** Recommended — "Green Vegetables, Milk products, Roti, Grams, Pulses, Fruits".
  Prohibited — "Non-Veg, Oily Foods, Avoid onion and Garlic".
- **normalized_rule:** The academy publishes a recommended and a discouraged food list.
- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** Presented on the source as guidance, not as an eligibility condition. Any federation
  nutrition material must be authored on sports-medicine grounds and issued as a GUIDELINE, never as
  a REGULATION, and must not reproduce this list as though MMAKF had assessed it.

---

### KAB-005 — How to Learn

- **source_url:** `https://www.karateacademy.in/karate-academy/rules-regulation` · **confidence:** verbatim
- **source_excerpt:** 1. "Approach a Master"; 2. "Learn and Inquire from him submissively";
  3. "Render service unto him".
- **normalized_rule:** The academy's stated method of learning is approach, submissive inquiry, and
  service to the teacher.
- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** Pedagogical doctrine. It is not convertible into a federation obligation: "render
  service unto him" describes an unbounded personal duty to an individual, and has no place in an
  instrument that also has to govern safeguarding and complaints against that same individual.

---

### KAB-006 — A-B-C-D

- **source_url:** `https://www.karateacademy.in/karate-academy/rules-regulation` · **confidence:** verbatim
- **source_excerpt:** "Success Steps: A-B-C-D — Aim, Behaviour, Character, Discipline".
- **normalized_rule:** Four named development dimensions: aim, behaviour, character, discipline.
- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** The only source-published *structure* for character assessment. If MMAKF ever builds a
  character framework, this is the source-derived skeleton — but the source supplies **no criteria,
  no rubric, no evidence standard and no scale**, so a scoring model built on it would be invented,
  not derived.

---

### KAB-007 — Lifestyle system

- **source_url:** `https://www.karateacademy.in/karate-academy/rules-regulation/lifestyle-system`
- **retrieval_date:** 2026-08-17 · **confidence:** verbatim

**source_excerpt:** "Lifestyle system: Perfect system". "Nowadays, we are facing many unusual
livelihood issues. The exact problem is not money or resources. It is habits, character, and
discipline." Four life phases of 25% each: "Life of divinity, self-analysis, discipline (by being a
disciple), and self-development"; "Life of serving the family by following the behavior of the
respective profession"; "Process of unattaching from a family with completing the respective duties
and switching to serve humanity"; "Serving humanity and making oneself prepared for the Last
examination of this body". "Life is preparation, death is examination". Four professional types with
stated guna proportions — Teaching ("by word, mind, and action (Sattvic or Sudh Satvic)");
Administrative ("Till 25% satva nature, 75% rajsik"); Business ("5% sattvic, Upto 35% rajsik and
more than 60% tamas"); Service ("1-3% sattvic, 5-10% rajsik, 80-90% Tamsic").

- **normalized_rule:** A four-stage life model and a four-way classification of occupations by guna.
- **STATUS:** ACADEMY POLICY (doctrinal) · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** Doctrine, not regulation. It ranks occupations by spiritual quality; a federation that
  adopted it would be classifying its own members' livelihoods. Preserved verbatim here and
  **excluded from every proposed federation instrument.**

---

### KAB-008 — Grade durations and examination fees

- **source_url:** `https://www.karateacademy.in/karate-academy/examlevels`
- **source_section:** belt progression, labelled "2025"
- **retrieval_date:** 2026-08-17 · **confidence:** verbatim

**source_excerpt:**

| Grade | Duration | Examination fee |
|---|---|---|
| Yellow Belt | 3 months | ₹500 |
| Orange Belt | 3 months | ₹600 |
| Green Belt | 4 months | ₹700 |
| Purple/Blue Belt | 4 months | ₹800 |
| Brown 4th Kyu | 6 months | ₹900 |
| Brown 3rd Kyu | 6 months | ₹1,000 |
| Brown 2nd Kyu | 6 months | ₹1,100 |
| Brown 1st Kyu | 6 months | ₹1,200 |

- **normalized_rule:** The academy publishes a minimum training duration and an examination fee per
  kyu grade for 2025.
- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** **This is the single most dangerous entry in the register to copy.** These are the
  Academy's time-in-grade periods and the Academy's fees for 2025. MMAKF time-in-grade belongs in a
  `GradeVersion` under an approved `ExamRuleVersion`, and MMAKF fees belong to the federation fee
  engine. The page states **no syllabus, no pass mark, no examiner requirement and no appeal route**
  for any grade — see the gap analysis. Nothing above 1st Kyu appears at all.

---

### KAB-009 — Competition tiers

- **source_url:** `https://www.karateacademy.in/karate-academy/examlevels` · **confidence:** verbatim
- **source_excerpt:** Four tiers — "Cluster/District Level"; "Zonal/State Level"; "National Level
  (NF/SGFI/UG)"; "International Level" (South Asian Games, Asian Games, Commonwealth Games,
  Karate-1 Youth League, Youth Olympics, World Championship, World Games).
- **normalized_rule:** A four-tier competitive ladder from cluster/district to international.
- **STATUS:** ACADEMY POLICY (as a description) / **EXTERNAL REFERENCE** (every named event)
- **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** The named competitions are owned by WKF, AKF, the IOC and the organisers of the
  respective Games. MMAKF may describe the ladder; it may not represent any of these events as MMAKF
  competitions or imply selection rights it has not published.

---

### KAB-010 — Academy fee schedule

- **source_url:** `https://www.karateacademy.in/fee-structure`
- **source_section:** "Fee Structure (INR) Year-2025" · **confidence:** verbatim

**source_excerpt:** Admission Fees: 500. Training Fees: "1500 /Month (Should be submitted for the
upcoming belt duration together . Ex: Yellow Belt -3 Months, So pay for whole 3 Month fee before the
start of course .)". Belt Fees: 150. Examination Fees: A-level and B-Level (linked). Tournament
Fees: "Will be announced 30 days before the tournament". Guest Camp Fee: "No Charges for
Academy/Institute/Federation Student".

**normalized_rule:**

| Ref | Normalised |
|---|---|
| KAB-010.1 | Admission fee ₹500 (one-time). |
| KAB-010.2 | Training fee ₹1,500 per month, payable in advance for the whole duration of the grade being trained for. |
| KAB-010.3 | Belt fee ₹150. |
| KAB-010.4 | Examination fees are published per level (A-level / B-level). |
| KAB-010.5 | Tournament fees are announced no later than 30 days before the tournament. |
| KAB-010.6 | No guest-camp charge for Academy, Institute or Federation students. |

- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** **ACADEMY FEE POLICY and MMAKF FEE POLICY are two documents.** Nothing here may be
  loaded into the MMAKF fee framework. KAB-010.5 (30 days' notice) is the one provision that is
  genuinely useful as a *federation* service standard, and even that must be adopted on its own
  merits rather than inherited. **No refund rule, due date, late-payment rule, pro-rata rule or
  withdrawal rule appears anywhere on the source** — see the gap analysis.

---

### KAB-011 — Scholarship and fellowship programme

- **source_url:** `https://www.karateacademy.in/fee-structure/scholar-ship-fellow-ship-program`
- **confidence:** verbatim-partial

**source_excerpt:** **Need-Based Scholarship** — "Partial to full fee coverage", with "continuous
performance review". **Merit-Based Scholarship** — "Awarded based on measurable excellence";
awardees may represent the academy. **Extraordinary Fellowship Program (EOF)** — "advanced,
high-performance training ecosystem", mentorship from senior instructors, leadership pathways,
national/international exposure. Eligibility: "Passion and discipline in martial arts"; proven
achievements (merit/EOF); financial need (need-based); verified documentation. Materials: updated
CV; certificates; "Statement of Purpose (mandatory for EOF)". Selection: "multi-stage, merit-driven,
and highly competitive". The notice page adds: "Limited seats as per Resource availability".

- **normalized_rule:** Three award categories with stated eligibility bases, a documentary
  requirement and a multi-stage selection.
- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** No award amount, no decision-maker, no timeline, no renewal condition and **no appeal
  route** is published. "Continuous performance review" is stated without criteria, which means an
  award can be withdrawn against a standard the holder was never given.

---

### KAB-012 — Instructor intern pathway

- **source_url:** `https://www.karateacademy.in/serve-with-us-job-career`
- **source_section:** Karate Instructor (Intern) · **confidence:** verbatim

**source_excerpt:** Location Guwahati, Assam. Eligibility "Brown Belt (4th Kyu) and above".
Duration 3 months (Active Athlete). Unpaid internship with mentorship and dojo exposure. Selection —
**E.1: Skill and Knowledge Test (40 marks); E.2: Maturity Test in Normal Life (40 marks);
E.3: Interview (20 marks)**. Documents — letter of motivation; two letters of recommendation
(Master + Federation); cover letter; proof of martial arts grade; academic credentials. Application
by Google Form. The notice page records this vacancy as **Closed (16112026)**.

**normalized_rule:**

| Ref | Normalised |
|---|---|
| KAB-012.1 | `minimum_grade = 4th Kyu (Brown Belt)` for the intern pathway. |
| KAB-012.2 | `assessment = { E1: 40, E2: 40, E3: 20 }`, total 100. |
| KAB-012.3 | `required_documents = [motivation_letter, recommendation x2 (master, federation), cover_letter, grade_proof, academic_documents]`. |
| KAB-012.4 | `duration = 3 months`, `compensation = unpaid`. |

- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** KAB-012.1–.3 are the highest-value source material in the whole register: concrete,
  testable, and already shaped like rule conditions. **They remain ACADEMY requirements** until
  MMAKF approves an equivalent. E.2 "Maturity Test in Normal Life" carries **40% of the decision
  with no published criteria, rubric, evidence standard or examiner qualification** — the gap
  analysis treats this as a blocking defect, not a detail. The date "16112026" is written without
  separators; read as 16 November 2026 it is in the future relative to the retrieval date, which is
  an ambiguity in the source, not a finding.

---

### KAB-013 — Instructor recruitment (30 positions)

- **source_url:** `https://www.karateacademy.in/serve-with-us-job-career` · **confidence:** verbatim
- **source_excerpt:** 30 positions, Guwahati. Eligibility "Black belt 2nd Dan (Nidan) or higher".
  Salary ₹15,000–18,000/month with food and accommodation. **Application fee $5 USD.** Selection
  E.1/E.2/E.3 as above. Documents identical to the intern position.
- **normalized_rule:** `minimum_grade = 2nd Dan (Nidan)`; `positions = 30`;
  `remuneration = 15000..18000 INR/month + board`; `application_fee = 5 USD`.
- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** The **application fee charged to a job applicant** is an employment-practice question,
  not a sporting one, and MMAKF must not replicate it in a federation recruitment instrument without
  legal advice. Note also that this is an *employment* rule and belongs in a StaffCode / employment
  policy — it is not a membership rule, a grading rule or a technical rule.

---

### KAB-014 — Disciple Karate Instructor

- **source_url:** `https://www.karateacademy.in/serve-with-us-job-career` · **confidence:** verbatim
- **source_excerpt:** 2 positions. "Black belt 2nd Dan (Nidan) or higher". ₹15,000–18,000/month with
  accommodation. Additional benefits: spiritual discourses; emphasis on personal transformation.
  Application fee $5 USD with financial aid available.
- **normalized_rule:** A distinct "Disciple" instructor track with the same grade floor as the
  ordinary instructor track, differentiated by a stated formation element (spiritual discourse and
  personal transformation) rather than by any additional technical requirement.
- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** The source describes the disciple track by its *content*, not by any additional
  obligation. **No vow, no exclusivity, no lifetime commitment and no obedience clause appears on
  the source.** Any such term in a future federation instrument would be invented. Wording put to
  this project as source-derived — "mandatory adherence to Rules & Regulations", "high moral and
  human ethics", "righteousness", "spiritual discourse described as non-superstitious" — is **NOT
  FOUND IN PUBLIC KARATEACADEMY.IN SOURCE** in those words; what is found is the summary above.

---

### KAB-015 — Executive Assistant to Founder/CEO

- **source_url:** `https://www.karateacademy.in/serve-with-us-job-career` · **confidence:** verbatim
- **source_excerpt:** 1 position. ₹10,000–18,000/month. Tasks: calendar management, email filtering,
  travel coordination, document preparation, research, task delegation. Apply by email to
  `karateacademyin@gmail.com`.
- **STATUS:** ACADEMY POLICY (employment) · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** Recorded for completeness. Contains no rule of general application.

---

### KAB-016 — Chief Executive Officer

- **source_url:** `https://www.karateacademy.in/serve-with-us-job-career` · **confidence:** verbatim
- **source_excerpt:** Guwahati (Hybrid). **"Investment Required: $1 Million USD minimum"**;
  **"Equity Offered: 40% ownership stake"**. Responsibilities include strategic planning, operations
  oversight, partnership development, and compliance with WKF standards. The notice page records the
  post as **Closed (11092025)**.
- **STATUS:** ACADEMY POLICY (commercial) · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** This is an **equity-for-investment proposition attached to an executive title**, not an
  employment rule and not a governance rule. It has no federation-policy analogue and **must not be
  migrated into any MMAKF instrument.** A national federation's chief executive appointment cannot be
  conditioned on a capital contribution; recording it here is source fidelity, not endorsement.

---

### KAB-017 — Notices

- **source_url:** `https://www.karateacademy.in/notice` · **confidence:** verbatim
- **source_excerpt:** Karate Instructor (Intern) — Closed (16112026). Scholarship & Fellowship
  Program — Open (08102025); types "Need-Based Scholarship", "Merit-Based Scholarship",
  "Extraordinary Fellowship Program (EOF)"; eligibility "dedicated and high-potential individuals in
  martial arts"; "Limited seats as per Resource availability". Chief Executive Officer — Closed
  (11092025). "$51.03 Billion: Training & Development; Expected Investment, Bharat" (09092025).
  Contacts: `connect@karate.net.in`, `karateacademyin@gmail.com`, +91 8294129284.
- **normalized_rule:** The academy operates a dated notice board carrying vacancy states.
- **STATUS:** ACADEMY POLICY (operational) · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** Useful precedent for the MMAKF **Circular** instrument type: a notice has an issue date,
  a state and an audience. Dates are written `DDMMYYYY` without separators, which is ambiguous on its
  face; MMAKF circulars must carry ISO dates.

---

### KAB-018 — Uniform standard

- **source_url:** `https://www.karateacademy.in/karate-academy/uniform-standards` · **confidence:** verbatim-partial
- **source_excerpt:** "Inter-national Standard(WKF-Approved)" for national or international
  competition. A practice gi is shown for routine training. Suppliers listed: "Hanna, USI, GOKIADO
  etc."
- **normalized_rule:** Competition gi must meet the WKF-approved standard; training gi is a separate,
  less specified category; named suppliers are listed as examples.
- **STATUS:** ACADEMY POLICY, citing **EXTERNAL REFERENCE** (WKF gi specification)
- **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** Most of this page is imagery; the extraction is complete for text and incomplete
  overall. **MMAKF must not turn the supplier list into a brand requirement** — the source presents
  it as a recommendation ("etc."), and a federation naming mandatory brands creates a procurement and
  competition-law exposure it has not assessed.

---

### KAB-019 — Identity card and QR authentication

- **source_url:** `https://www.karateacademy.in/karate-academy/identity-card` · **confidence:** verbatim
- **source_excerpt:** Student and Coach ID card samples; "the above ID samples are computer generated
  and contain QR, which can be asked by the present Instructor for authentication."
- **normalized_rule:** Identity cards are issued in student and coach classes and carry a QR code
  which an instructor present may require to be produced for authentication.
- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** Aligns with MMAKF's existing `/verify` credential-verification surface. **No validity
  period, replacement rule, revocation rule or misuse consequence is published** by the source.

---

### KAB-020 — Definition of affiliation

- **source_url:** `https://www.karateacademy.in/karate-academy/affiliation` · **confidence:** verbatim
- **source_excerpt:** "Our (MMAKF India & Karate Academy, India) definition of affiliation is only
  limited to our student". WKF described as "the international governing body recognized by the IOC
  (Lausanne, Switzerland) and is responsible for all sports-Karate-related activities worldwide"; the
  WKF accredits the academy's instructors. MMAKF named as parent organisation. Partners listed for
  technology, for ethical/moral/spiritual education, and for WADA anti-doping education.
- **normalized_rule:** In academy usage, "affiliation" denotes the academy–student relationship and
  nothing wider.
- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** **This entry is a naming conflict, and it matters.** MMAKF's own affiliation domain
  ([`/affiliation`](../../src/pages/affiliation.astro), [`src/db/affiliation.ts`](../../src/db/affiliation.ts))
  means chartering a dojo, a district body or a state body — an entirely different thing from the
  academy's usage. The word must not be allowed to travel between the two. The WKF/IOC description is
  EXTERNAL REFERENCE and is the WKF's to state.

---

### KAB-021 — Etiquette vocabulary and the Dojo Kun

- **source_url:** `https://www.karateacademy.in/karate-academy/japanese-terms` · **confidence:** verbatim
- **source_excerpt:** "Dojo Kun (道場訓): Dojo precepts"; "Osu (押忍): A term of respect and
  acknowledgement"; "Rei (礼): Bow, respect"; "Sensei (先生): Teacher/Instructor";
  "Senpai (先輩): Senior student"; "Kohai (後輩): Junior student".
- **normalized_rule:** The academy uses the standard etiquette vocabulary and names the Dojo Kun.
- **STATUS:** ACADEMY POLICY (terminology) · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** **The Dojo Kun is NAMED but its precepts are NOT REPRODUCED anywhere on the source.**
  Writing them out would be importing them from elsewhere and attributing them to Karate Academy
  Bharat. Recorded as: *precepts not published — NOT FOUND IN PUBLIC KARATEACADEMY.IN SOURCE.*

---

### KAB-022 — Training principles

- **source_url:** `https://www.karateacademy.in/` and `https://www.karateacademy.in/karate`
- **confidence:** verbatim
- **source_excerpt:** **Rei (礼)** — "bowing to show respect to the dojo, instructors, and fellow
  practitioners", emphasising "humility, discipline, and the proper attitude in training".
  **Zanshin (残心)** — "continued alertness and readiness, maintaining focus even after executing a
  technique". **Mushin (無心)** — "free from distractions and conscious thought, allowing for fluid
  and intuitive movements". "Karate is not just a physical activity but a comprehensive discipline
  that integrates physical techniques with mental and philosophical training."
- **normalized_rule:** Three named training principles, one of which (Rei) carries an explicit
  behavioural obligation to bow to the dojo, instructors and fellow practitioners.
- **STATUS:** ACADEMY POLICY · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** Rei is the only one of the three that is a *conduct* rule; Zanshin and Mushin are
  training concepts and are not enforceable provisions.

---

### KAB-023 — Academy operating facts

- **source_url:** `https://www.karateacademy.in/karate-academy` · **confidence:** verbatim
- **source_excerpt:** Motto "Quality over quantity." Styles taught: Gosoku-ryū and Shōtōkan. Venue
  near KV Gate, IIT Guwahati. Sessions Sundays and Thursdays, 06:00–09:30 IST. Lead instructor
  Siddharth Prasad, "a student of Shifu. Jr. Tiger Lee". Parent organisation MMAKF.
- **STATUS:** ACADEMY POLICY (operational fact) · **MMAKF ADOPTION:** N/A
- **notes:** The published session window is the only attendance-adjacent fact on the source. It is a
  timetable, not an attendance policy.

---

### KAB-024 — Lineage

- **source_url:** `https://www.karateacademy.in/karate-academy/our-pride-lineage` · **confidence:** verbatim
- **source_excerpt:** "Shifu S.N.T. Lee" — Grandmaster's Master. "Shifu Jr. Tiger Lee" —
  Grandmaster & Soke (MMAKF). "Renshi Pramod Pathak" — Director and Martial Arts Coach.
  Tiger Lee: represented India at the 1998 Asian Games (Thailand); Guinness and Limca record holder;
  72+ gold medals; 40+ years teaching. "Karate is a lifestyle."
- **STATUS:** ACADEMY POLICY (historical claim) · **MMAKF ADOPTION:** N/A
- **notes:** **Claims about individuals, not rules.** Recorded as source content; they must not be
  republished on an MMAKF surface as verified federation fact without independent verification — see
  [`docs/CLAIMS-AUDIT.md`](../CLAIMS-AUDIT.md) and
  [`docs/PENDING-FEDERATION-VERIFICATION.md`](../PENDING-FEDERATION-VERIFICATION.md).

---

### KAB-025 — Instructor credentials (a person, not a rule)

- **source_url:** `https://www.karateacademy.in/karate-academy/instructer` · **confidence:** verbatim
- **source_excerpt:** Siddharth Prasad — Co-CEO, MMAKF India; International Coach, WKF (Spain);
  "Black Belt II Dan and accredited coach by WKF"; practising since 2016; teaching in 14+ schools;
  certifications listed include WKF Accredited Coach Licence, CPR/AED/First Aid, WADA anti-doping
  education, IOC Safeguarding Officer (in progress).
- **normalized_rule:** *(none — this is a biography)*
- **STATUS:** ACADEMY POLICY (profile) · **MMAKF ADOPTION:** N/A
- **notes:** The statement put to this project that "CPR/First Aid is highly desirable" and that
  sports psychology, video learning and biomechanics are "preferred knowledge areas" is **NOT FOUND
  as a published requirement** on this page or anywhere else on the site. What is published is that
  *this instructor holds* CPR/AED/First Aid and WADA education. A held credential is not a stated
  requirement, and this register does not promote one into the other.

---

### KAB-026 — Technical content pages

- **source_urls:** `/karate-academy/kihon`, `/karate-academy/kumite`, `/karate-academy/bunkai`,
  `/karate-academy/advanced-techniques`, `/karate-academy/kata` and its three grade-band children
- **confidence:** verbatim (definitions) / **absent** (rules)
- **source_excerpt:** Definitional only. Kumite: "Practice of techniques against an opponent, ranging
  from pre-arranged (Yakusoku Kumite) to free sparring (Jiyu Kumite)"; Ippon Kumite "One-step
  sparring, where one practitioner attacks and the other defends and counter-attacks in a single
  step"; Sanbon Kumite "Three-step sparring, involving a series of three attacks and defenses".
  Kihon: stance and technique definitions. Advanced Techniques: "Kansetsu-waza (関節技): Joint
  manipulation techniques, targeting the joints to control or incapacitate an opponent";
  "Kyusho-jutsu (急所術): Pressure point techniques, targeting vital points on the body to cause pain
  or disruption."
- **STATUS:** ACADEMY POLICY (syllabus description) · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** **Safety finding.** Joint-manipulation and pressure-point techniques are published with
  **no grade prerequisite, no supervision requirement, no age restriction and no safety warning.**
  For a federation that trains minors this is a gap a technical committee has to close before any
  MMAKF technical regulation cites these pages. Raised in the gap analysis at §4.4.

---

### KAB-027 — Judge / Referee teachings

- **source_url:** `https://www.karateacademy.in/karate-academy/judgerefree-teachings`
- **confidence:** absent
- **source_excerpt:** Heading "Judge/Refree Teachings" and the label "Terms:" — **followed by no
  terms.** The page is a stub.
- **normalized_rule:** *(none)*
- **STATUS:** **NOT FOUND IN PUBLIC KARATEACADEMY.IN SOURCE** · **MMAKF ADOPTION:** N/A
- **notes:** Officiating qualification, licensing, appointment and scoring have **no source at all**.
  MMAKF's Referee & Judge Certification Regulation must therefore be authored from scratch under WKF
  reference — it cannot be migrated.

---

### KAB-028 — Admission form

- **source_url:** `https://www.karateacademy.in/karate-academy/admission-form` · **confidence:** absent
- **source_excerpt:** The page carries a link to a Google Form titled for "MODERN MARTIAL ARTS KARATE
  DO FEDERATION OF INDIA". No fields, declarations, consents or terms are rendered on the academy's
  own page.
- **STATUS:** **NOT FOUND IN PUBLIC KARATEACADEMY.IN SOURCE** (as published terms) · **MMAKF ADOPTION:** N/A
- **notes:** Consent language, guardian declarations, medical declarations and data-protection terms
  are therefore **unpublished**. Anything MMAKF writes here is new drafting requiring approval, not
  migration. The form is hosted by a third party (Google), which is itself a data-processing fact the
  federation's privacy notice has to address.

---

### KAB-029 — External bodies named by the source

- **source_urls:** `/karate-academy/affiliation`, `/karate-academy/upcoming-events`,
  `/karate-academy/uniform-standards`, `/karate-academy/rules-regulation`
- **confidence:** verbatim
- **normalized_rule:** The source names WKF, the IOC, WADA, SGFI, AKF and the organisers of the
  Asian Games, South Asian Games, Commonwealth Games, Youth Olympic Games, World Games, World
  Championships and Karate-1 Premier League / Series A / Youth League.
- **STATUS:** **EXTERNAL REFERENCE** in every case · **MMAKF ADOPTION:** NOT ADOPTED
- **notes:** MMAKF already maintains a verified external register at
  [`/regulations`](../../src/pages/regulations.astro) with fetch evidence per link. **No rule may be
  attributed to WKF, JKA, WADA or NADA on the strength of this academy page**; the attribution has to
  come from the issuing body's own document. The source does not cite JKA at all — **"JKA rule": NOT
  FOUND IN PUBLIC KARATEACADEMY.IN SOURCE.**

---

## 3. Topics searched for and NOT FOUND

Each line below was searched for across the whole site. `NOT FOUND IN PUBLIC KARATEACADEMY.IN
SOURCE` is a finding and is recorded as such; **no gap on this list has been filled with an invented
rule.**

| Topic searched | Result |
|---|---|
| Child safeguarding / child protection policy | NOT FOUND |
| Complaints procedure | NOT FOUND |
| Disciplinary procedure, sanctions, hearing rights | NOT FOUND |
| Appeal against any decision (grading, selection, award, discipline) | NOT FOUND |
| Suspension / termination / expulsion grounds | NOT FOUND |
| Anti-harassment, anti-bullying, anti-discrimination | NOT FOUND |
| Injury reporting, first aid, emergency procedure | NOT FOUND (a credential is held; no procedure is published) |
| Medical clearance, return-to-training, return-to-competition | NOT FOUND |
| Attendance, punctuality, leave, absence | NOT FOUND (a session timetable exists; no policy) |
| Photography, video, media consent, withdrawal of consent | NOT FOUND |
| Social media conduct (personal vs official account) | NOT FOUND |
| Privacy notice / data protection / retention | NOT FOUND |
| Refund, cancellation, pro-rata, late payment | NOT FOUND |
| Conflict of interest, gifts, anti-bribery, procurement | NOT FOUND |
| Examiner appointment, examiner qualification, examination panel | NOT FOUND |
| Grading pass mark, syllabus per grade, re-examination | NOT FOUND |
| Certificate issuance, numbering, revocation | NOT FOUND |
| Coach-to-student ratio, supervision, one-to-one training | NOT FOUND |
| Parent access, authorised pickup, travel, accommodation of minors | NOT FOUND |
| Dan grading (any requirement above 1st Kyu) | NOT FOUND |
| Selection policy for representative teams | NOT FOUND |
| Dojo Kun — the precepts themselves | NOT FOUND (named only) |
| Instructor career ladder / titles above "Instructor" | NOT FOUND (Renshi and Soke appear as honorifics of named individuals, not as a published ladder) |
| Dojo affiliation / chartering requirements | NOT FOUND (the word means something else on the source — KAB-020) |
| Competition entry rules, protest procedure, age/weight divisions | NOT FOUND |
| Equipment safety standard (mitts, shin/instep, gum shield, groin guard) | NOT FOUND |

---

## 4. What this register is used for in the codebase

Every entry above is intended to be loaded into `source_documents` and `source_provisions`
([`src/db/policy.schema.ts`](../../src/db/policy.schema.ts)) with its URL, section, excerpt,
retrieval date and confidence intact. From there:

- a provision may be **cited** by an MMAKF instrument without being adopted;
- a provision may be **adopted**, which requires a named approver, an approval date and an
  instrument version — recorded on `policy_provisions`;
- a provision may be **rejected**, which is recorded with a reason and is *not* deleted.

`layer` is a column, not a convention. A query that renders academy material on a federation surface
has to ask for it explicitly, and [`tests/policy-engine.test.ts`](../../tests/policy-engine.test.ts)
fails if an adopted-looking output can be produced from an unadopted source provision.
