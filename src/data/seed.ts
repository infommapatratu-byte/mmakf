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

  leadership: [
    { name: 'Shihan Pramod Kumar Pathak', role: 'Grandmaster · Soke', rank: 'VI Dan Black Belt', note: 'Jr. Tiger Lee Lineage · Senior Technical Authority' },
    { name: 'Sensei Vikas Pathak',        role: 'Chief Instructor',    rank: 'IV Dan Black Belt', note: 'Kumite & Sparring' },
    { name: 'Sensei Dhiraj Pathak',       role: 'Kata Specialist',     rank: 'III Dan Black Belt', note: 'Form Training · Competition Preparation' },
    { name: 'Sensei Sumitra Devi',        role: 'Lady Instructor · Tournament Secretary', rank: 'III Dan Black Belt', note: "Women's Program & Self-Defense" },
    { name: 'Siddharth Prasad',           role: 'Co-CEO',              rank: 'WKF Registered', note: 'WKF Registered Athlete & Coach' },
    { name: 'Daksh Mohan Mishra',         role: 'National Champion',   rank: 'II Dan Black Belt', note: 'Competitive / WKF Track' },
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
    { icon: 'globe',      name: 'Online University',       desc: "Complete Shotokan curriculum via MMAKF's virtual university. Recorded library, live sessions, belt certification.", lvl: 'All Levels · Worldwide', fee: 999, mode: 'Online' },
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
    { id: 1, title: 'Registrations open for District Championship 2026', date: '12 May 2026', type: 'Announcement', body: 'Registrations are now open for the MMAKF District Karate Championship 2026, to be held at the Indoor Sports Complex on 22 June. All affiliated dojos and individual athletes from coloured belt and above are eligible. Entry fee ₹300 per athlete; team registrations close 15 June.' },
    { id: 2, title: 'Sensei Vikas Pathak elevated to IV Dan',             date: '04 May 2026', type: 'Promotion',    body: 'In a formal grading ceremony presided over by Grandmaster Shihan Pramod Kumar Pathak, Chief Instructor Sensei Vikas Pathak was elevated to IV Dan Black Belt in recognition of two decades of service to the federation and the Tiger Lee Shotokan lineage.' },
    { id: 3, title: "Women's Self-Defense program now in 14 schools",      date: '21 Apr 2026', type: 'Community',     body: "MMAKF's Women's Self-Defense initiative, led by Sensei Sumitra Devi, has now been adopted by 14 schools across the Ramgarh and Hazaribagh districts. The program runs as a free 12-week curriculum covering practical defense, situational awareness, and confidence building." },
  ],

  // `img` is an Unsplash hotlink (photography pass — MASTER-SPEC AS-6 revised);
  // `icon` remains the fallback when img is absent or fails.
  products: [
    { id: 1,  n: 'Karate-Gi Premium — MMAKF',     cat: 'uniform',     icon: 'karate-gi',  p: 1800, m: 2600, badge: 'Best Seller', img: 'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?auto=format&fit=crop&w=900&q=70' },
    { id: 2,  n: 'Competition Gi — Lightweight',  cat: 'uniform',     icon: 'karate-gi',  p: 2400, m: 3500, badge: null,          img: 'https://images.unsplash.com/photo-1564415315949-7a0c4c73aab4?auto=format&fit=crop&w=900&q=70' },
    { id: 3,  n: 'Kids Training Gi',              cat: 'uniform',     icon: 'karate-gi',  p: 1200, m: 1800, badge: 'New',         img: 'https://images.unsplash.com/photo-1555597673-b21d5c935865?auto=format&fit=crop&w=900&q=70' },
    { id: 4,  n: 'MMAKF Belt Set (White–Brown)',  cat: 'accessories', icon: 'black-belt', p: 650,  m: 1000, badge: null,          img: 'https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?auto=format&fit=crop&w=900&q=70' },
    { id: 5,  n: 'Black Belt — MMAKF Certified',  cat: 'accessories', icon: 'black-belt', p: 900,  m: 1400, badge: null,          img: 'https://images.unsplash.com/photo-1605296867304-46d5465a13f1?auto=format&fit=crop&w=900&q=70' },
    { id: 6,  n: 'Boxing Gloves 12oz',            cat: 'equipment',   icon: 'kumite',     p: 1400, m: 2000, badge: null,          img: 'https://images.unsplash.com/photo-1549719386-74dfcbf7dbed?auto=format&fit=crop&w=900&q=70' },
    { id: 7,  n: 'Shin Guards — Competition',     cat: 'equipment',   icon: 'shield',     p: 950,  m: 1500, badge: 'Sale',        img: 'https://images.unsplash.com/photo-1622599511051-16f55a1234d0?auto=format&fit=crop&w=900&q=70' },
    { id: 8,  n: 'Focus Mitts Pair',              cat: 'equipment',   icon: 'kumite',     p: 1100, m: 1700, badge: null,          img: 'https://images.unsplash.com/photo-1591117207239-788bf8de6c3b?auto=format&fit=crop&w=900&q=70' },
    { id: 9,  n: 'Sparring Headgear',             cat: 'equipment',   icon: 'shield',     p: 1700, m: 2600, badge: null,          img: 'https://images.unsplash.com/photo-1552072092-7f9b8d63efcb?auto=format&fit=crop&w=900&q=70' },
    { id: 10, n: 'MMAKF Training Bag',            cat: 'accessories', icon: 'book',       p: 1300, m: 1900, badge: 'New',         img: 'https://images.unsplash.com/photo-1584735935682-2f2b69dff9d2?auto=format&fit=crop&w=900&q=70' },
    { id: 11, n: 'MMAKF T-Shirt — Black',         cat: 'merch',       icon: 'karate-gi',  p: 599,  m: 899,  badge: 'Popular',     img: 'https://images.unsplash.com/photo-1618354691373-d851c5c3a990?auto=format&fit=crop&w=900&q=70' },
    { id: 12, n: 'Tiger Lee Edition Hoodie',      cat: 'merch',       icon: 'medal',      p: 1499, m: 2200, badge: 'Limited',     img: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&w=900&q=70' },
  ],

  achievements: [
    { icon: 'book',   title: 'Limca Book of Records',     body: "MMAKF's extraordinary mass training achievements have been recognized in the Limca Book of Records.", badge: 'National Record' },
    { icon: 'medal',  title: 'Guinness Recognition',       body: 'Institutional evidence of Guinness World Records-linked recognition.', badge: 'World Record' },
    { icon: 'globe',  title: 'WKF International Pathway',  body: 'MMAKF-trained coaches and athletes are formally registered under WKF SportsID and Sportdata ranking systems.', badge: 'WKF Registered' },
    { icon: 'school', title: '130+ Schools Reached',       body: 'At its historical peak, MMAKF operated structured martial arts programs across more than 130 schools.', badge: 'Institutional Scale' },
    { icon: 'users',  title: 'Multi-Generational Legacy',  body: 'Since 1983, MMAKF has produced champions, black belts, coaches, instructors and referees.', badge: '42+ Years' },
    { icon: 'star',   title: 'Priya Priyadarshini',        body: 'A standout MMAKF student recognized for world-record-level achievement.', badge: 'World Level' },
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
    { icon: 'monitor',   name: 'Online Class Studio',           tag: 'Digital',  desc: 'The broadcast room behind the MMAKF Online University — live classes, a recorded syllabus library and video-submission grading.' },
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
    { q: 'Can I really learn karate online?',                 a: 'The Online University carries the same syllabus, the same senseis and the same grading standard as the dojo. You get 180+ recorded lessons, weekly live sessions and belt evaluation by video submission — students train with us from across India and abroad.' },
    { q: 'How do fees and payments work?',                    a: 'Program fees are monthly, and grading fees are per examination. Payments are accepted by UPI (9939144318@ybl) or in person at the dojo office. There are no hidden charges.' },
    { q: 'Do you prepare students for tournaments?',          a: 'Yes. The Competitive / WKF Track takes students from district championships to state, national and WKF-registered international competition, with dedicated kumite and kata coaching.' },
  ],

  gallery: [
    { icon: 'kata',       title: 'Kata at First Light',              cat: 'Dojo',       desc: 'Morning kata practice — the discipline begins before sunrise.',            img: 'https://images.unsplash.com/photo-1555597673-b21d5c935865?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'kumite',     title: 'Impact Training',                  cat: 'Dojo',       desc: 'Full-contact drills in the impact bay under supervision.',                 img: 'https://images.unsplash.com/photo-1591117207239-788bf8de6c3b?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'medal',      title: 'Walk-out — District Championship', cat: 'Tournament', desc: 'An MMAKF athlete enters the arena on finals night.',                       img: 'https://images.unsplash.com/photo-1552072092-7f9b8d63efcb?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'black-belt', title: 'Grading Day — Groundwork',         cat: 'Grading',    desc: "Candidates demonstrate under the examiners' eyes.",                        img: 'https://images.unsplash.com/photo-1564415315949-7a0c4c73aab4?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'women',      title: "Women's Strength Division",        cat: 'Community',  desc: "Sensei Sumitra Devi's division builds physical authority.",                img: 'https://images.unsplash.com/photo-1574680096145-d05b474e2155?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'star',       title: 'Conditioning Camp',                cat: 'Camp',       desc: 'Summer gasshuku — endurance day at the training grounds.',                 img: 'https://images.unsplash.com/photo-1599058917212-d750089bc07e?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'dumbbell',   title: 'Strength & Conditioning Zone',     cat: 'Dojo',       desc: 'Karate-specific strength work at the hombu.',                              img: 'https://images.unsplash.com/photo-1605296867304-46d5465a13f1?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'book',       title: 'The Dojo Library',                 cat: 'Dojo',       desc: 'Study corner — rulebooks, syllabus manuals and karate texts.',             img: 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=1000&q=70' },
    { icon: 'globe',      title: 'Fight Night',                      cat: 'Tournament', desc: 'State championship finals under the lights.',                              img: 'https://images.unsplash.com/photo-1509563268479-0f004cf3f58b?auto=format&fit=crop&w=1000&q=70' },
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

  branches: [
    { name: 'MMAKF Hombu Dojo',              city: 'Patratu',    district: 'Ramgarh',    incharge: 'Shihan Pramod Kumar Pathak', status: 'Headquarters' },
    { name: 'MMAKF Ramgarh Centre',          city: 'Ramgarh',    district: 'Ramgarh',    incharge: 'Sensei Vikas Pathak',        status: 'Affiliated' },
    { name: 'MMAKF Hazaribagh Dojo',         city: 'Hazaribagh', district: 'Hazaribagh', incharge: 'Sensei Dhiraj Pathak',       status: 'Affiliated' },
    { name: 'MMAKF Ranchi Training Centre',  city: 'Ranchi',     district: 'Ranchi',     incharge: 'Senpai Ravishankar',         status: 'Affiliated' },
    { name: 'MMAKF Bokaro Dojo',             city: 'Bokaro',     district: 'Bokaro',     incharge: 'Daksh Mohan Mishra',         status: 'Affiliated' },
    { name: "Women's Wing — Partner Schools", city: '14 schools', district: 'Ramgarh & Hazaribagh', incharge: 'Sensei Sumitra Devi', status: 'Community' },
    { name: 'MMAKF Online University',       city: 'Worldwide',  district: '—',          incharge: 'Federation Faculty',         status: 'Digital' },
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
};

// Keys we persist in KV (so admin can edit each independently)
export const KEYS = [
  'federation', 'stats', 'leadership', 'programs', 'schedule',
  'events', 'news', 'products', 'achievements', 'testimonials', 'beltGrading',
  'facilities', 'faqs', 'gallery', 'syllabus', 'branches',
] as const;

export type DataKey = typeof KEYS[number];
