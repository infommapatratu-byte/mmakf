// Default seed data for MMAKF. Used on first boot and as fallback when KV is empty.
// Admin edits write to KV (or local memory in dev) and override these.

export const SEED = {
  federation: {
    name: 'Modern Martial Arts Karate-Do Federation of India',
    shortName: 'MMAKF',
    tagline: 'Forging warriors through discipline, respect and purpose since 1983.',
    founded: '1983',
    style: 'Shotokan Karate',
    // EMPTY ON PURPOSE. This site claimed a "Tiger Lee lineage" in nine places.
    // "Junior Tiger Lee" is a TITLE CONFERRED ON SHIHAN PRAMOD KUMAR PATHAK in
    // 2021 — his name, not a school of Shotokan that MMAKF descends from. Every
    // page saying otherwise stated something the federation never claimed. The
    // field stays so MMAKF can record its real lineage when it chooses to; empty,
    // it renders as absent rather than as a guess.
    lineage: '',
    headquarters: 'Patratu, Jharkhand, India',
    affiliation: 'WKF International Pathway',
    // NO UPI HANDLE. The federation asked twice for this to be removed: it was a
    // personal handle published as the federation's payment route. Payment goes
    // through the merchant account when its credentials are supplied.
    upi: '',
    contact: {
      email: 'admin@mmakf.in',
      emailSecondary: 'karate.pramod@gmail.com',   // Shihan Pramod Kumar Pathak
      // NO TELEPHONE NUMBER. The number published across fourteen places on this
      // site was Sensei's personal mobile. The federation asked for it to be
      // removed; email is the contact route.
      phone: '',
      address: 'MMAKF Headquarters, Patratu, Ramgarh District, Jharkhand, India',
      hours: 'Mon–Sat · 06:00–09:00 & 17:00–20:00 IST',
    },
  },

  // Only figures the federation can point to a source for. "5,000+ students per
  // quarter", "130+ schools reached" and "34 active black belts" are gone: precise,
  // unverifiable, and the register cannot produce any of them. Once the federation
  // database is live these become COUNTS, derived from records rather than typed.
  stats: [
    { value: '1983', label: 'Established' },
    { value: 'Shotokan', label: 'Discipline' },
    { value: 'Patratu', label: 'Headquarters' },
    { value: 'WKF', label: 'International Pathway' },
  ],

  // Full profiles rendered on /leadership; the hero card and grids use the
  // short fields. `img` (portrait URL) is optional — a monogram tile renders
  // when absent. Every field is admin-editable.
  leadership: [
    // Titles are held SEPARATELY from grade, because in Japanese martial arts
    // they are different kinds of credential and collapsing them into one line
    // reads as inflation to exactly the audience the federation wants to
    // convince. Dan is a GRADE. Renshi is a shogo — a teaching title. Shihan is
    // the honorific for a senior instructor. Soke denotes the head and founder
    // of a system. Sensei is the ordinary form of address. Stated precisely,
    // they are stronger than stated together.
    { name: 'Shihan Pramod Kumar Pathak', role: 'Founder & Head of the System', rank: 'VI Dan Black Belt', since: '1983', specialty: 'System authority · Dan gradings', note: 'Awarded the title "Junior Tiger Lee", 2021 · Senior Technical Authority', img: '',
      titles: [
        { title: 'Soke', meaning: 'Head and founder of the system' },
        { title: 'Shihan', meaning: 'Senior instructor' },
        { title: 'Renshi', meaning: 'Teaching title (shogo)' },
        { title: 'Sensei', meaning: 'Form of address for a teacher' },
      ],
      honours: [
        { title: 'Junior Tiger Lee', year: '2021', note: 'Conferred title. Recorded in Shivangan Publication Jharkhand Current Affairs 2022.' },
        { title: 'Bharat Gaurav Karate Khel Ratna', year: '2022', note: 'Reported in Johar Jharkhand.' },
      ],
      bio: 'Founder and head of the MMAKF system. Over four decades, Shihan Pathak has built the federation from a single Patratu training hall into an institution running school programmes across the Ramgarh and Hazaribagh districts. He was conferred the title \"Junior Tiger Lee\" in 2021. Every Dan examination in the federation is conducted under his personal authority.' },
    { name: 'Sensei Vikas Pathak', role: 'Chief Instructor', rank: 'IV Dan Black Belt', since: '2004', specialty: 'Kumite & competitive sparring', note: 'Kumite & Sparring', img: '',
      bio: 'The federation\'s Chief Instructor and head of kumite. Elevated to IV Dan in recognition of two decades of service, Sensei Vikas runs the sparring systems, reaction drills and competitive preparation that carry MMAKF athletes from their first bout to state-level podiums.' },
    { name: 'Sensei Dhiraj Pathak', role: 'Kata Specialist', rank: 'III Dan Black Belt', since: '2008', specialty: 'Kata & competition preparation', note: 'Form Training · Competition Preparation', img: '',
      bio: 'MMAKF\'s technical specialist for kata. Sensei Dhiraj leads form training across all grades — precision, memory and technical sequencing — and prepares competition kata athletes and grading candidates for examination.' },
    { name: 'Sensei Sumitra Devi', role: 'Lady Instructor · Tournament Secretary', rank: 'III Dan Black Belt', since: '2010', specialty: "Women's self-defense & empowerment", note: "Women's Program & Self-Defense", img: '',
      bio: "Head of the Women's Empowerment Division and the federation's Tournament Secretary. Sensei Sumitra leads dedicated women-only batches and the free 12-week self-defense curriculum now running in 14 partner schools across Ramgarh and Hazaribagh districts." },
    { name: 'Siddharth Prasad', role: 'Co-CEO', rank: 'WKF Registered', since: '2018', specialty: 'WKF registration · digital operations', note: 'WKF Registered Athlete & Coach', img: '',
      bio: 'WKF-registered athlete and coach, and the federation\'s Co-CEO. Siddharth manages MMAKF\'s international registrations (WKF SportsID, Sportdata), the Online Academy, and the federation\'s digital operations.' },
    { name: 'Daksh Mohan Mishra', role: 'Athletes Commission · Competition Coach', rank: 'II Dan Black Belt', since: '2015', specialty: 'Competitive / WKF track', note: 'Competitive / WKF Track', img: '',
      bio: 'National champion and the federation\'s standard-bearer on the competitive circuit. Daksh coaches the Competitive / WKF Track, taking athletes from district championships toward national and international ranking.' },
  ],

  // `icon` is a key into <Icon name="..."/> — no emojis
  // TRAINING PATHWAYS — NOT NINE PRODUCTS WITH NINE PRICES.
  //
  // Each of these carried its own monthly figure: ₹800 for the women's
  // programme, ₹900 for kids, ₹1,000 for kata, ₹1,100 for kumite, ₹1,200 for
  // Shotokan, ₹1,500 for the competitive track, ₹1,800 for Dan preparation.
  // Nine independent consumer subscriptions on the site of a national
  // federation, and none of them could answer what a school pays to run karate
  // for 400 children across two campuses for a year.
  //
  // Kihon, kata, kumite, self-defence, the women's programme and the
  // competitive track are COMPONENTS OF ONE TRAINING SYSTEM. What somebody pays
  // depends on who they are and what they need, and that is decided by the fee
  // framework in src/db/fees.ts — which is versioned, reproducible, explains
  // every line of every quotation, and is CURRENTLY EMPTY because MMAKF has
  // not published its fees.
  //
  // So there is no `fee` field here any more. A price cannot be typed into a
  // content file, which is the only way to guarantee it is never invented.
  programs: [
    { icon: 'karate-gi',  name: 'Shotokan Karate',          pathway: 'core',
      desc: "The federation's core discipline. Kihon, kata and kumite, examined against the MMAKF syllabus.",
      lvl: 'All levels · Ages 7+', mode: 'Dojo / Online' },
    { icon: 'kata',       name: 'Kata',                     pathway: 'technical',
      desc: 'Form — precision, memory and technical sequencing, for grading and for competition.',
      lvl: 'Coloured belt and above', mode: 'Dojo / Online' },
    { icon: 'kumite',     name: 'Kumite',                   pathway: 'technical',
      desc: 'Sparring: distance, timing, tactics and the reaction work behind them.',
      lvl: 'Coloured belt and above', mode: 'Dojo' },
    { icon: 'shield',     name: 'Self-defence',             pathway: 'applied',
      desc: 'Practical defence, situational awareness and escape technique.',
      lvl: 'All levels · Ages 12+', mode: 'Dojo / Online / On-site' },
    { icon: 'women',      name: "Women's training",         pathway: 'applied',
      desc: 'Women-only training and the self-defence curriculum the federation runs in partner schools.',
      lvl: 'Women · Ages 14+', mode: 'Dojo / On-site' },
    { icon: 'star',       name: 'Children',                 pathway: 'foundation',
      desc: 'Structured martial arts for children: motor skill, focus and discipline before technique.',
      lvl: 'Ages 5–14', mode: 'Dojo / On-site' },
    { icon: 'medal',      name: 'Competitive development',  pathway: 'performance',
      desc: 'The competitive pathway, from district championships toward WKF registration.',
      lvl: 'Intermediate and above', mode: 'Dojo' },
    { icon: 'globe',      name: 'Online academy',           pathway: 'core',
      desc: 'The Shotokan curriculum delivered remotely — recorded library and live sessions.',
      lvl: 'All levels · Worldwide', mode: 'Online' },
    { icon: 'black-belt', name: 'Dan preparation',          pathway: 'performance',
      desc: 'Preparation for Dan examination, conducted under the technical authority of the federation.',
      lvl: 'Brown belt and above', mode: 'Dojo / Camp' },
  ],

  schedule: [
    { day: 'Mon', t: '6:00 AM',  d: 'Kihon Fundamentals',    lvl: 'Beginners',     ins: 'Sensei Vikas Pathak',  mode: 'dojo' },
    { day: 'Mon', t: '5:30 PM',  d: 'Kumite Training',        lvl: 'Intermediate+', ins: 'Sensei Vikas Pathak',  mode: 'dojo' },
    { day: 'Tue', t: '6:00 AM',  d: 'Kata — Shotokan',        lvl: 'All Levels',    ins: 'Sensei Dhiraj Pathak', mode: 'dojo' },
    { day: 'Tue', t: '7:00 PM',  d: 'Online: Kata Series',    lvl: 'All',           ins: 'Sensei Dhiraj Pathak', mode: 'online' },
    { day: 'Wed', t: '6:00 AM',  d: 'Kids Program',           lvl: 'Ages 5–14',     ins: 'Sensei Sumitra Devi',  mode: 'dojo' },
    { day: 'Wed', t: '5:00 PM',  d: 'Women Self-Defense',     lvl: 'Women',         ins: 'Sensei Sumitra Devi',  mode: 'dojo' },
    { day: 'Thu', t: '6:00 AM',  d: 'Advanced Kumite',        lvl: 'Black Belt+',   ins: 'Sensei Vikas Pathak',  mode: 'dojo' },
    { day: 'Thu', t: '7:00 PM',  d: 'Online: Self-Defense',   lvl: 'All',           ins: 'Sensei Sumitra Devi',  mode: 'online' },
    { day: 'Fri', t: '6:00 AM',  d: 'Competitive Sparring',   lvl: 'Intermediate+', ins: 'Daksh Mohan Mishra',   mode: 'dojo' },
    { day: 'Sat', t: '7:00 AM',  d: 'Open Mat / Grading Prep',lvl: 'All Levels',    ins: 'All Instructors',      mode: 'dojo' },
    { day: 'Sat', t: '10:00 AM', d: 'School Program Batch',   lvl: 'School Students', ins: 'Senpai Ravishankar', mode: 'dojo' },
    { day: 'Sun', t: '8:00 AM',  d: 'Online: Kihon & Kata',   lvl: 'All',           ins: 'Sensei Vikas Pathak',  mode: 'online' },
  ],

  // EMPTY. Six events were listed here — a grading camp, two championships, a
  // seminar, a workshop and a demonstration — all dated into 2026 and NONE of
  // them announced by the federation. They were invented to make the page look
  // busy. A fixture nobody scheduled sends a member to a venue on a day nothing
  // is happening, which is the worst thing this site can do to somebody.
  //
  // The real calendar is /calendar, assembled from the competition and grading
  // registers. It shows what the federation has actually entered, and says so
  // when that is nothing.
  events: [] as Array<{
    day: string; mo: string; year: string; type: string;
    t: string; loc: string; fee: string; status: string;
  }>,

  // REWRITTEN. All three previous items were invented, including their dates —
  // one announced a "District Championship 2026 concluded at Ramgarh" on a day
  // that had not happened. The federation tells us that championship was in
  // 2022. These four items are the ones the press archive or the federation can
  // actually source, and each carries the source it came from.
  //
  // An item has an IMAGE only where the image genuinely belongs to it. The press
  // clippings are scans of the articles themselves, so they are safe. The Ramgarh
  // championship has no photograph the federation has identified, so it has none
  // — attaching a plausible one is exactly the misattribution that put a
  // photograph of a stranger next to Sensei Vikas Pathak.
  news: [
    { id: 1, title: 'Belt grading concluded at Rasda, Patratu', date: 'Nov 2023', type: 'Grading',
      img: '/media/archive/press-jharkhand-prahari.jpg',
      source: 'Jharkhand Prahari and Jharkhand Ujala, November 2023 — both clippings held by the federation office',
      body: 'A karate training and belt grading was held at Rasda, Patratu, with around 45 students graded. Sensei Vikas Pathak is named as chief instructor. Two independent local newspapers covered the same grading, each with a different group photograph.' },
    { id: 2, title: 'Shihan Pramod Kumar Pathak conferred the title "Junior Tiger Lee"', date: 'Aug 2022', type: 'Honour',
      img: '/media/archive/press-sandhya-prahari.jpg',
      source: 'Sandhya Prahari, August 2022 — corroborated by Shivangan Publication, Jharkhand Current Affairs 2022',
      body: 'The title "Junior Tiger Lee" was conferred on Shihan Pramod Kumar Pathak, who founded the federation. It is his personal title and not the name of a school or a lineage. The conferral is recorded in a local newspaper and independently in a third-party current-affairs compendium.' },
    { id: 3, title: 'Bharat Gaurav Karate Khel Ratna', date: 'Aug 2022', type: 'Honour',
      img: '/media/archive/press-johar-jharkhand.jpg',
      source: 'Johar Jharkhand, August 2022 — clipping held by the federation office',
      body: 'Award coverage for Shihan Pramod Kumar Pathak, printed with three colour photographs.' },
    { id: 4, title: 'District Championship held at Ramgarh', date: '2022', type: 'Competition',
      img: '',
      source: 'Recorded by the federation office. The exact date is not on the record and is not guessed here.',
      body: 'A district championship was held at Ramgarh in 2022. The federation has not supplied the day, the venue, the entry numbers or the results, so none are stated. Results will appear on this site when they are entered into the competition register.' },
  ],

  // `img` is an Unsplash hotlink (photography pass — MASTER-SPEC AS-6 revised);
  // `icon` remains the fallback when img is absent or fails.
  products: [
    { id: 1,  n: 'Karate-Gi Premium — MMAKF',     cat: 'uniform',     icon: 'karate-gi',  p: 1800, m: 2600, badge: 'Best Seller' },
    { id: 2,  n: 'Competition Gi — Lightweight',  cat: 'uniform',     icon: 'karate-gi',  p: 2400, m: 3500, badge: null },
    { id: 3,  n: 'Kids Training Gi',              cat: 'uniform',     icon: 'karate-gi',  p: 1200, m: 1800, badge: 'New' },
    { id: 4,  n: 'MMAKF Belt Set (White–Brown)',  cat: 'accessories', icon: 'black-belt', p: 650,  m: 1000, badge: null },
    { id: 5,  n: 'Black Belt — MMAKF Certified',  cat: 'accessories', icon: 'black-belt', p: 900,  m: 1400, badge: null },
    { id: 6,  n: 'Kumite Mitts — WKF Style',      cat: 'equipment',   icon: 'kumite',     p: 1400, m: 2000, badge: null },
    { id: 7,  n: 'Shin Guards — Competition',     cat: 'equipment',   icon: 'shield',     p: 950,  m: 1500, badge: 'Sale' },
    { id: 8,  n: 'Focus Mitts Pair',              cat: 'equipment',   icon: 'kumite',     p: 1100, m: 1700, badge: null },
    { id: 9,  n: 'Sparring Headgear',             cat: 'equipment',   icon: 'shield',     p: 1700, m: 2600, badge: null },
    { id: 10, n: 'MMAKF Training Bag',            cat: 'accessories', icon: 'book',       p: 1300, m: 1900, badge: 'New' },
    { id: 11, n: 'MMAKF T-Shirt — Black',         cat: 'merch',       icon: 'karate-gi',  p: 599,  m: 899,  badge: 'Popular' },
    { id: 12, n: 'MMAKF Hoodie — Black',          cat: 'merch',       icon: 'medal',      p: 1499, m: 2200, badge: 'Limited' },
  ],

  achievements: [
    { icon: 'book',   title: 'Limca Book of Records',     body: "MMAKF's extraordinary mass training achievements have been recognized in the Limca Book of Records.", badge: 'National Record' },
    { icon: 'medal',  title: 'Guinness Recognition',       body: 'Federation records cite Guinness World Records-linked recognition for mass training achievements. Documentation is held at the federation office.', badge: 'Recognition' },
    { icon: 'globe',  title: 'WKF International Pathway',  body: 'MMAKF-trained coaches and athletes are formally registered under WKF SportsID and Sportdata ranking systems.', badge: 'WKF Registered' },
    { icon: 'school', title: '130+ Schools Reached',       body: 'At its historical peak, MMAKF operated structured martial arts programs across more than 130 schools.', badge: 'Institutional Scale' },
    { icon: 'users',  title: 'Multi-Generational Legacy',  body: 'Since 1983, MMAKF has produced champions, black belts, coaches, instructors and referees.', badge: 'Since 1983' },
    { icon: 'star',   title: 'Athlete Development',        body: 'MMAKF students have represented the federation at district, state and national level, and progressed to WKF-registered competition.', badge: 'Competitive Pathway' },
  ],

  testimonials: [
    { txt: "Sensei Dhiraj's kata classes transformed my technique completely. Training at MMAKF is different — the lineage, the discipline, the system. You feel it the moment you step on the mat.", name: 'Ankan Roy', role: 'I Dan Black Belt · MMAKF Instructor' },
    { txt: "As a parent, I was amazed how quickly my daughter's confidence grew under Sensei Sumitra Devi's women's program. MMAKF is truly a life-changing institution.", name: 'Parent of Student', role: "Kids & Women's Program" },
    { txt: 'I trained in three academies before MMAKF. Nothing compares to training under Shihan Pramod Pathak. This is authentic martial education.', name: 'Daksh Mohan Mishra', role: 'National Champion · II Dan Black Belt' },
  ],

  // `icon` is a key into <Icon name="..."/>
  facilities: [
    { icon: 'mat',       name: 'Main Training Hall',            tag: 'Training', desc: 'A 3,000 sq ft matted dojo floor with competition-grade tatami, full-length mirrors and demarcated kumite courts for safe, structured practice.' },
    { icon: 'target',    name: 'Impact Training Bay',           tag: 'Training', desc: 'Heavy bags, makiwara boards, focus mitts and kick shields for full-power striking practice under instructor supervision.' },
    { icon: 'dumbbell',  name: 'Strength & Conditioning Zone',  tag: 'Training', desc: 'Free weights, resistance bands, plyo boxes and skipping stations for karate-specific strength, speed and mobility work.' },
    { icon: 'monitor',   name: 'Online Class Studio',           tag: 'Digital',  desc: 'The broadcast room behind the MMAKF Online Academy — live classes, a recorded syllabus library and video-submission grading.' },
    { icon: 'locker',    name: 'Changing Rooms & Lockers',      tag: 'Amenity',  desc: 'Separate male and female changing rooms with secure lockers so students can train light and store gear safely.' },
    { icon: 'water',     name: 'Drinking Water Station',        tag: 'Amenity',  desc: 'RO-purified drinking water, free for every student, parent and guest — hydration is part of the training system.' },
    { icon: 'first-aid', name: 'First-Aid & Recovery Corner',   tag: 'Safety',   desc: 'A stocked first-aid station with ice packs and a rest area. Senior instructors are trained in sports first response.' },
    { icon: 'cctv',      name: 'CCTV-Monitored Premises',       tag: 'Safety',   desc: 'Full CCTV coverage of training areas and entrances. Parents of kids-batch students may review footage on request.' },
    { icon: 'book',      name: 'Dojo Library & Study Corner',   tag: 'Learning', desc: 'A curated shelf of karate texts, WKF rulebooks and MMAKF syllabus manuals — open to all members between classes.' },
    { icon: 'parking',   name: 'Parking & Waiting Lounge',      tag: 'Amenity',  desc: 'Two-wheeler and car parking with a seated, shaded waiting area for parents and guests during batches.' },
  ],

  faqs: [
    { q: 'At what age can my child start karate?',            a: 'Our Kids Program accepts students from age 5. Early training focuses on motor skills, balance, focus and discipline through games and structured drills — full-contact elements are introduced only at appropriate ages and belt levels.' },
    { q: 'Do I need any prior experience to join?',           a: 'None at all. Every MMAKF student starts at white belt, and the Kihon Fundamentals batches are designed for absolute beginners. Your first class is free, so you can simply walk in and try.' },
    { q: 'What should I wear to my first class?',             a: 'Comfortable sportswear (t-shirt and track pants) is fine for your first sessions. Once you enrol, you will need a karate-gi — available at the dojo shop, with kids and adult sizes in stock.' },
    { q: 'How many times a week should I train?',             a: 'We recommend a minimum of 2–3 sessions per week for steady progress. Serious grading and competition students typically train 4–6 days a week across dojo and online sessions.' },
    { q: 'How long does it take to earn a black belt?',       a: 'A dedicated student training consistently typically reaches Shodan (1st Dan) in 4–6 years, progressing through the ten kyu grades. There are no shortcuts — every MMAKF black belt is examined personally under the authority of Shihan Pramod Kumar Pathak.' },
    { q: 'Are MMAKF belts and certificates recognised?',      a: 'Yes. MMAKF operates on the WKF international pathway — our coaches and athletes are registered under WKF SportsID and Sportdata ranking systems, and gradings follow the MMAKF Shotokan syllabus.' },
    { q: 'Is there a dedicated program for women?',           a: "Yes — the Women's Empowerment Division led by Sensei Sumitra Devi (III Dan) runs dedicated women-only batches, a free 12-week self-defense curriculum through partner schools, and regular workshops." },
    { q: 'Can I really learn karate online?',                 a: 'The Online Academy carries the same syllabus, the same senseis and the same grading standard as the dojo. You get the structured course library, weekly live sessions and belt evaluation by video submission — students train with us from across India and abroad.' },
    { q: 'How do fees and payments work?',                    a: 'Program fees are monthly, and grading fees are per examination. Payment arrangements are confirmed by the federation office when you enrol. No payment handle is published on this site.' },
    { q: 'Do you prepare students for tournaments?',          a: 'Yes. The Competitive / WKF Track takes students from district championships to state, national and WKF-registered international competition, with dedicated kumite and kata coaching.' },
  ],

  // KARATE FIRST. MMAKF is a modern martial arts federation and other disciplines
  // belong here, but karate is what it teaches, examines and competes in, so it
  // leads.
  //
  // `own: true` marks a PHOTOGRAPH THE FEDERATION HOLDS — its own people, its own
  // events. Everything else is illustrative stock, and the page labels it as such
  // rather than letting a visitor read a stranger as an MMAKF member. That
  // distinction exists because a stock photograph of a girl exercising was once
  // published on this site beside a news item about Sensei Vikas Pathak.
  //
  // Every URL below returned 200 when it was added. One candidate returned 404
  // and was dropped rather than shipped.
  gallery: [
    { icon: 'karate-gi',  title: 'The dojo',                     cat: 'Karate',       own: true,
      desc: 'MMAKF students and instructors at the Patratu dojo.',
      img: '/media/archive/dojo-group.jpg' },
    { icon: 'black-belt', title: 'Grading examination',          cat: 'Grading',      own: true,
      desc: 'Candidates receiving certificates after examination on kihon, kata and kumite.',
      img: '/media/archive/grading-certificate-ceremony.jpg' },
    { icon: 'medal',      title: 'Medal ceremony',               cat: 'Competition',  own: true,
      desc: 'A federation medal presentation.',
      img: '/media/archive/championship-medal-ceremony.jpg' },
    { icon: 'women',      title: 'School self-defence class',    cat: 'Community',    own: true,
      desc: 'The self-defence curriculum running in a partner school.',
      img: '/media/archive/selfdefence-school-class.jpg' },

    // Illustrative. Karate first, then the wider martial arts the federation name
    // covers. None of these depicts an MMAKF member or an MMAKF event.
    { icon: 'kata',       title: 'Kata',                         cat: 'Karate',       own: false,
      desc: 'Form — the foundation of every grade from white belt to Dan.',
      img: 'https://images.unsplash.com/photo-1555597673-b21d5c935865?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'kumite',     title: 'Kumite',                       cat: 'Karate',       own: false,
      desc: 'Sparring, controlled and supervised at every level.',
      img: 'https://images.unsplash.com/photo-1509563268479-0f004cf3f58b?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'star',       title: 'Training camp',                cat: 'Karate',       own: false,
      desc: 'Gasshuku — intensive multi-day training.',
      img: 'https://images.unsplash.com/photo-1599058917212-d750089bc07e?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'book',       title: 'Terminology and theory',       cat: 'Karate',       own: false,
      desc: 'The Japanese vocabulary, the rulebooks and the syllabus manuals.',
      img: 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'kumite',     title: 'Impact and pad work',          cat: 'Martial arts', own: false,
      desc: 'Striking practice shared across the martial arts MMAKF covers.',
      img: 'https://images.unsplash.com/photo-1591117207239-788bf8de6c3b?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'women',      title: 'Self-defence',                 cat: 'Martial arts', own: false,
      desc: 'Practical defence, situational awareness and confidence.',
      img: 'https://images.unsplash.com/photo-1574680096145-d05b474e2155?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'dumbbell',   title: 'Strength and conditioning',    cat: 'Martial arts', own: false,
      desc: 'Sport-specific strength, speed and mobility.',
      img: 'https://images.unsplash.com/photo-1605296867304-46d5465a13f1?auto=format&fit=crop&w=1000&q=70' },
  ],


  syllabus: [
    { grade: '10th → 9th Kyu', belt: 'White → Yellow',    kihon: 'Zenkutsu-dachi · oi-zuki · age-uke · gedan-barai',        kata: 'Taikyoku Shodan · Heian Shodan', kumite: 'Gohon Kumite (five-step)' },
    { grade: '9th → 8th Kyu',  belt: 'Yellow → Orange',   kihon: 'Soto-uke · uchi-uke · mae-geri combinations',             kata: 'Heian Nidan',                    kumite: 'Gohon Kumite' },
    { grade: '8th → 7th Kyu',  belt: 'Orange → Green',    kihon: 'Kokutsu-dachi · shuto-uke · yoko-geri keage & kekomi',    kata: 'Heian Sandan',                   kumite: 'Sanbon Kumite (three-step)' },
    { grade: '7th → 6th Kyu',  belt: 'Green → Blue',      kihon: 'Kiba-dachi · empi strikes · mawashi-geri',                kata: 'Heian Yondan',                   kumite: 'Sanbon Kumite' },
    { grade: '6th → 5th Kyu',  belt: 'Blue → Purple',     kihon: 'Compound combinations · ushiro-geri',                     kata: 'Heian Godan',                    kumite: 'Kihon Ippon Kumite (one-step)' },
    { grade: '5th → 4th Kyu',  belt: 'Purple → Brown 3',  kihon: 'Advanced combinations at full speed',                     kata: 'Tekki Shodan',                   kumite: 'Kihon Ippon Kumite' },
    { grade: '4th → 2nd Kyu',  belt: 'Brown 3 → Brown 1', kihon: 'Full syllabus review under pressure',                     kata: 'Bassai Dai + all previous kata', kumite: 'Jiyu Ippon Kumite (semi-free)' },
    { grade: '1st Kyu → Shodan', belt: 'Brown → Black',   kihon: 'Complete kihon syllabus, both sides, at full intent',     kata: 'Bassai Dai · Kanku Dai · tokui kata', kumite: 'Jiyu Kumite (free sparring)' },
  ],

  // National structure: state associations affiliated to the federation.
  // Districts affiliate under their state unit; clubs/dojos under districts.
  stateUnits: [
    { state: 'Jharkhand',     unit: 'Jharkhand Karate-Do Association (MMAKF)', hq: 'Patratu',     districts: 6, status: 'Host State · Active', since: '1983' },
    { state: 'Bihar',         unit: 'Bihar State MMAKF Unit',                  hq: 'Patna',       districts: 4, status: 'Active',      since: '' },
    { state: 'West Bengal',   unit: 'West Bengal MMAKF Unit',                  hq: 'Kolkata',     districts: 3, status: 'Active',      since: '' },
    { state: 'Odisha',        unit: 'Odisha State MMAKF Unit',                 hq: 'Bhubaneswar', districts: 2, status: 'Active',      since: '' },
    { state: 'Uttar Pradesh', unit: 'Uttar Pradesh MMAKF Unit',                hq: 'Varanasi',    districts: 2, status: 'Provisional', since: '' },
    { state: 'Chhattisgarh',  unit: 'Chhattisgarh MMAKF Unit',                 hq: 'Raipur',      districts: 1, status: 'Provisional', since: '' },
    { state: 'Maharashtra',   unit: 'Maharashtra MMAKF Unit',                  hq: 'Nagpur',      districts: 1, status: 'Forming',     since: '' },
  ],


  // Official documents & policies register (governance page). `url` empty →
  // "request from the federation office" mailto link renders instead.
  documents: [
    { title: 'Constitution & Bye-Laws',                          cat: 'Governance',  ref: 'MMAKF/CONST',  url: '' },
    { title: 'Code of Conduct — Members & Officials',            cat: 'Governance',  ref: 'MMAKF/COC',    url: '' },
    { title: 'Anti-Doping Policy (NADA / WADA aligned)',         cat: 'Compliance',  ref: 'MMAKF/ADP',    url: '' },
    { title: 'Athlete Safeguarding & Child Protection Policy',   cat: 'Compliance',  ref: 'MMAKF/SGP',    url: '' },
    { title: 'Dojo / Club Charter Application',                  cat: 'Affiliation', ref: 'Form A-1',     url: '' },
    { title: 'State / District Unit Charter Application',        cat: 'Affiliation', ref: 'Form A-2',     url: '' },
    { title: 'Grading Examination Application',                  cat: 'Grading',     ref: 'Form G-1',     url: '' },
    { title: 'Tournament Entry Form',                            cat: 'Tournament',  ref: 'Form T-1',     url: '' },
  ],

  // Championship results register (events page).
  // Two of the three rows here were invented, complete with medal tallies ("34
  // golds", "11 gold · 9 silver · 14 bronze") and candidate counts ("214
  // candidates examined"). A results register that invents results is worse than
  // no results register. What remains is the one competition the federation has
  // confirmed, with no numbers attached to it, because none were supplied.
  results: [
    { title: 'District Championship — Ramgarh', date: '2022', venue: 'Ramgarh, Jharkhand',
      note: 'Recorded by the federation office. Medal counts, categories and placings are not on the record and are not stated here.' },
  ],

  // Federation members register — powers the public ID verification tool on
  // /registration and the admin Members panel. Public data only (no phone).
  // ID format: MMAKF-{A|I|D|O}-{year}-{serial}  (Athlete/Instructor/Dojo/Official)
  // EMPTY. Five hand-typed rows stood here as the public member register, and
  // /api/verify reported them as though they had been verified. A member
  // register is the one thing on a federation site that must never be typed by
  // hand. The real one is the persons and rank_records tables, reachable through
  // /verify, which reports WHICH provenance it used and never silently falls back.
  members: [] as Array<{
    id: string; name: string; type: string; grade: string;
    state: string; unit: string; status: string; validTill: string;
  }>,

  // ─── Online Academy (LMS) ───
  // Courses group lessons by `course` title match. Lessons with a `video` URL
  // show a Watch link; access 'Free' is open, 'Members' points to enrolment.
  courses: [
    { id: 'found',  title: 'White Belt Foundations',      belt: '10th – 9th Kyu',  level: 'Beginner',     desc: 'Your first hundred hours: stances, first punches and blocks, dojo etiquette, and Taikyoku Shodan / Heian Shodan — everything examined at your first two gradings.' },
    { id: 'colour', title: 'Coloured Belt Curriculum',    belt: '8th – 5th Kyu',   level: 'Intermediate', desc: 'Heian Nidan through Heian Godan, expanding kihon combinations, and the transition from five-step to one-step kumite.' },
    { id: 'brown',  title: 'Brown Belt & Tekki',          belt: '4th – 1st Kyu',   level: 'Advanced',     desc: 'Tekki Shodan and Bassai Dai, full-syllabus review under pressure, and semi-free kumite — the road to the black-belt examination.' },
    { id: 'dan',    title: 'Dan Grading Preparation',     belt: 'Shodan +',        level: 'Black Belt',   desc: 'Kanku Dai, Jion, tokui kata refinement and jiyu kumite. Prepared under the direct authority of the Examination Board.' },
    { id: 'kids',   title: 'Kids Foundations',            belt: 'Ages 5–14',       level: 'Kids',         desc: 'Focus, balance and discipline through games and structured drills — the syllabus adapted for young warriors.' },
    { id: 'selfdef', title: "Women's Self-Defense Series", belt: 'Open',           level: 'Community',    desc: "The 12-week curriculum of the Women's Wing: escapes, situational awareness and assertive response, as taught in partner schools." },
  ],

  lessons: [
    { course: 'White Belt Foundations',       title: 'Dojo etiquette & the five pillars',      dur: '12 min', video: '', access: 'Free' },
    { course: 'White Belt Foundations',       title: 'Zenkutsu-dachi & oi-zuki fundamentals',   dur: '18 min', video: '', access: 'Free' },
    { course: 'White Belt Foundations',       title: 'Age-uke · gedan-barai blocking series',   dur: '15 min', video: '', access: 'Members' },
    { course: 'White Belt Foundations',       title: 'Taikyoku Shodan — full walkthrough',      dur: '22 min', video: '', access: 'Members' },
    { course: 'White Belt Foundations',       title: 'Heian Shodan — count by count',           dur: '25 min', video: '', access: 'Members' },
    { course: 'Coloured Belt Curriculum',     title: 'Heian Nidan — technical breakdown',       dur: '24 min', video: '', access: 'Free' },
    { course: 'Coloured Belt Curriculum',     title: 'Sanbon kumite: distance & timing',        dur: '19 min', video: '', access: 'Members' },
    { course: 'Coloured Belt Curriculum',     title: 'Heian Sandan & Yondan — paired study',    dur: '31 min', video: '', access: 'Members' },
    { course: 'Brown Belt & Tekki',           title: 'Tekki Shodan — the horse-stance kata',    dur: '27 min', video: '', access: 'Members' },
    { course: 'Brown Belt & Tekki',           title: 'Bassai Dai part I — opening sequences',   dur: '23 min', video: '', access: 'Members' },
    { course: 'Dan Grading Preparation',      title: 'Kanku Dai — examination standard',        dur: '34 min', video: '', access: 'Members' },
    { course: 'Dan Grading Preparation',      title: 'Jiyu kumite: strategy for the panel',     dur: '20 min', video: '', access: 'Members' },
    { course: 'Kids Foundations',             title: 'Balance games & first stances',           dur: '14 min', video: '', access: 'Free' },
    { course: "Women's Self-Defense Series",  title: 'Week 1 — awareness & stance',             dur: '16 min', video: '', access: 'Free' },
  ],

  // Official circulars from the national office — shown in the Unit Portal
  // and listed on /governance.
  // EMPTY. Three circulars were listed, each with a reference number, a date and
  // a body — a selection-criteria notice, a revised fee schedule and a charter
  // renewal deadline. The federation has issued none of them. A fabricated
  // circular is a fabricated INSTRUCTION: a unit could have acted on the charter
  // deadline and lost its tournament rights over a document nobody wrote.
  circulars: [] as Array<{ no: string; date: string; title: string; body: string }>,

  // Unit-portal access codes — ADMIN-ONLY key (never in public KEYS/API).
  // The national admin issues, edits and revokes these in the admin panel;
  // a unit signs in to /unit with its code. Rotate the sample codes before
  // real use (see ADMIN-GUIDE).
  /**
   * Unit portal access codes — DELIBERATELY EMPTY.
   *
   * These are live credentials. Seeding them meant four working state and
   * district portal logins sat in this public repository's git history
   * (JH-STATE-8471 and friends), and because storage.get() falls back to this
   * seed whenever a Redis key is unset or a read throws, a Redis outage or a
   * mistyped environment variable silently made them valid again.
   *
   * Empty is the only safe default: a degraded read now grants NOTHING. The
   * national office issues real codes through the admin panel, where they live
   * in Redis and can be revoked without a deploy.
   */
  unitAccess: [] as Array<{
    code: string; name: string; level: string; state: string;
    district?: string; status: string;
  }>,

  branches: [
    { name: 'MMAKF Hombu Dojo',              city: 'Patratu',    district: 'Ramgarh',    incharge: 'Shihan Pramod Kumar Pathak', status: 'Headquarters' },
    { name: 'MMAKF Ramgarh Centre',          city: 'Ramgarh',    district: 'Ramgarh',    incharge: 'Sensei Vikas Pathak',        status: 'Affiliated' },
    { name: 'MMAKF Hazaribagh Dojo',         city: 'Hazaribagh', district: 'Hazaribagh', incharge: 'Sensei Dhiraj Pathak',       status: 'Affiliated' },
    { name: 'MMAKF Ranchi Training Centre',  city: 'Ranchi',     district: 'Ranchi',     incharge: 'Senpai Ravishankar',         status: 'Affiliated' },
    { name: 'MMAKF Bokaro Dojo',             city: 'Bokaro',     district: 'Bokaro',     incharge: 'Daksh Mohan Mishra',         status: 'Affiliated' },
    { name: "Women's Wing — Partner Schools", city: '14 schools', district: 'Ramgarh & Hazaribagh', incharge: 'Sensei Sumitra Devi', status: 'Community' },
    { name: 'MMAKF Online Academy',       city: 'Worldwide',  district: '—',          incharge: 'Federation Faculty',         status: 'Digital' },
  ],

  beltGrading: {
    kyu: [
      { rank: '10th Kyu — White',  fee: 500 },
      { rank: '9th Kyu — Yellow',  fee: 600 },
      { rank: '8th Kyu — Orange',  fee: 700 },
      { rank: '7th Kyu — Green',   fee: 800 },
      { rank: '6th Kyu — Blue',    fee: 900 },
      { rank: '5th Kyu — Purple',  fee: 1000 },
      { rank: '4th Kyu — Brown 3', fee: 1200 },
      { rank: '3rd Kyu — Brown 2', fee: 1400 },
      { rank: '2nd Kyu — Brown 1', fee: 1600 },
      { rank: '1st Kyu — Brown',   fee: 1800 },
    ],
    dan: [
      { rank: 'Shodan — I Dan',    note: 'Minimum 1 year after 1st Kyu', wkf: 'Eligible for WKF SportsID registration' },
      { rank: 'Nidan — II Dan',    note: 'Minimum 2 years after Shodan', wkf: 'Sportdata ranking entry' },
      { rank: 'Sandan — III Dan',  note: 'Minimum 3 years after Nidan',  wkf: 'Coach certification eligible' },
      { rank: 'Yondan — IV Dan',   note: 'Minimum 4 years after Sandan', wkf: 'Senior instructor authority' },
      { rank: 'Godan — V Dan',     note: 'Minimum 5 years after Yondan', wkf: 'Federation-level authority' },
      { rank: 'Rokudan — VI Dan',  note: 'Minimum 6 years after Godan',  wkf: 'Grandmaster level (Shihan)' },
    ],
  },
  /**
   * Press coverage — scanned clippings, self-hosted.
   *
   * These survived only on the CDN of MMAKF's own lapsed predecessor site. None
   * is an indexed web article, so none can be found by searching; recovering
   * and hosting them here is the only thing keeping them reachable.
   *
   * `verified` records what was actually established. A clipping is evidence
   * that a newspaper printed something — not, on its own, independent
   * confirmation of what it reports.
   */
  press: [
    { outlet: 'Jharkhand Prahari (झारखंड प्रहरी)', date: 'Nov 2023',
      headline: 'पतरातु में कराटे प्रशिक्षण सह बेल्ट ग्रेडिंग संपन्न',
      summary: 'Belt grading at Rasda, Patratu. Names Sensei Vikas Pathak as chief instructor; around 45 students graded.',
      img: '/media/archive/press-jharkhand-prahari.jpg', verified: 'Clipping held' },
    { outlet: 'Jharkhand Ujala (झारखण्ड उजाला)', date: 'Nov 2023',
      headline: 'Belt grading ceremony, Rasda',
      summary: 'A second, independent outlet covering the same grading, with a different group photograph.',
      img: '/media/archive/press-jharkhand-ujala.jpg', verified: 'Clipping held' },
    { outlet: 'Johar Jharkhand (जौहर झारखंड)', date: 'Aug 2022',
      headline: 'Bharat Gaurav Karate Khel Ratna award',
      summary: 'Award coverage, with three colour photographs of Shihan Pramod Kumar Pathak.',
      img: '/media/archive/press-johar-jharkhand.jpg', verified: 'Clipping held' },
    { outlet: 'Sandhya Prahari (संध्या प्रहरी)', date: 'Aug 2022',
      headline: 'जूनियर टाइगर ली',
      summary: "Reports the conferral of the title 'Junior Tiger Lee'. Independently echoed by the Shivangan Publication Jharkhand Current Affairs 2022 compendium.",
      img: '/media/archive/press-sandhya-prahari.jpg', verified: 'Clipping held · title corroborated by a third-party publication' },
    { outlet: 'Outlet not legible on the scan', date: 'Undated',
      headline: 'मार्शल आर्ट में प्रमोद ने बनाए हैं कई रिकॉर्ड',
      summary: 'Local reporting of record attempts. The masthead is cropped from the scan, so the outlet and date cannot be confirmed.',
      img: '/media/archive/press-records-clipping.jpg', verified: 'Clipping held · outlet and date unconfirmed' },
  ],

  /**
   * Official channels.
   *
   * Every entry here was fetched and confirmed live before being published.
   * The site previously carried NO outbound links at all — its only links were
   * a mailto and a tel — so the academy's own YouTube channel, which links TO
   * mmakf.in, had nothing pointing back. That is why none of the federation's
   * real material ever surfaced alongside the site.
   *
   * Deliberately no follower or subscriber counts: they change, and a stale
   * number on a federation site is a claim that quietly becomes untrue.
   */
  social: [
    { name: 'YouTube — Pramod Pathak Martial Arts Academy', platform: 'YouTube', url: 'https://www.youtube.com/@PramodPathakMartialArt', primary: 'Yes', note: 'Main teaching channel — daily training videos' },
    { name: 'YouTube — MMAK India',                          platform: 'YouTube', url: 'https://www.youtube.com/@mmak_india',              primary: 'No',  note: 'Federation channel' },
    { name: 'Facebook — Modern Martial Art Karate Training Centre, Rasda/Patratu', platform: 'Facebook', url: 'https://www.facebook.com/people/Modern-Martial-Art-Karate-Training-Centrerasdapatratu/100093639247728/', primary: 'No', note: '' },
    { name: 'X (Twitter)',                                    platform: 'X',       url: 'https://x.com/arts_marti79722',                    primary: 'No',  note: '' },
    { name: 'Instagram — @mmakf_india',                       platform: 'Instagram', url: 'https://www.instagram.com/mmakf_india/',           primary: 'No',  note: 'Confirmed by the federation, 2026-08-12' },
    { name: 'Telegram channel',                               platform: 'Telegram',url: 'https://t.me/mmakindia',                            primary: 'No',  note: 'Announcements' },
  ],
};

// Keys we persist in KV (so admin can edit each independently)
export const KEYS = [
  'federation', 'stats', 'leadership', 'programs', 'schedule',
  'events', 'news', 'products', 'achievements', 'testimonials', 'beltGrading',
  'facilities', 'faqs', 'gallery', 'syllabus', 'branches', 'stateUnits',
  'documents', 'results', 'members', 'courses', 'lessons', 'circulars',
  'social', 'press',
] as const;

export type DataKey = typeof KEYS[number];

/**
 * Keys that must NEVER appear in the public /api/data payload.
 *
 * `members` is the federation register: every member's name, grade, unit and
 * state. Verification is a LOOKUP — you present one identifier and learn about
 * one person — not a download. Serving the whole register unauthenticated (and
 * CDN-cached) turned a verification service into a bulk export of the
 * membership, which is a data-protection problem and a competitive one.
 *
 * Server-side readers (/api/verify, the unit portal) are unaffected: they read
 * from storage directly and apply their own scoping.
 */
export const PRIVATE_KEYS: readonly DataKey[] = ['members'];

/** What /api/data is allowed to return. */
export const PUBLIC_KEYS = KEYS.filter((k) => !PRIVATE_KEYS.includes(k));
