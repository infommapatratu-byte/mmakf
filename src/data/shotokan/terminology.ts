/**
 * THE TERMINOLOGY REGISTER
 *
 * One definition per term, referenced by key from everywhere else. The kata
 * library already learned this lesson the hard way and says so in its own
 * header: twenty-six kata that each explain `kokutsu-dachi` in their own words
 * end up explaining it three different ways, and the student learning from the
 * library is the one who pays.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO RULES ABOUT LANGUAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. A TRANSLATION IS NOT AN EXPLANATION. "Kokutsu-dachi = back stance" tells a
 *    beginner nothing about where the weight goes or what the stance is for.
 *    Every entry therefore carries both: `english` is the short rendering, and
 *    `explain` is what it actually is.
 *
 * 2. HINDI IS PRESENT WHERE IT IS RIGHT AND ABSENT WHERE IT IS NOT. §32 of the
 *    directive asks for Hindi and for future Indian-language translations.
 *    Where a term has a natural, unambiguous Hindi rendering it is given. Where
 *    the honest answer is that the Japanese term is what is used on the floor
 *    in Indian dojos — which is true of most technique names — `hindi` is null
 *    and the surfaces say nothing rather than printing a machine translation
 *    that no instructor would recognise or use. A wrong translation in a
 *    federation's own glossary is worse than an absent one: students learn it.
 *
 * `audio` is declared and null on every entry. §32 permits pronunciation audio
 * "where authorized"; MMAKF has recorded none, and no third party's recording
 * is going to be presented as the federation's.
 */

// ─── Families ───────────────────────────────────────────────────────────────

/**
 * The kihon families of §6. Exported as a type because the technique records
 * are keyed on it, and as a labelled list because every surface that groups
 * techniques must group them the same way and call them the same thing.
 */
export type KihonFamily =
  | 'dachi'
  | 'tsuki'
  | 'uchi'
  | 'uke'
  | 'geri'
  | 'tai_sabaki'
  | 'ashi_sabaki'
  | 'combination';

export const KIHON_FAMILIES: readonly {
  key: KihonFamily;
  romaji: string;
  kanji: string | null;
  english: string;
  /** One sentence on what the family is for. Shown above each group. */
  blurb: string;
}[] = [
  {
    key: 'dachi',
    romaji: 'Dachi-waza',
    kanji: '立ち技',
    english: 'Stances',
    blurb: 'How the body stands, and therefore what it can do next. Every other technique inherits its power and its mobility from the stance underneath it.',
  },
  {
    key: 'tsuki',
    romaji: 'Tsuki-waza',
    kanji: '突き技',
    english: 'Thrusting techniques',
    blurb: 'Straight techniques delivered by thrusting the fist along the shortest line to the target.',
  },
  {
    key: 'uke',
    romaji: 'Uke-waza',
    kanji: '受け技',
    english: 'Receiving techniques',
    blurb: 'Usually translated "blocks", but uke means to receive. Each of these deflects, unbalances or damages, and finishes with a counter already available.',
  },
  {
    key: 'uchi',
    romaji: 'Uchi-waza',
    kanji: '打ち技',
    english: 'Striking techniques',
    blurb: 'Techniques delivered along an arc rather than a straight line, and with contact surfaces other than the front two knuckles.',
  },
  {
    key: 'geri',
    romaji: 'Geri-waza',
    kanji: '蹴り技',
    english: 'Kicking techniques',
    blurb: 'The longest and heaviest techniques in the syllabus, and the ones that cost the most balance to throw.',
  },
  {
    key: 'tai_sabaki',
    romaji: 'Tai-sabaki',
    kanji: '体捌き',
    english: 'Body movement',
    blurb: 'Moving the body off the line of an attack while remaining in range to answer it.',
  },
  {
    key: 'ashi_sabaki',
    romaji: 'Ashi-sabaki',
    kanji: '足捌き',
    english: 'Footwork',
    blurb: 'Sliding, stepping, switching and turning without losing balance, height or guard.',
  },
  {
    key: 'combination',
    romaji: 'Renzoku-waza',
    kanji: '連続技',
    english: 'Combinations',
    blurb: 'Techniques joined so that the finish of one is the preparation for the next.',
  },
];

// ─── Terms ──────────────────────────────────────────────────────────────────

export interface Term {
  /** Hyphenated ASCII romaji. The record key is this, lowercased. */
  romaji: string;
  /** The characters, where they are certain. Null rather than romaji in disguise. */
  kanji: string | null;
  /** The short English rendering. A translation. */
  english: string;
  /** What it actually is. See rule 1 in the header. */
  explain: string;
  /** Devanagari, where a natural rendering exists. Null otherwise — see rule 2. */
  hindi: string | null;
  /** Related term keys. */
  see: readonly string[];
  /** ALWAYS null. MMAKF has recorded no pronunciation audio. */
  audio: string | null;
}

const D = (t: Omit<Term, 'audio'>): Term => ({ ...t, audio: null });

export const TERMS: Record<string, Term> = {
  // ── Concepts ──────────────────────────────────────────────────────────────
  kime: D({
    romaji: 'Kime',
    kanji: '決め',
    english: 'Focus, decision',
    explain:
      'The instant at which every part of the body arrives at once and the technique becomes solid — and the instant immediately after, when it relaxes again. Kime is a moment, not a state. Tension held after impact is tension that slows whatever comes next.',
    hindi: null,
    see: ['zanshin', 'hikite'],
  }),
  zanshin: D({
    romaji: 'Zanshin',
    kanji: '残心',
    english: 'Remaining mind, continued awareness',
    explain:
      'The alertness that continues after a technique has finished. A karateka who scores and then relaxes has demonstrated the absence of zanshin, and in competition it is judged as part of the technique rather than as an extra.',
    hindi: null,
    see: ['kime', 'maai'],
  }),
  maai: D({
    romaji: 'Maai',
    kanji: '間合い',
    english: 'Engagement distance',
    explain:
      'The distance between two people, understood as a relationship rather than a measurement: the same gap is close for a tall fighter and long for a short one, and it changes the instant either moves. Controlling it is the largest single skill in free fighting.',
    hindi: null,
    see: ['kamae', 'zanshin', 'ashi-sabaki'],
  }),
  kamae: D({
    romaji: 'Kamae',
    kanji: '構え',
    english: 'Guard, posture of readiness',
    explain:
      'The position taken up facing an opponent — feet, hips, hands and eyes together. A good kamae threatens without committing, and gives away nothing about what is coming.',
    hindi: null,
    see: ['maai', 'hanmi', 'zanshin'],
  }),
  hanmi: D({
    romaji: 'Hanmi',
    kanji: '半身',
    english: 'Half-facing',
    explain:
      'The hips turned roughly forty-five degrees away from the opponent. It narrows the target presented and pre-loads the rotation a counter will use, which is why so many blocks finish in it.',
    hindi: null,
    see: ['kamae', 'kokutsu-dachi', 'gyaku-zuki'],
  }),
  hikite: D({
    romaji: 'Hikite',
    kanji: '引き手',
    english: 'Withdrawing hand',
    explain:
      'The hand that pulls sharply back to the hip as the other technique goes out. It is not decoration: it accelerates the working hand by opposing rotation, and in application it is the hand that has just grabbed the opponent and is pulling them onto the technique.',
    hindi: null,
    see: ['kime', 'choku-zuki'],
  }),
  rei: D({
    romaji: 'Rei',
    kanji: '礼',
    english: 'Bow, courtesy',
    explain:
      'The bow, and behind it the whole idea of reigi — the etiquette that frames practice. Karate begins and ends with it, which is a statement about what the practice is for.',
    hindi: 'नमन',
    see: ['musubi-dachi'],
  }),
  yoi: D({
    romaji: 'Yoi',
    kanji: '用意',
    english: 'Ready',
    explain: 'The command to take the ready position, and the settled, alert state it names.',
    hindi: 'तैयार',
    see: ['hachiji-dachi', 'shizentai'],
  }),
  shizentai: D({
    romaji: 'Shizentai',
    kanji: '自然体',
    english: 'Natural posture',
    explain: 'Standing naturally and at ease, but not slackly — the posture from which anything is still possible.',
    hindi: null,
    see: ['hachiji-dachi', 'yoi'],
  }),
  kiai: D({
    romaji: 'Kiai',
    kanji: '気合い',
    english: 'Spirited shout',
    explain:
      'The shout at the moment of a decisive technique. It tightens the abdomen, forces the exhalation that kime needs, and commits the person making it. Kata specify where it falls, and it is scored.',
    hindi: null,
    see: ['kime'],
  }),
  embusen: D({
    romaji: 'Embusen',
    kanji: '演武線',
    english: 'Performance line',
    explain:
      'The floor pattern a kata traces. A kata should finish where it started; a performance that drifts off its embusen has lost something measurable.',
    hindi: null,
    see: [],
  }),
  bunkai: D({
    romaji: 'Bunkai',
    kanji: '分解',
    english: 'Analysis, application',
    explain:
      'The study of what a kata movement is actually for against a person. Serious bunkai is a technical judgement made by qualified instructors, which is why nothing in this library presents an application as authoritative without a recorded technical review.',
    hindi: null,
    see: ['embusen'],
  }),

  // ── Levels ────────────────────────────────────────────────────────────────
  jodan: D({
    romaji: 'Jodan',
    kanji: '上段',
    english: 'Upper level',
    explain: 'The head and the neck — both as a target and as the level at which a technique is named and performed. Jodan-zuki is a punch to that level; jodan-uke is a block against one arriving there.',
    hindi: null,
    see: ['chudan', 'gedan'],
  }),
  chudan: D({
    romaji: 'Chudan',
    kanji: '中段',
    english: 'Middle level',
    explain: 'The torso, from the collarbone down to the belt. It is the level most often attacked in basic practice, because it is the largest target and the one a beginner can strike with control.',
    hindi: null,
    see: ['jodan', 'gedan'],
  }),
  gedan: D({
    romaji: 'Gedan',
    kanji: '下段',
    english: 'Lower level',
    explain: 'Below the belt. As a level it names the low blocks and the stamping techniques. Whether it is a permitted target is a matter of the competition rules in force, and so is not stated here as a fixed fact.',
    hindi: null,
    see: ['jodan', 'chudan'],
  }),

  // ── Contact surfaces ──────────────────────────────────────────────────────
  seiken: D({
    romaji: 'Seiken',
    kanji: '正拳',
    english: 'Forefist',
    explain:
      'The front two knuckles of the closed fist, with the wrist straight so the bones of the forearm sit directly behind them. Nearly every punch in the syllabus lands here.',
    hindi: null,
    see: ['choku-zuki'],
  }),
  shuto: D({
    romaji: 'Shuto',
    kanji: '手刀',
    english: 'Knife hand, sword hand',
    explain: 'The muscular outer edge of the open hand below the little finger, fingers together and thumb tucked.',
    hindi: null,
    see: ['shuto-uke', 'shuto-uchi'],
  }),
  haito: D({
    romaji: 'Haito',
    kanji: '背刀',
    english: 'Ridge hand',
    explain: 'The thumb-side edge of the open hand, with the thumb folded underneath and out of the way.',
    hindi: null,
    see: ['haito-uchi'],
  }),
  teisho: D({
    romaji: 'Teisho',
    kanji: '底掌',
    english: 'Palm heel',
    explain: 'The heel of the palm, with the wrist bent back and the fingers lifted clear of the target.',
    hindi: null,
    see: ['teisho-uchi'],
  }),
  uraken: D({
    romaji: 'Uraken',
    kanji: '裏拳',
    english: 'Back fist',
    explain: 'The back of the first two knuckles, the arm whipping out around a fixed elbow. A small, hard surface delivered fast rather than heavily.',
    hindi: null,
    see: ['uraken-uchi'],
  }),
  tetsui: D({
    romaji: 'Tetsui',
    kanji: '鉄鎚',
    english: 'Hammer fist',
    explain: 'The padded little-finger side of the closed fist. Robust enough to strike hard targets a straight punch should avoid.',
    hindi: null,
    see: ['tetsui-uchi'],
  }),
  koshi: D({
    romaji: 'Koshi',
    kanji: '腰',
    english: 'Ball of the foot',
    explain:
      'The ball of the foot, used with the toes pulled firmly back. The same word also means the hips, which is a source of confusion worth naming rather than avoiding.',
    hindi: null,
    see: ['mae-geri'],
  }),
  sokuto: D({
    romaji: 'Sokuto',
    kanji: '足刀',
    english: 'Foot edge, sword foot',
    explain: 'The outer edge of the foot, with the edge turned down and the toes pulled up.',
    hindi: null,
    see: ['yoko-geri-keage', 'yoko-geri-kekomi', 'fumikomi'],
  }),
  haisoku: D({
    romaji: 'Haisoku',
    kanji: '背足',
    english: 'Instep',
    explain: 'The top of the foot, toes pointed. The usual contact surface for a roundhouse kick.',
    hindi: null,
    see: ['mawashi-geri'],
  }),
  kakato: D({
    romaji: 'Kakato',
    kanji: '踵',
    english: 'Heel',
    explain: 'The heel, used in back kicks, hook kicks and stamping techniques.',
    hindi: null,
    see: ['ushiro-geri', 'ura-mawashi-geri', 'fumikomi'],
  }),
  hiza: D({
    romaji: 'Hiza',
    kanji: '膝',
    english: 'Knee',
    explain: 'The knee, both as a striking surface at close range and as the joint whose position defines every kick’s chamber.',
    hindi: 'घुटना',
    see: ['mae-geri'],
  }),

  // ── Movement ──────────────────────────────────────────────────────────────
  'tai-sabaki': D({
    romaji: 'Tai-sabaki',
    kanji: '体捌き',
    english: 'Body management',
    explain: 'Moving the body off the line of an attack while staying close enough to answer it.',
    hindi: null,
    see: ['ashi-sabaki', 'maai'],
  }),
  'ashi-sabaki': D({
    romaji: 'Ashi-sabaki',
    kanji: '足捌き',
    english: 'Footwork',
    explain: 'The management of the feet: sliding, stepping, switching and turning without losing balance, height or guard.',
    hindi: null,
    see: ['suri-ashi', 'tsugi-ashi', 'ayumi-ashi', 'maai'],
  }),
  'suri-ashi': D({
    romaji: 'Suri-ashi',
    kanji: '摺り足',
    english: 'Sliding foot',
    explain: 'Moving by sliding the feet along the floor without lifting or crossing them. The default footwork of free fighting.',
    hindi: null,
    see: ['ashi-sabaki'],
  }),
  'tsugi-ashi': D({
    romaji: 'Tsugi-ashi',
    kanji: '継ぎ足',
    english: 'Following foot',
    explain: 'Bringing the rear foot up to the front foot and then stepping forward with the front. Covers distance quickly without crossing the feet.',
    hindi: null,
    see: ['ashi-sabaki'],
  }),
  'ayumi-ashi': D({
    romaji: 'Ayumi-ashi',
    kanji: '歩み足',
    english: 'Walking step',
    explain: 'Stepping through so one foot passes the other, as in ordinary walking. Covers ground but changes the lead, which is a decision, not a side effect.',
    hindi: null,
    see: ['ashi-sabaki'],
  }),

  // ── Stances ───────────────────────────────────────────────────────────────
  'zenkutsu-dachi': D({
    romaji: 'Zenkutsu-dachi',
    kanji: '前屈立ち',
    english: 'Front stance',
    explain: 'A long stance with the front knee bent over the foot and the back leg straight. About sixty per cent of the weight is on the front leg.',
    hindi: null,
    see: ['kokutsu-dachi', 'kiba-dachi'],
  }),
  'kokutsu-dachi': D({
    romaji: 'Kokutsu-dachi',
    kanji: '後屈立ち',
    english: 'Back stance',
    explain: 'Roughly seventy per cent of the weight on the rear leg, the feet forming an L with both heels on one line, hips half-facing.',
    hindi: null,
    see: ['zenkutsu-dachi', 'hanmi', 'shuto-uke'],
  }),
  'kiba-dachi': D({
    romaji: 'Kiba-dachi',
    kanji: '騎馬立ち',
    english: 'Horse-riding stance',
    explain: 'A wide, square, evenly weighted stance with both feet parallel and the knees pushed outward.',
    hindi: null,
    see: ['fudo-dachi'],
  }),
  'fudo-dachi': D({
    romaji: 'Fudo-dachi',
    kanji: '不動立ち',
    english: 'Rooted stance',
    explain: 'The length of a front stance with the even weighting and outward knee pressure of a horse stance. Also called sochin-dachi.',
    hindi: null,
    see: ['zenkutsu-dachi', 'kiba-dachi'],
  }),
  'neko-ashi-dachi': D({
    romaji: 'Neko-ashi-dachi',
    kanji: '猫足立ち',
    english: 'Cat-foot stance',
    explain: 'A short stance with almost all the weight on the rear leg and the front heel raised, so the front foot can kick without any weight shift.',
    hindi: null,
    see: ['kokutsu-dachi'],
  }),
  'hangetsu-dachi': D({
    romaji: 'Hangetsu-dachi',
    kanji: '半月立ち',
    english: 'Half-moon stance',
    explain: 'A short front stance with both feet turned in and the knees squeezed toward each other, named for the crescent path of the stepping foot.',
    hindi: null,
    see: ['sanchin-dachi'],
  }),
  'sanchin-dachi': D({
    romaji: 'Sanchin-dachi',
    kanji: '三戦立ち',
    english: 'Hourglass stance',
    explain: 'A short rooted stance from the Naha-te lineages, feet turned in and knees drawn together. Not a Shotokan stance; documented for cross-reference.',
    hindi: null,
    see: ['hangetsu-dachi'],
  }),
  'musubi-dachi': D({
    romaji: 'Musubi-dachi',
    kanji: '結び立ち',
    english: 'Joined-feet stance',
    explain: 'Heels together, toes turned out. The stance of the formal bow.',
    hindi: null,
    see: ['heisoku-dachi', 'rei'],
  }),
  'heisoku-dachi': D({
    romaji: 'Heisoku-dachi',
    kanji: '閉足立ち',
    english: 'Closed-feet stance',
    explain: 'Feet together and parallel. A gathering point passed through rather than held.',
    hindi: null,
    see: ['musubi-dachi'],
  }),
  'hachiji-dachi': D({
    romaji: 'Hachiji-dachi',
    kanji: '八字立ち',
    english: 'Open-leg stance',
    explain: 'Feet about shoulder-width apart, toes turned slightly out. The ready position from which kihon begins.',
    hindi: null,
    see: ['yoi', 'shizentai'],
  }),

  // ── Techniques ────────────────────────────────────────────────────────────
  'choku-zuki': D({
    romaji: 'Choku-zuki',
    kanji: '直突き',
    english: 'Straight punch',
    explain: 'The straight punch from the natural stance, without stepping or hip rotation. The punch every other punch is measured against.',
    hindi: null,
    see: ['seiken', 'hikite'],
  }),
  'oi-zuki': D({
    romaji: 'Oi-zuki',
    kanji: '追い突き',
    english: 'Lunge punch',
    explain: 'A punch with the hand on the same side as the stepping foot, arriving exactly as the step lands.',
    hindi: null,
    see: ['gyaku-zuki', 'zenkutsu-dachi'],
  }),
  'gyaku-zuki': D({
    romaji: 'Gyaku-zuki',
    kanji: '逆突き',
    english: 'Reverse punch',
    explain: 'A punch with the hand opposite the front foot, powered by rotating the hips from half-facing to square. The most-used counter in the sport.',
    hindi: null,
    see: ['oi-zuki', 'hanmi', 'hikite'],
  }),
  'kizami-zuki': D({
    romaji: 'Kizami-zuki',
    kanji: '刻み突き',
    english: 'Jab, leading-hand punch',
    explain: 'A front-hand punch, usually with a short slide of the front foot. Less mass than a reverse punch, and far sooner.',
    hindi: null,
    see: ['gyaku-zuki', 'kamae'],
  }),
  'age-zuki': D({
    romaji: 'Age-zuki',
    kanji: '揚げ突き',
    english: 'Rising punch',
    explain: 'A punch travelling upward in a shallow arc to the underside of the jaw, used at close range.',
    hindi: null,
    see: ['ura-zuki'],
  }),
  'tate-zuki': D({
    romaji: 'Tate-zuki',
    kanji: '立て突き',
    english: 'Vertical-fist punch',
    explain: 'A punch that stops with the fist vertical rather than rotating fully to palm-down. Suits medium range.',
    hindi: null,
    see: ['choku-zuki', 'seiken'],
  }),
  'ura-zuki': D({
    romaji: 'Ura-zuki',
    kanji: '裏突き',
    english: 'Close punch',
    explain: 'A short punch with the fist palm-upward and the elbow still bent, for ranges where nothing longer fits.',
    hindi: null,
    see: ['age-zuki'],
  }),
  'morote-zuki': D({
    romaji: 'Morote-zuki',
    kanji: '諸手突き',
    english: 'Double-hand punch',
    explain: 'Both fists delivered together, trading the acceleration hikite gives for combined mass.',
    hindi: null,
    see: ['hikite'],
  }),
  'age-uke': D({
    romaji: 'Age-uke',
    kanji: '揚げ受け',
    english: 'Rising block',
    explain: 'A rising forearm block that deflects a descending or head-height attack upward and away, finishing about a fist’s width above the forehead.',
    hindi: null,
    see: ['jodan', 'hikite'],
  }),
  'soto-uke': D({
    romaji: 'Soto-uke',
    kanji: '外受け',
    english: 'Outside block',
    explain: 'A block travelling from outside the body inward, striking the attacking limb with the outer forearm.',
    hindi: null,
    see: ['uchi-uke', 'chudan'],
  }),
  'uchi-uke': D({
    romaji: 'Uchi-uke',
    kanji: '内受け',
    english: 'Inside block',
    explain: 'A block travelling from inside the body outward, meeting the attack with the inner forearm and clearing the centre line.',
    hindi: null,
    see: ['soto-uke', 'morote-uke'],
  }),
  'gedan-barai': D({
    romaji: 'Gedan-barai',
    kanji: '下段払い',
    english: 'Downward sweep',
    explain: 'A downward sweeping block clearing an attack to the lower level, finishing a fist’s width above and outside the front knee.',
    hindi: null,
    see: ['gedan', 'hikite'],
  }),
  'shuto-uke': D({
    romaji: 'Shuto-uke',
    kanji: '手刀受け',
    english: 'Knife-hand block',
    explain: 'An open-handed block cutting outward with the hand edge, almost always in kokutsu-dachi, with the other hand at the solar plexus rather than the hip.',
    hindi: null,
    see: ['shuto', 'kokutsu-dachi', 'hanmi'],
  }),
  'morote-uke': D({
    romaji: 'Morote-uke',
    kanji: '諸手受け',
    english: 'Augmented block',
    explain: 'An uchi-uke supported by the other hand pressing against the inside of the blocking forearm.',
    hindi: null,
    see: ['uchi-uke'],
  }),
  'juji-uke': D({
    romaji: 'Juji-uke',
    kanji: '十字受け',
    english: 'Cross block',
    explain: 'Both forearms crossed at the wrists to receive an attack in the fork they make. Usually becomes a grab.',
    hindi: null,
    see: ['gedan', 'jodan'],
  }),
  'kakiwake-uke': D({
    romaji: 'Kakiwake-uke',
    kanji: '掻き分け受け',
    english: 'Wedge block',
    explain: 'Both forearms driving outward from a crossed position to part a two-handed grab.',
    hindi: null,
    see: ['hangetsu-dachi'],
  }),
  'shuto-uchi': D({
    romaji: 'Shuto-uchi',
    kanji: '手刀打ち',
    english: 'Knife-hand strike',
    explain: 'A strike with the little-finger edge of the open hand, travelling in an arc to the neck, temple or collarbone.',
    hindi: null,
    see: ['shuto', 'shuto-uke'],
  }),
  'uraken-uchi': D({
    romaji: 'Uraken-uchi',
    kanji: '裏拳打ち',
    english: 'Back-fist strike',
    explain: 'A whipping strike with the back of the first two knuckles, the forearm snapping around a fixed elbow.',
    hindi: null,
    see: ['uraken'],
  }),
  'tetsui-uchi': D({
    romaji: 'Tetsui-uchi',
    kanji: '鉄鎚打ち',
    english: 'Hammer-fist strike',
    explain: 'A strike with the padded little-finger side of the fist, swung like a hammer.',
    hindi: null,
    see: ['tetsui'],
  }),
  'empi-uchi': D({
    romaji: 'Empi-uchi',
    kanji: '猿臂打ち',
    english: 'Elbow strike',
    explain: 'A strike with the point of the elbow, in any of five directions. The most powerful weapon available at close range.',
    hindi: null,
    see: ['kime'],
  }),
  'haito-uchi': D({
    romaji: 'Haito-uchi',
    kanji: '背刀打ち',
    english: 'Ridge-hand strike',
    explain: 'A strike with the thumb edge of the open hand, swung in a wide arc that curves around a guard.',
    hindi: null,
    see: ['haito'],
  }),
  'teisho-uchi': D({
    romaji: 'Teisho-uchi',
    kanji: '底掌打ち',
    english: 'Palm-heel strike',
    explain: 'A strike with the heel of the palm, wrist bent back and fingers clear. Forgiving of imperfect alignment.',
    hindi: null,
    see: ['teisho'],
  }),
  'mae-geri': D({
    romaji: 'Mae-geri',
    kanji: '前蹴り',
    english: 'Front kick',
    explain: 'The straight kick to the front with the ball of the foot, from a raised and folded knee.',
    hindi: null,
    see: ['koshi', 'hiza'],
  }),
  'yoko-geri-keage': D({
    romaji: 'Yoko-geri keage',
    kanji: '横蹴り上げ',
    english: 'Side snap kick',
    explain: 'A snapping kick to the side with the outer edge of the foot, travelling in a rising arc.',
    hindi: null,
    see: ['sokuto', 'yoko-geri-kekomi'],
  }),
  'yoko-geri-kekomi': D({
    romaji: 'Yoko-geri kekomi',
    kanji: '横蹴り込み',
    english: 'Side thrust kick',
    explain: 'A thrusting kick to the side driven through the target. Shares its chamber with keage, which is a tactical asset.',
    hindi: null,
    see: ['sokuto', 'yoko-geri-keage'],
  }),
  'mawashi-geri': D({
    romaji: 'Mawashi-geri',
    kanji: '回し蹴り',
    english: 'Roundhouse kick',
    explain: 'A circular kick from outside to inside, delivered with the instep or ball of the foot. The most-used kick in competition.',
    hindi: null,
    see: ['haisoku'],
  }),
  'ushiro-geri': D({
    romaji: 'Ushiro-geri',
    kanji: '後ろ蹴り',
    english: 'Back kick',
    explain: 'A thrusting kick straight to the rear with the heel, the head turning to find the target first.',
    hindi: null,
    see: ['kakato'],
  }),
  'ura-mawashi-geri': D({
    romaji: 'Ura-mawashi-geri',
    kanji: '裏回し蹴り',
    english: 'Reverse roundhouse kick',
    explain: 'A circular kick from inside to outside, hooking back to strike with the heel or sole.',
    hindi: null,
    see: ['mawashi-geri', 'kakato'],
  }),
  'mikazuki-geri': D({
    romaji: 'Mikazuki-geri',
    kanji: '三日月蹴り',
    english: 'Crescent kick',
    explain: 'A kick swinging in a crescent across the body, often used to clear a guard rather than to strike.',
    hindi: null,
    see: [],
  }),
  fumikomi: D({
    romaji: 'Fumikomi',
    kanji: '踏み込み',
    english: 'Stamping kick',
    explain: 'A downward stamp with the heel or foot edge into the knee, shin or instep. The one kick that does not re-chamber, because it becomes the next stance.',
    hindi: null,
    see: ['sokuto', 'kakato'],
  }),

  // ── Kumite ────────────────────────────────────────────────────────────────
  kumite: D({
    romaji: 'Kumite',
    kanji: '組手',
    english: 'Sparring, grappling hands',
    explain: 'Practice with a partner, ranging from wholly prearranged exercises to free fighting and competition.',
    hindi: null,
    see: ['kihon', 'kata'],
  }),
  kihon: D({
    romaji: 'Kihon',
    kanji: '基本',
    english: 'Basics, fundamentals',
    explain: 'The individual techniques practised in isolation and in simple combinations. The vocabulary the other two divisions of karate are written in.',
    hindi: 'मूल',
    see: ['kata', 'kumite'],
  }),
  kata: D({
    romaji: 'Kata',
    kanji: '型',
    english: 'Form',
    explain: 'A prescribed sequence of techniques performed alone against imagined opponents. The way the art was transmitted before it was written down.',
    hindi: null,
    see: ['bunkai', 'embusen'],
  }),
  'go-no-sen': D({
    romaji: 'Go-no-sen',
    kanji: '後の先',
    english: 'Late initiative',
    explain: 'Receiving the attack and then countering. The initiative is taken back after the opponent has committed.',
    hindi: null,
    see: ['sen-no-sen', 'tai-no-sen'],
  }),
  'sen-no-sen': D({
    romaji: 'Sen-no-sen',
    kanji: '先の先',
    english: 'Initiative ahead of the initiative',
    explain: 'Attacking into the opponent’s attack as it begins — after they have committed but before it lands.',
    hindi: null,
    see: ['go-no-sen', 'tai-no-sen'],
  }),
  'tai-no-sen': D({
    romaji: 'Tai-no-sen',
    kanji: '対の先',
    english: 'Simultaneous initiative',
    explain: 'Meeting the attack at the same moment it is launched, so both techniques travel together and the better structure wins.',
    hindi: null,
    see: ['sen-no-sen', 'go-no-sen'],
  }),
  'gohon-kumite': D({
    romaji: 'Gohon kumite',
    kanji: '五本組手',
    english: 'Five-step sparring',
    explain: 'Five prearranged attacks, five blocks, then one counter. The first partner exercise, and the one that teaches distance under a known attack.',
    hindi: null,
    see: ['sanbon-kumite', 'kihon-ippon-kumite'],
  }),
  'sanbon-kumite': D({
    romaji: 'Sanbon kumite',
    kanji: '三本組手',
    english: 'Three-step sparring',
    explain: 'The same exercise as gohon kumite over three steps, usually with the attacks varying in level.',
    hindi: null,
    see: ['gohon-kumite'],
  }),
  'kihon-ippon-kumite': D({
    romaji: 'Kihon ippon kumite',
    kanji: '基本一本組手',
    english: 'Basic one-step sparring',
    explain: 'A single announced attack, blocked and countered. Everything is known except the timing, which is the whole exercise.',
    hindi: null,
    see: ['jiyu-ippon-kumite'],
  }),
  'jiyu-ippon-kumite': D({
    romaji: 'Jiyu ippon kumite',
    kanji: '自由一本組手',
    english: 'Semi-free one-step sparring',
    explain: 'One announced attack, from free-fighting distance and guard, with both partners moving. The bridge between prearranged practice and free fighting.',
    hindi: null,
    see: ['kihon-ippon-kumite', 'jiyu-kumite'],
  }),
  'jiyu-kumite': D({
    romaji: 'Jiyu kumite',
    kanji: '自由組手',
    english: 'Free sparring',
    explain: 'Free practice with neither attack nor defence prearranged. Not the same thing as competition, which adds rules, scoring and a referee.',
    hindi: null,
    see: ['shiai-kumite', 'jiyu-ippon-kumite'],
  }),
  'shiai-kumite': D({
    romaji: 'Shiai kumite',
    kanji: '試合組手',
    english: 'Competition sparring',
    explain: 'Sparring under a competition rule set, in front of officials, for a result. The rules are versioned and change; nothing about them is permanent.',
    hindi: null,
    see: ['jiyu-kumite'],
  }),
};

// ─── Lookups ────────────────────────────────────────────────────────────────

export interface ResolvedTerm extends Term {
  key: string;
}

/** A Map, not an object literal — `__proto__` is a real slug-shaped hazard. */
const BY_KEY = new Map<string, ResolvedTerm>(
  Object.entries(TERMS).map(([key, t]) => [key, { ...t, key }])
);

export function term(key: string | null | undefined): ResolvedTerm | null {
  if (!key) return null;
  return BY_KEY.get(key.toLowerCase()) ?? null;
}

/** Resolve a list of keys, silently dropping any that do not exist. */
export function terms(keys: readonly string[]): ResolvedTerm[] {
  return keys.map((k) => term(k)).filter((t): t is ResolvedTerm => t !== null);
}

export function allTerms(): ResolvedTerm[] {
  return [...BY_KEY.values()].sort((a, b) => a.romaji.localeCompare(b.romaji));
}

/** Terms with a Hindi rendering. Used by the glossary surface to group them. */
export function termsWithHindi(): ResolvedTerm[] {
  return allTerms().filter((t) => t.hindi !== null);
}

export function familyByKey(key: KihonFamily) {
  return KIHON_FAMILIES.find((f) => f.key === key) ?? null;
}
