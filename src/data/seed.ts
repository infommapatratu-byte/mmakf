// Default seed data for MMAKF. Used on first boot and as fallback when KV is empty.
// Admin edits write to KV (or local memory in dev) and override these.

export const SEED = {
  federation: {
    name: 'Modern Martial Arts Karate-Do Federation of India',
    shortName: 'MMAKF',
    tagline: 'Forging warriors through discipline, lineage, and purpose since 1983.',
    founded: '1983',
    style: 'Shotokan Karate',
    lineage: 'Tiger Lee Lineage',
    headquarters: 'Patratu, Jharkhand, India',
    affiliation: 'WKF International Pathway',
    upi: '9939144318@ybl',
    contact: {
      email: 'admin@mmakf.in',
      emailSecondary: 'karate.pramod@gmail.com',
      phone: '+91 99391 44318',
      address: 'MMAKF Headquarters, Patratu, Ramgarh District, Jharkhand, India',
      hours: 'Mon–Sat · 06:00–09:00 & 17:00–20:00 IST',
    },
  },

  stats: [
    { value: '1983', label: 'Established' },
    { value: '5,000+', label: 'Students / Quarter' },
    { value: '130+', label: 'Schools Reached' },
    { value: '34', label: 'Active Black Belts' },
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
  programs: [
    { icon: 'karate-gi',  name: 'Shotokan Karate',         desc: "The authentic Karate-Do discipline — MMAKF's core art. Train in Kihon, Kata, and Kumite under the Tiger Lee Shotokan lineage.", lvl: 'All Levels · Ages 7+', fee: 1200, mode: 'Dojo / Online' },
    { icon: 'kata',       name: 'Kata Specialization',     desc: 'Advanced form training under Sensei Dhiraj Pathak. Precision, memory and technical sequencing for competition and grading.', lvl: 'Coloured Belt+', fee: 1000, mode: 'Dojo / Online' },
    { icon: 'kumite',     name: 'Kumite & Sparring',       desc: 'Tactical combat training under Chief Instructor Sensei Vikas Pathak (IV Dan). Sparring systems, reaction drills and competitive preparation.', lvl: 'Coloured Belt+', fee: 1100, mode: 'Dojo' },
    { icon: 'shield',     name: 'Self-Defense',            desc: 'Practical self-defense for real situations. Escape techniques, situational awareness and street-ready responses led by Sensei Sumitra Devi.', lvl: 'All Levels · Ages 12+', fee: 900, mode: 'Dojo / Online' },
    { icon: 'women',      name: "Women's Program",         desc: "MMAKF's dedicated women's martial arts and self-defense division. Safety awareness, confidence building and physical empowerment.", lvl: 'Women · Ages 14+', fee: 800, mode: 'Dojo / Online' },
    { icon: 'star',       name: 'Kids Program',            desc: 'Fun, structured martial arts for children aged 5–14. Build motor skills, focus, discipline and confidence from day one.', lvl: 'Ages 5–14', fee: 900, mode: 'Dojo' },
    { icon: 'medal',      name: 'Competitive / WKF Track', desc: 'Structured competitive pathway from district championships to WKF international registration.', lvl: 'Intermediate+', fee: 1500, mode: 'Dojo' },
    { icon: 'globe',      name: 'Online Academy',       desc: "Complete Shotokan curriculum via MMAKF's virtual university. Recorded library, live sessions, belt certification.", lvl: 'All Levels · Worldwide', fee: 999, mode: 'Online' },
    { icon: 'black-belt', name: 'Dan Grading Preparation', desc: 'Intensive preparation for MMAKF black belt grading under Shihan Pramod Kumar Pathak.', lvl: 'Brown Belt+', fee: 1800, mode: 'Dojo / Camp' },
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

  events: [
    { day: '15', mo: 'JUN', year: '2026', type: 'Grading',     t: 'MMAKF National Black Belt Grading Camp', loc: 'MMAKF Dojo — Main Hall',   fee: '₹500',  status: 'upcoming' },
    { day: '22', mo: 'JUN', year: '2026', type: 'Tournament',  t: 'District Karate Championship 2026',       loc: 'Indoor Sports Complex',     fee: '₹300',  status: 'upcoming' },
    { day: '05', mo: 'JUL', year: '2026', type: 'Seminar',     t: 'Shihan Pramod Pathak — Open Seminar on Kata', loc: 'MMAKF Academy',         fee: '₹800',  status: 'upcoming' },
    { day: '19', mo: 'JUL', year: '2026', type: 'Workshop',    t: 'Women Self-Defense Workshop — Sensei Sumitra Devi', loc: 'MMAKF Dojo',     fee: 'Free',  status: 'upcoming' },
    { day: '02', mo: 'AUG', year: '2026', type: 'Tournament',  t: 'State Karate Championship — MMAKF Team',  loc: 'State Sports Centre',       fee: '₹600',  status: 'upcoming' },
    { day: '15', mo: 'AUG', year: '2026', type: 'Exhibition',  t: 'Independence Day Karate Demonstration',   loc: 'City Park Amphitheatre',    fee: 'Free',  status: 'upcoming' },
  ],

  news: [
    { id: 1, title: 'District Championship 2026 concluded at Ramgarh', date: '23 Jun 2026', type: 'Competition', img: '/media/archive/championship-medal-ceremony.jpg', body: 'The MMAKF District Karate Championship 2026 was held at the Indoor Sports Complex on 22 June, with athletes from affiliated dojos competing across kata and kumite divisions. Full results are recorded in the federation results register.' },
    { id: 2, title: 'Sensei Vikas Pathak elevated to IV Dan',             date: '04 May 2026', type: 'Promotion',    img: '', body: 'In a formal grading ceremony presided over by Grandmaster Shihan Pramod Kumar Pathak, Chief Instructor Sensei Vikas Pathak was elevated to IV Dan Black Belt in recognition of two decades of service to the federation and the Tiger Lee Shotokan lineage.' },
    { id: 3, title: "Women's Self-Defense program now in 14 schools",      date: '21 Apr 2026', type: 'Community',     img: '/media/archive/selfdefence-school-class.jpg', body: "MMAKF's Women's Self-Defense initiative, led by Sensei Sumitra Devi, has now been adopted by 14 schools across the Ramgarh and Hazaribagh districts. The program runs as a free 12-week curriculum covering practical defense, situational awareness, and confidence building." },
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
    { id: 12, n: 'Tiger Lee Edition Hoodie',      cat: 'merch',       icon: 'medal',      p: 1499, m: 2200, badge: 'Limited' },
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
    { txt: 'I trained in three academies before MMAKF. Nothing compares to training under the Tiger Lee Shotokan lineage with Shihan Pramod Pathak. This is authentic martial education.', name: 'Daksh Mohan Mishra', role: 'National Champion · II Dan Black Belt' },
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
    { q: 'Are MMAKF belts and certificates recognised?',      a: 'Yes. MMAKF operates on the WKF international pathway — our coaches and athletes are registered under WKF SportsID and Sportdata ranking systems, and gradings follow the formal Shotokan syllabus of the Tiger Lee lineage.' },
    { q: 'Is there a dedicated program for women?',           a: "Yes — the Women's Empowerment Division led by Sensei Sumitra Devi (III Dan) runs dedicated women-only batches, a free 12-week self-defense curriculum through partner schools, and regular workshops." },
    { q: 'Can I really learn karate online?',                 a: 'The Online Academy carries the same syllabus, the same senseis and the same grading standard as the dojo. You get the structured course library, weekly live sessions and belt evaluation by video submission — students train with us from across India and abroad.' },
    { q: 'How do fees and payments work?',                    a: 'Program fees are monthly, and grading fees are per examination. Payments are accepted by UPI (9939144318@ybl) or in person at the dojo office. There are no hidden charges.' },
    { q: 'Do you prepare students for tournaments?',          a: 'Yes. The Competitive / WKF Track takes students from district championships to state, national and WKF-registered international competition, with dedicated kumite and kata coaching.' },
  ],

  gallery: [
    { icon: 'kata',       title: 'Kata Practice',                cat: 'Training',   desc: 'Form training — the foundation of every grading.',                    img: 'https://images.unsplash.com/photo-1555597673-b21d5c935865?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'kumite',     title: 'Impact & Pad Work',            cat: 'Training',   desc: 'Supervised striking practice in the impact bay.',                     img: 'https://images.unsplash.com/photo-1591117207239-788bf8de6c3b?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'medal',      title: 'Competition Karate',           cat: 'Competition', desc: 'The competitive track — district to state championships.',            img: '/media/archive/dojo-group.jpg' },
    { icon: 'black-belt', title: 'Grading Examinations',         cat: 'Grading',    desc: 'Candidates are examined on kihon, kata and kumite.',                  img: '/media/archive/grading-certificate-ceremony.jpg' },
    { icon: 'women',      title: "Women's Wing",                 cat: 'Community',  desc: "Women-only batches and the school self-defense curriculum.",          img: 'https://images.unsplash.com/photo-1574680096145-d05b474e2155?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'star',       title: 'Training Camps',               cat: 'Camps',      desc: 'Gasshuku — intensive multi-day training.',                            img: 'https://images.unsplash.com/photo-1599058917212-d750089bc07e?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'dumbbell',   title: 'Strength & Conditioning',      cat: 'Training',   desc: 'Karate-specific strength, speed and mobility work.',                  img: 'https://images.unsplash.com/photo-1605296867304-46d5465a13f1?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'book',       title: 'Study & Theory',               cat: 'Training',   desc: 'Terminology, rulebooks and syllabus manuals.',                        img: 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'globe',      title: 'Tournament Floor',             cat: 'Competition', desc: 'Sanctioned competition under federation officials.',                 img: 'https://images.unsplash.com/photo-1509563268479-0f004cf3f58b?auto=format&fit=crop&w=1000&q=70' },
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
  results: [
    { title: 'District Karate Championship 2026',      date: '22 Jun 2026', venue: 'Indoor Sports Complex, Ramgarh', note: 'MMAKF Ramgarh topped the medal table — 34 golds across kata and kumite divisions.' },
    { title: 'State Invitational Cup 2026',            date: '09 Mar 2026', venue: 'Ranchi',                          note: 'Federation team: 11 gold · 9 silver · 14 bronze. Six athletes selected for the state squad.' },
    { title: 'MMAKF National Grading Camp — Winter',   date: '14 Dec 2025', venue: 'Hombu Dojo, Patratu',             note: '214 candidates examined; 3 new Shodan awarded by the Examination Board.' },
  ],

  // Federation members register — powers the public ID verification tool on
  // /registration and the admin Members panel. Public data only (no phone).
  // ID format: MMAKF-{A|I|D|O}-{year}-{serial}  (Athlete/Instructor/Dojo/Official)
  members: [
    { id: 'MMAKF-I-1983-00001', name: 'Pramod Kumar Pathak',  type: 'Instructor', grade: 'VI Dan',         state: 'Jharkhand',   unit: 'Hombu Dojo, Patratu',   status: 'Active',    validTill: 'Lifetime' },
    { id: 'MMAKF-I-2004-00023', name: 'Vikas Pathak',         type: 'Instructor', grade: 'IV Dan',         state: 'Jharkhand',   unit: 'Hombu Dojo, Patratu',   status: 'Active',    validTill: 'Dec 2026' },
    { id: 'MMAKF-I-2010-00047', name: 'Sumitra Devi',         type: 'Instructor', grade: 'III Dan',        state: 'Jharkhand',   unit: "Women's Wing",          status: 'Active',    validTill: 'Dec 2026' },
    { id: 'MMAKF-A-2015-00891', name: 'Daksh Mohan Mishra',   type: 'Athlete',    grade: 'II Dan',         state: 'Jharkhand',   unit: 'Competitive / WKF Track', status: 'Active',  validTill: 'Dec 2026' },
    { id: 'MMAKF-A-2018-01204', name: 'Siddharth Prasad',     type: 'Athlete · Coach', grade: 'WKF Registered', state: 'Jharkhand', unit: 'Online Academy',   status: 'Active',    validTill: 'Dec 2026' },
    { id: 'MMAKF-A-2022-03412', name: 'Ankan Roy',            type: 'Athlete',    grade: 'I Dan',          state: 'West Bengal', unit: 'Kolkata Centre',        status: 'Active',    validTill: 'Dec 2026' },
    { id: 'MMAKF-D-1996-00004', name: 'MMAKF Ramgarh Centre', type: 'Dojo',       grade: '—',              state: 'Jharkhand',   unit: 'Ramgarh District',      status: 'Chartered', validTill: 'Mar 2027' },
  ],

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
  circulars: [
    { no: 'MMAKF/CIR/2026-07', date: '01 Jul 2026', title: 'State-squad selection criteria for the 2026 season', body: 'All state units must submit their squad longlists (max 20 athletes per category) to the Tournament Commission by 31 July. Selection trials follow the WKF kumite/kata format.' },
    { no: 'MMAKF/CIR/2026-05', date: '15 May 2026', title: 'Revised grading fee schedule effective 1 June 2026', body: 'The kyu grading fee table published on the Belt System page applies to all units from 1 June. District associations may not levy additional examination charges.' },
    { no: 'MMAKF/CIR/2026-03', date: '02 Mar 2026', title: 'Annual charter renewals due — Forms A-1 / A-2', body: 'All dojo and unit charters expire 31 March. Submit renewal forms with grading records for the year to the federation office. Late renewals suspend tournament rights.' },
  ],

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
