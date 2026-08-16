// The audiences MMAKF trains, and what the federation can truthfully say to
// each of them.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THIS FILE IS WRITTEN UNDER
// ─────────────────────────────────────────────────────────────────────────────
//
// Nothing here is a claim about outcomes, numbers, recognitions or results.
// Read it and you will find no "students improve their concentration by", no
// "trusted by 130 schools", no "reduces workplace stress". Those are the
// sentences a marketing page is made of and the federation has supplied
// evidence for none of them — PART D says in as many words: do not make medical
// or psychological claims without evidence.
//
// What IS here is true by construction, because it describes the federation's
// own process rather than the world:
//
//   · what a programme is assembled from (the components in `services`);
//   · what MMAKF needs to know before it can price one;
//   · what happens after you apply, step by step;
//   · what the institution has to provide.
//
// A school reading this learns what working with MMAKF involves. That is more
// useful than a claim it cannot check, and it is the only thing we are in a
// position to write.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO PRICES
// ─────────────────────────────────────────────────────────────────────────────
//
// Not one figure. The fee framework prices a configuration and it currently
// holds no published rules, so every page ends at REQUEST A QUOTATION. A number
// here would be the tenth scattered price the federation asked to have removed.

export interface AudienceSection {
  heading: string;
  body: string;
  /** Rendered as a plain list under the section, where the section has one. */
  points?: string[];
}

export interface Audience {
  slug: string;
  /** The `audience_kind` this maps to in the database. */
  kind: 'school' | 'corporate' | 'university' | 'government' | 'ngo' | 'community' | 'individual' | 'club';
  /** For the learn surface navigation. */
  navLabel: string;
  /** The headline. A statement, not a slogan. */
  title: string;
  /** One sentence, used for the meta description and the page standfirst. */
  standfirst: string;
  /** The SEO landing path on www, where one exists. */
  publicPath?: string;
  seoTitle?: string;
  seoDescription?: string;
  /** The action this page exists to produce. */
  action: { href: string; label: string };
  sections: AudienceSection[];
  /** What the federation needs from you before it can quote. */
  needsFromYou: string[];
}

/**
 * What happens after an application, in order.
 *
 * Shared by every audience because it IS the same process — and because a
 * process written out once cannot drift into six versions that disagree about
 * whether the quotation comes before or after the consultation.
 *
 * Deliberately carries no timings. The federation has published no service
 * standard, and "we respond within 48 hours" printed on six pages is a promise
 * the system would then report people as breaking.
 */
export const PROCESS_STEPS = [
  {
    n: 1, title: 'You apply',
    body: 'The form asks what you need, how many people, how often, and where. It saves as you go, so you can leave it and come back.',
  },
  {
    n: 2, title: 'MMAKF reviews it',
    body: 'A training administrator reads the requirements and comes back to you if anything is unclear. You are given a reference and a page that shows where the application has got to.',
  },
  {
    n: 3, title: 'The programme is designed',
    body: 'What is taught, to whom, in what batches, at what frequency, with what assessment. This is a conversation, not a menu.',
  },
  {
    n: 4, title: 'A quotation is issued',
    body: 'One fee, calculated from the configuration under the federation’s published framework, itemised so you can see how it was arrived at.',
  },
  {
    n: 5, title: 'You approve, and an agreement is signed',
    body: 'The quotation you approved is the one the agreement is written against, kept as a version that cannot change afterwards.',
  },
  {
    n: 6, title: 'Instructors are assigned and the calendar is set',
    body: 'MMAKF matches instructors on qualification, location and availability. You see who is coming and when, and are told if anything moves.',
  },
  {
    n: 7, title: 'Delivery, attendance and reporting',
    body: 'Sessions are recorded as they happen. Attendance, progress and any assessments appear in your portal rather than arriving as a spreadsheet at the end.',
  },
] as const;

export const AUDIENCES: Audience[] = [
  {
    slug: 'schools',
    kind: 'school',
    navLabel: 'Schools',
    title: 'Karate in schools',
    standfirst:
      'MMAKF runs structured Shotokan karate, physical education and self-defence programmes inside schools, taught by federation instructors on the school’s own premises.',
    publicPath: '/karate-for-schools',
    seoTitle: 'Karate for schools — MMAKF school programmes in India',
    seoDescription:
      'Structured Shotokan karate, physical education and self-defence programmes for schools, delivered on campus by instructors of the Modern Martial Arts Karate-Do Federation of India.',
    action: { href: '/learn/apply?audience=school', label: 'Start a school application' },
    sections: [
      {
        heading: 'What a school programme is made of',
        body:
          'A programme is assembled from components rather than bought off a shelf. A school taking karate for its middle years and a school running a girls’ self-defence course are doing different things, and the federation does not price them as though they were the same.',
        points: [
          'Shotokan karate — the graded syllabus, taught in age-appropriate batches',
          'Physical education support — conditioning, coordination and discipline within PE time',
          'Self-defence — practical, taught separately from the graded syllabus',
          'Assessment and grading — examinations conducted under the federation’s technical authority',
          'Certification — MMAKF certificates, verifiable by anyone who is shown one',
          'Competition preparation — for schools that want to enter federation events',
          'Instructor development — for a school’s own PE staff',
        ],
      },
      {
        heading: 'How it runs inside a school day',
        body:
          'Most school programmes run in batches, in a hall or any clear indoor space, at a frequency the school sets. MMAKF works around the timetable rather than the other way round — before assembly, during PE periods, or after school. Which of those suits you is a question on the application form, and the answer changes the schedule and the fee.',
      },
      {
        heading: 'Safeguarding',
        body:
          'Programmes involving children are taught only by instructors whose child-protection clearance is on the federation’s record and current. Where no clearance is recorded, the instructor is not eligible for the programme — the system treats a missing clearance as no clearance rather than assuming the best.',
      },
    ],
    needsFromYou: [
      'A clear indoor space — a hall, a covered area or an unused classroom block',
      'A named coordinator at the school, usually the sports or PE teacher',
      'The number of participants and their age groups',
      'Consent arrangements for children taking part',
    ],
  },

  {
    slug: 'corporates',
    kind: 'corporate',
    navLabel: 'Corporates',
    title: 'Martial arts and self-defence at work',
    standfirst:
      'MMAKF runs self-defence, women’s safety and martial arts programmes for companies, at the workplace or at a federation centre.',
    publicPath: '/karate-for-corporates',
    seoTitle: 'Corporate self-defence and martial arts training — MMAKF',
    seoDescription:
      'Workplace self-defence, women’s safety and martial arts programmes for companies in India, delivered by instructors of the Modern Martial Arts Karate-Do Federation of India.',
    action: { href: '/learn/apply?audience=corporate', label: 'Request corporate training' },
    sections: [
      {
        heading: 'What companies ask MMAKF for',
        body:
          'Most corporate engagements are one of three shapes: a short self-defence course, a continuing martial arts class as part of a wellbeing programme, or a one-off workshop tied to an event or an awareness week. They are different pieces of work and are configured separately.',
        points: [
          'Self-defence — practical, short-format, no grading requirement',
          'Women’s safety — taught as its own programme, and where requested by a female instructor',
          'Continuing martial arts — a regular class, optionally on the graded syllabus',
          'Workshops and seminars — single sessions, including at offsites and annual events',
          'Online and hybrid delivery — for distributed teams',
        ],
      },
      {
        heading: 'What MMAKF does not claim',
        body:
          'The federation teaches karate and self-defence. It does not present training as a health intervention, a stress-reduction programme or a measure that will change any workplace metric. If your HR team needs outcomes evidence for a wellbeing budget, MMAKF can tell you exactly what is delivered and what attendance was — it will not supply claims it cannot support.',
      },
      {
        heading: 'Practicalities',
        body:
          'Sessions need a clear floor and space to move. A cafeteria after hours, a training room with the tables out, or a covered parking level all work. MMAKF brings what the session needs; where mats are required and you have none, that is a line on the quotation rather than an obstacle.',
      },
    ],
    needsFromYou: [
      'A room with clear floor space, or a nearby venue',
      'A named contact in HR or administration',
      'Expected participant numbers, and whether attendance is voluntary',
      'Your preferred time of day — it materially affects instructor availability',
    ],
  },

  {
    slug: 'universities',
    kind: 'university',
    navLabel: 'Universities',
    title: 'Universities and colleges',
    standfirst:
      'MMAKF works with higher education institutions on student training, sports clubs, self-defence programmes, coach and referee education, and technical collaboration.',
    publicPath: '/karate-for-universities',
    seoTitle: 'University karate programmes and sports collaboration — MMAKF',
    seoDescription:
      'Student karate training, campus self-defence, sports clubs, coach and referee education, and technical collaboration for universities and colleges in India, with MMAKF.',
    action: { href: '/learn/apply?audience=university', label: 'Partner with MMAKF' },
    sections: [
      {
        heading: 'Student training and campus sport',
        body:
          'A university engagement usually starts as either a student club or a taught programme. A club needs a qualified instructor, a regular slot and a route into competition; a taught programme needs a syllabus and assessment. MMAKF supports both, and they are configured differently.',
        points: [
          'Student karate clubs, with a route into federation competition',
          'Campus self-defence, including programmes run for women students',
          'Physical education and sports-science support',
          'Coach education, for staff and senior students',
          'Referee and judge education, for institutions running their own events',
          'Technical certification for students continuing in the graded syllabus',
        ],
      },
      {
        heading: 'Research and technical collaboration',
        body:
          'MMAKF is open to collaboration with sports science, biomechanics and performance analysis departments. What such a collaboration involves is a matter for a conversation and a written agreement — the federation makes no claim to existing research partnerships, and this page is an invitation rather than a description of ones already in place.',
      },
    ],
    needsFromYou: [
      'A department or student affairs contact who can authorise the engagement',
      'A regular space and slot, if the engagement is a continuing club',
      'Expected student numbers and whether the programme is credit-bearing',
    ],
  },

  {
    slug: 'government',
    kind: 'government',
    navLabel: 'Government',
    title: 'Government and public institutions',
    standfirst:
      'MMAKF delivers training for government departments, public bodies and institutions, through whatever review and procurement process the body requires.',
    action: { href: '/learn/apply?audience=government', label: 'Begin a public-sector enquiry' },
    sections: [
      {
        heading: 'How a public-sector engagement runs',
        body:
          'A government engagement has more steps than a school one, and they are the department’s steps rather than the federation’s: a technical review of what is proposed, an administrative or financial review, then procurement, approval and contract. MMAKF works to that process and supplies what each stage needs.',
        points: [
          'Written technical proposal, with syllabus and instructor qualifications',
          'Costed proposal under the federation’s published fee framework',
          'Documentation for procurement and empanelment',
          'Delivery reporting against the agreement',
        ],
      },
      {
        heading: 'On affiliation and recognition',
        body:
          'MMAKF states its own standing and nothing more. This page does not claim government affiliation, empanelment, recognition or approval by any department, and no page on this site does. Where a body asks MMAKF to evidence its standing, the federation will provide what it holds — and will not describe an application as an approval.',
      },
    ],
    needsFromYou: [
      'The department and the officer responsible for the engagement',
      'The procurement route the body requires',
      'The population to be trained, and where',
    ],
  },

  {
    slug: 'communities',
    kind: 'community',
    navLabel: 'Communities',
    title: 'Communities, clubs and organisations',
    standfirst:
      'MMAKF works with residents’ associations, NGOs, trusts, clubs and community groups running training for the people they serve.',
    action: { href: '/learn/apply?audience=community', label: 'Enquire for your organisation' },
    sections: [
      {
        heading: 'What community programmes usually look like',
        body:
          'Community engagements are the most varied of all: a weekly children’s class in a colony hall, a women’s self-defence course run by an NGO, a summer camp, or a demonstration at a local event. They differ in almost every respect except one — somebody local has to organise the space and the people.',
        points: [
          'Regular classes for children and adults',
          'Women’s self-defence courses',
          'Holiday camps',
          'Demonstrations and awareness events',
        ],
      },
      {
        heading: 'For organisations working with limited budgets',
        body:
          'Say so on the application. MMAKF cannot promise a concession — the fee framework decides, and the federation has published no scheme of reductions — but a programme can often be configured differently: fewer sessions, larger batches, a shorter course, or a venue nearer the instructor. That conversation is worth having before you decide it is out of reach.',
      },
    ],
    needsFromYou: [
      'A space, and someone local who will organise attendance',
      'Roughly how many people, and their ages',
      'Whether the participants include children, which affects instructor eligibility',
    ],
  },

  {
    slug: 'individuals',
    kind: 'individual',
    navLabel: 'Individuals',
    title: 'Training as an individual',
    standfirst:
      'Train at an affiliated centre, at the headquarters dojo, or online — on the graded Shotokan syllabus or in self-defence alone.',
    // WAS '/training/individual' — the page this action is rendered ON. The
    // primary call to action of the individual editorial linked to itself, so
    // the one audience with no institutional wizard behind it had no door at
    // all. It now opens the individual intake, which is the thing that records
    // an enquiry.
    action: { href: '/start/individual', label: 'Start your enquiry' },
    sections: [
      {
        heading: 'Where to train',
        body:
          'Most individuals train at an affiliated centre near them. The register of centres is published, with what each one runs. Where there is no centre nearby, the federation can advise on online instruction or on what starting one would involve.',
      },
      {
        heading: 'What it costs',
        body:
          'The federation has one fee framework, and it is applied to a configuration rather than sold as a monthly package. Tell the estimator where you are, your age, whether you are starting or continuing, and how often you want to train, and it will either return the applicable fee or say that this combination needs a quotation. It will not invent a figure.',
      },
      {
        heading: 'Grading and certification',
        body:
          'Grades are examined under the federation’s technical authority and recorded in the federation’s own register. A certificate MMAKF issues can be checked by anyone — an employer, a school, another federation — against that register.',
      },
    ],
    needsFromYou: [
      'Where you are, so the federation can point you at the nearest centre',
      'Your age, and any previous grade',
      'How often you can train',
    ],
  },
];

export function audienceBySlug(slug: string): Audience | null {
  return AUDIENCES.find((a) => a.slug === slug) ?? null;
}

export function audienceByKind(kind: string): Audience | null {
  return AUDIENCES.find((a) => a.kind === kind) ?? null;
}

/** Audiences that have a public SEO landing page on www. */
export const PUBLIC_AUDIENCE_PAGES = AUDIENCES.filter((a) => a.publicPath);
