/**
 * The Shotokan kata library.
 *
 * WHAT THIS FILE IS ALLOWED TO SAY, AND WHAT IT IS NOT
 * ───────────────────────────────────────────────────
 * The Shotokan canon is public martial-arts knowledge. The names, the kanji,
 * the Okinawan names Funakoshi renamed them from, the shape of each form and
 * the vocabulary a student meets in it are not MMAKF claims and are written
 * here at length.
 *
 * A SYLLABUS IS NOT. MMAKF has not published which form it examines at which
 * grade, and inventing one is the single failure this project treats as
 * unforgivable — it would put words in the federation's mouth about the one
 * thing members actually plan their training around. So every entry carries a
 * `gradeAssociation` FIELD and every entry leaves it null. The field exists so
 * that the day the federation publishes its syllabus it is filled in, not
 * designed; the null is the honest current state and the surfaces render it as
 * an absence they name out loud.
 *
 * THREE MORE RULES THIS FILE ENFORCES ON ITSELF
 *
 *  1. A NUMBER IS PUBLISHED ONLY WHERE IT IS SETTLED. Movement counts and kiai
 *     points are conventions, and they are not identical in every Shotokan
 *     organisation. Where the JKA-line figure is the one everybody prints, it
 *     is here. Where it is genuinely disputed or I could not stand behind it,
 *     the field is null and the page says nothing rather than inventing a
 *     precision the art does not have. `kiai` is null far more often than
 *     `movements` for exactly that reason.
 *
 *  2. A VIDEO SHIPS ONLY WITH THE EVIDENCE OF ITS CHECK. An earlier agent on
 *     this project published a link recording evidence it never gathered, so a
 *     video here carries the id, the channel it actually resolved to, the date
 *     it was checked and the METHOD. See FEDERATION_KATA_FOOTAGE, and see
 *     VIDEO_POSITION for why no kata carries a per-kata recording today.
 *
 *  3. THE VOCABULARY IS DEFINED ONCE. Twenty-six kata that each explain
 *     `kokutsu-dachi` in their own words end up explaining it three different
 *     ways, and the reader learning from the library is the one who pays.
 *     TERMS is the single definition; a kata references it by key.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** A word of Japanese a student meets on the floor, translated AND explained. */
export interface Term {
  /** Hyphenated ASCII romaji. The object key is this, lowercased. */
  romaji: string;
  /** The characters, where they are certain. Null rather than romaji-in-disguise. */
  kanji: string | null;
  /** The short English rendering. A translation. */
  english: string;
  /**
   * What it actually is. The federation asked for the terms EXPLAINED, and
   * "kokutsu-dachi = back stance" tells a beginner nothing about where the
   * weight goes or what the stance is for.
   */
  explain: string;
}

export interface ResolvedTerm extends Term {
  key: string;
}

/**
 * Where the syllabus goes when MMAKF publishes one.
 *
 * Declared and unused on purpose. A reader of this type can see exactly what
 * the federation still has to decide, and a future contributor fills a field
 * in rather than inventing a shape under deadline.
 */
export interface GradeAssociation {
  /** The grade MMAKF examines this form at, in the federation's own words. */
  grade: string;
  /** The federation document it was taken from. Never inferred from practice. */
  source: string;
  /** ISO date the federation published it. */
  publishedOn: string;
}

/** A recording, with the proof that somebody actually loaded it. */
export interface VerifiedVideo {
  youtubeId: string;
  title: string;
  channel: string;
  channelUrl: string;
  /** ISO date of the check. */
  verifiedOn: string;
  /** HOW it was checked, in enough detail to be repeated or disbelieved. */
  verifiedBy: string;
}

export interface Kata {
  slug: string;
  name: string;
  /** Characters only, or null. Romaji in this field would be a false claim. */
  kanji: string | null;
  meaning: string;
  /** The Okinawan name Funakoshi renamed it from, where it had one. */
  formerName: string | null;
  series: 'Heian' | 'Tekki' | null;
  /** JKA-line convention. Null where the count is genuinely disputed. */
  movements: number | null;
  /** Movement numbers carrying a kiai, ascending. Null where not standard. */
  kiai: readonly number[] | null;
  /** What the form is and what training it does to you. Prose, not a stub. */
  character: string;
  /** Concrete attributes the form builds. */
  develops: readonly string[];
  /** Keys into TERMS. Order is the order the page prints them in. */
  terms: readonly string[];
  /** Empty until MMAKF publishes a syllabus. See the header of this file. */
  gradeAssociation: GradeAssociation | null;
  /** Null unless a recording has been checked and its evidence attached. */
  video: VerifiedVideo | null;
  /** An honest caveat about this specific form, or null. */
  note: string | null;
}

// ─── The vocabulary ─────────────────────────────────────────────────────────

/**
 * Every term is reachable from at least one kata, and no kata may reference a
 * term that is not here — both directions are enforced by tests/kata.test.ts.
 * An orphan entry is a definition no reader can ever arrive at, and a dangling
 * key is a blank row in the middle of a lesson.
 */
export const TERMS: Record<string, Term> = {
  // ── Stances ──
  'zenkutsu-dachi': {
    romaji: 'zenkutsu-dachi',
    kanji: '前屈立ち',
    english: 'front stance',
    explain:
      'The long forward stance: front knee bent over the toes, back leg straight, roughly seventy per cent of the weight on the front foot. It is the stance that lets a technique carry the whole body behind it, and the reason the first kata a student learns is mostly walking.',
  },
  'kokutsu-dachi': {
    romaji: 'kokutsu-dachi',
    kanji: '後屈立ち',
    english: 'back stance',
    explain:
      'Weight sits back — around seventy per cent on the rear leg — with the feet at right angles and the hips half-facing. It is a receiving stance: the body is already withdrawn, so a block can meet an attack without the defender having to retreat first, and the front foot is light enough to kick with.',
  },
  'kiba-dachi': {
    romaji: 'kiba-dachi',
    kanji: '騎馬立ち',
    english: 'horse-riding stance',
    explain:
      'Feet parallel and roughly twice shoulder width, knees pushed outward, weight even, back vertical. It is punishing to hold and that is the training effect: it builds the hip and thigh strength that everything else borrows from, and it teaches the student to generate power sideways rather than only forward.',
  },
  'neko-ashi-dachi': {
    romaji: 'neko-ashi-dachi',
    kanji: '猫足立ち',
    english: 'cat-foot stance',
    explain:
      'Almost all the weight on the rear leg, the front foot resting on the ball with the heel lifted, like a cat about to move. It carries no weight on the front foot at all, which is what makes it the fastest stance to kick or step from and the hardest one to balance in.',
  },
  'fudo-dachi': {
    romaji: 'fudo-dachi',
    kanji: '不動立ち',
    english: 'immovable, rooted stance',
    explain:
      'A hybrid of the front and horse stances: the length of one, the width and even weighting of the other, hips squared and knees driven out. It is meant to be unshiftable, and the kata built around it are the ones that ask for settled power rather than speed.',
  },
  'hangetsu-dachi': {
    romaji: 'hangetsu-dachi',
    kanji: '半月立ち',
    english: 'half-moon stance',
    explain:
      'A shorter, narrower front stance with the knees squeezed inward and the feet turned in. Stepping in it traces a crescent on the floor, which is where the name comes from, and it protects the inside of the legs while the tension itself becomes part of the exercise.',
  },
  'kosa-dachi': {
    romaji: 'kosa-dachi',
    kanji: '交差立ち',
    english: 'crossed-feet stance',
    explain:
      'One leg crossed behind or in front of the other, feet close, knees bent and the body compressed. It is a transitional shape rather than a place to live: kata use it to land a jump, to cover ground quickly, or to wind the hips up for the technique that follows.',
  },
  'heisoku-dachi': {
    romaji: 'heisoku-dachi',
    kanji: '閉足立ち',
    english: 'closed-foot stance',
    explain:
      'Feet together and parallel, legs straight, weight even. It appears at the start and end of several kata and between sequences, and its job is stillness — it gives the performer nowhere to hide a wobble, so it is where composure is visibly either present or not.',
  },
  'tsuru-ashi-dachi': {
    romaji: 'tsuru-ashi-dachi',
    kanji: '鶴足立ち',
    english: 'crane-leg stance',
    explain:
      'The whole body balanced on one leg, the other folded up with the foot tucked behind the supporting knee. It is a loaded spring rather than a pose: the folded leg is already in position to kick, and the balance it demands is the reason it is the signature image of the kata that uses it.',
  },

  // ── Blocks and receiving techniques ──
  'gedan-barai': {
    romaji: 'gedan-barai',
    kanji: '下段払い',
    english: 'downward sweep',
    explain:
      'The forearm sweeps down and across to clear an attack to the lower body, finishing just above the front thigh. It is the first block most students learn and it is a sweep rather than a stop — the arm brushes the attack off its line instead of meeting it head on.',
  },
  'age-uke': {
    romaji: 'age-uke',
    kanji: '上げ受け',
    english: 'rising block',
    explain:
      'The forearm rises in front of the face and rotates so the outer edge takes the impact, deflecting a strike upward and over the head. The rotation is the whole technique: an arm raised without it stops the attack with bone rather than deflecting it away.',
  },
  'soto-uke': {
    romaji: 'soto-uke',
    kanji: '外受け',
    english: 'outside block',
    explain:
      'The forearm travels from outside the body inward across the chest, meeting an attack on its outer side and turning it across the opponent. The elbow stays low and bent, so the block ends in a position from which the same arm can immediately strike.',
  },
  'uchi-uke': {
    romaji: 'uchi-uke',
    kanji: '内受け',
    english: 'inside block',
    explain:
      'The mirror of the outside block: the forearm sweeps from inside the body outward, taking the attack on the inner side and opening the opponent up. Beginners regularly swap the two names, and the way to keep them straight is to name the direction the arm travels, not where it ends.',
  },
  'shuto-uke': {
    romaji: 'shuto-uke',
    kanji: '手刀受け',
    english: 'knife-hand block',
    explain:
      'An open hand, fingers together and thumb folded in, striking or receiving with the muscled edge below the little finger. Almost always performed in the back stance, it is a block that is already a strike, which is why so many kata use it to turn a corner.',
  },
  'morote-uke': {
    romaji: 'morote-uke',
    kanji: '諸手受け',
    english: 'augmented block',
    explain:
      'An inside block backed up by the other fist pressed against the blocking forearm, so two arms carry one technique. It buys strength at the cost of reach, and kata use it against attacks too heavy to turn with one arm alone.',
  },
  'juji-uke': {
    romaji: 'juji-uke',
    kanji: '十字受け',
    english: 'cross block',
    explain:
      'Both arms crossed at the wrists in the shape of the character for ten, catching a kick or a strike in the X they make. Because both hands finish in one place, the technique that usually follows is a grab, and several kata make that continuation explicit.',
  },
  'manji-uke': {
    romaji: 'manji-uke',
    kanji: '卍受け',
    english: 'double block, one arm high and one low',
    explain:
      'One arm blocks upward behind the head while the other sweeps low in front, the body turned side-on between them. It covers two levels at once and, held at the end of a sequence, it is as much a statement of readiness as a defence.',
  },
  'kakiwake-uke': {
    romaji: 'kakiwake-uke',
    kanji: '掻き分け受け',
    english: 'wedge block',
    explain:
      'Both wrists cross in front of the chest and then drive apart, forcing a two-handed grab or a lapel grip open from the inside. It is one of the few techniques whose application is unmistakable the moment somebody grabs you and you do it.',
  },
  'keito-uke': {
    romaji: 'keito-uke',
    kanji: '鶏頭受け',
    english: 'chicken-head wrist block',
    explain:
      'The hand bent sharply at the wrist so the bony ridge on the thumb side leads, shaped like a bird head. It is used to hook and lift an attacking arm rather than to stop it, and it demands a wrist that has been conditioned for the angle.',
  },
  'haishu-uke': {
    romaji: 'haishu-uke',
    kanji: '背手受け',
    english: 'back-hand block',
    explain:
      'An open hand receiving with the back of the palm, light and fast rather than strong. It suits deflecting a jab or a grasping hand, and because it does not commit the arm it leaves the same hand free to trap immediately afterwards.',
  },
  'osae-uke': {
    romaji: 'osae-uke',
    kanji: '押さえ受け',
    english: 'pressing block',
    explain:
      'The palm presses an attacking arm downward and pins it rather than knocking it aside. Nothing is struck; the point is to take away the opponent line of attack and keep it taken while the other hand does the work.',
  },

  // ── Punches and hand strikes ──
  'oi-zuki': {
    romaji: 'oi-zuki',
    kanji: '追い突き',
    english: 'lunge punch',
    explain:
      'Stepping forward and punching with the hand on the same side as the advancing foot, so the whole body mass travels into the target. Getting the arm and the leg to arrive together, rather than the punch chasing the step, is most of the first year of training.',
  },
  'gyaku-zuki': {
    romaji: 'gyaku-zuki',
    kanji: '逆突き',
    english: 'reverse punch',
    explain:
      'Punching with the hand opposite the forward leg, driven by rotating the hips. It is the most-used scoring technique in karate because the hips can turn faster than the feet can step, and the power comes from that rotation rather than from the arm.',
  },
  'kagi-zuki': {
    romaji: 'kagi-zuki',
    kanji: '鉤突き',
    english: 'hook punch',
    explain:
      'A short punch across the front of the body with the elbow bent, thrown to the side rather than the front. It exists for an opponent who is already too close to straighten an arm at, which is why it belongs to the kata performed entirely in the horse stance.',
  },
  'uraken-uchi': {
    romaji: 'uraken-uchi',
    kanji: '裏拳打ち',
    english: 'back-fist strike',
    explain:
      'A whipping strike with the back of the first two knuckles, the elbow acting as the hinge. It travels the shortest distance of any hand technique and returns as fast as it goes, which is why kata use it against the face and then continue as though nothing happened.',
  },
  'tettsui-uchi': {
    romaji: 'tettsui-uchi',
    kanji: '鉄槌打ち',
    english: 'hammer-fist strike',
    explain:
      'The fleshy bottom edge of the closed fist swung like a hammer. It is the safest heavy strike in the art for the hand that throws it, because nothing lands on the knuckles, and it is often the technique kata choose to break a grip with.',
  },
  'empi-uchi': {
    romaji: 'empi-uchi',
    kanji: '肘打ち',
    english: 'elbow strike',
    explain:
      'A strike with the point of the elbow, forward, upward, sideways or backward. It is the hardest weapon on the body and it only works in close, so a kata that uses one is telling you the distance the sequence is imagining.',
  },
  'nukite': {
    romaji: 'nukite',
    kanji: '貫手',
    english: 'spear hand',
    explain:
      'A thrust with the straightened fingertips, the middle finger bent slightly so all three land level. It is aimed at soft targets only, and it is the technique that most punishes a hand that has not been conditioned, which is why kata drill it slowly.',
  },
  'nihon-nukite': {
    romaji: 'nihon-nukite',
    kanji: '二本貫手',
    english: 'two-finger spear hand',
    explain:
      'A thrust with the index and middle fingers, aimed at the eyes. It is one of the few unmistakably lethal-intent techniques left visible in the canon, and it is the reason the kata carrying it has a reputation for being older and less sanitised than its neighbours.',
  },
  'haito-uchi': {
    romaji: 'haito-uchi',
    kanji: '背刀打ち',
    english: 'ridge-hand strike',
    explain:
      'An open-hand strike with the inner edge, the thumb tucked underneath, swung in a wide arc from outside to inside. The wide path is the point: it comes around a guard rather than through it, and it needs the whole shoulder to be worth throwing.',
  },
  'teisho-uchi': {
    romaji: 'teisho-uchi',
    kanji: '底掌打ち',
    english: 'palm-heel strike',
    explain:
      'A thrust with the heel of the palm, fingers pulled back out of the way. It delivers most of the force of a punch with none of the risk to the small bones of the hand, and it doubles as a press or a push, which is why kata use it to unbalance as well as to strike.',
  },
  'ippon-ken': {
    romaji: 'ippon-ken',
    kanji: '一本拳',
    english: 'one-knuckle fist',
    explain:
      'The fist closed with one knuckle — usually the index — pushed forward and braced by the thumb, concentrating the whole strike into a single point. It needs a supported wrist and a specific target, and it is a technique the advanced kata assume you have earned.',
  },

  // ── Kicks and leg techniques ──
  'mae-geri': {
    romaji: 'mae-geri',
    kanji: '前蹴り',
    english: 'front kick',
    explain:
      'The knee lifts first, then the lower leg snaps out and returns along the same path, striking with the ball of the foot. Lifting the knee before extending is what makes it a kick rather than a swing, and it is the first kick every student is taught for that reason.',
  },
  'yoko-geri-keage': {
    romaji: 'yoko-geri-keage',
    kanji: '横蹴り蹴上げ',
    english: 'side snap kick',
    explain:
      'A sideways kick that snaps up and out with the edge of the foot and is pulled straight back. It is quick and light rather than heavy, aimed at whatever is exposed on the way past, and it is usually paired in kata with a back-fist to the same side.',
  },
  'yoko-geri-kekomi': {
    romaji: 'yoko-geri-kekomi',
    kanji: '横蹴り蹴込み',
    english: 'side thrust kick',
    explain:
      'The same sideways line as the snap kick, but driven through the target with the hip behind it and the heel leading. Snap and thrust look similar and do completely different jobs, and telling them apart in a kata is one of the first things an examiner watches for.',
  },
  'mawashi-geri': {
    romaji: 'mawashi-geri',
    kanji: '回し蹴り',
    english: 'roundhouse kick',
    explain:
      'The knee is raised to the side and the lower leg whips horizontally into the target as the supporting foot pivots. The pivot is what turns it from a leg swing into a technique, and without it the hip cannot follow the foot.',
  },
  'mikazuki-geri': {
    romaji: 'mikazuki-geri',
    kanji: '三日月蹴り',
    english: 'crescent kick',
    explain:
      'The foot travels in an arc across the body, striking with the sole. In kata it usually lands in the opposite palm, which is not decoration: the palm is the target being represented, and the sound it makes is the audible proof the kick arrived where it was aimed.',
  },
  'fumikomi': {
    romaji: 'fumikomi',
    kanji: '踏み込み',
    english: 'stamping kick',
    explain:
      'A downward stamp with the edge or heel of the foot onto a knee, shin or instep, usually while stepping into the horse stance. It is short, low and unglamorous, and it is the technique that explains why several kata drop suddenly into a wide low stance.',
  },
  'hiza-geri': {
    romaji: 'hiza-geri',
    kanji: '膝蹴り',
    english: 'knee strike',
    explain:
      'A strike with the point of the knee, driven upward. In kata it is nearly always accompanied by both hands pulling downward, which tells you the application: the head or the arm is being brought onto the knee rather than the knee travelling to find it.',
  },
  'nami-gaeshi': {
    romaji: 'nami-gaeshi',
    kanji: '波返し',
    english: 'returning wave',
    explain:
      'The foot snaps up and inward across the front of the standing leg and returns, like a wave breaking back. It is read as blocking a kick to the shin or the groin without moving the stance, and it is the movement that makes the horse-stance kata unmistakable.',
  },

  // ── Concepts a student meets on the floor ──
  'embusen': {
    romaji: 'embusen',
    kanji: '演武線',
    english: 'performance line',
    explain:
      'The floor pattern a kata travels — the map of every step, turn and direction change. A performer who finishes away from where they began has lost ground somewhere, and because the pattern is fixed, the kata itself reports the error without anyone having to point it out.',
  },
  'kiai': {
    romaji: 'kiai',
    kanji: '気合',
    english: 'spirit shout',
    explain:
      'A sharp shout from the abdomen at the moment of a decisive technique. It tightens the middle, empties the lungs so a counter cannot wind you, and marks the point the kata considers its own climax — which is why the kiai points are worth knowing before you learn the moves.',
  },
  'kime': {
    romaji: 'kime',
    kanji: '決め',
    english: 'focus',
    explain:
      'The instantaneous tightening of the whole body at the end of a technique, followed immediately by release. It is what makes a karate technique stop dead rather than push, and a kata performed without it looks like a dance no matter how correct the shapes are.',
  },
  'zanshin': {
    romaji: 'zanshin',
    kanji: '残心',
    english: 'remaining mind',
    explain:
      'The alertness that continues after a technique finishes and after the kata ends — the attention that has not yet been put away. It is the difference between finishing a kata and stopping one, and it is the quality most visible from the back of a hall.',
  },
  'hikite': {
    romaji: 'hikite',
    kanji: '引き手',
    english: 'drawing hand',
    explain:
      'The hand pulled sharply back to the hip as the other one strikes. It is not a resting position: the pull is half the power of the punch, and in application it is usually holding an arm, a wrist or a garment that is being dragged onto the strike.',
  },
  'kamae': {
    romaji: 'kamae',
    kanji: '構え',
    english: 'ready posture',
    explain:
      'A deliberate posture taken up before or between techniques, hands and stance already arranged for what is coming. Kata open with one, and the pause it creates is not empty time — it is the moment the performer states the distance and the intention.',
  },
  'bunkai': {
    romaji: 'bunkai',
    kanji: '分解',
    english: 'analysis of application',
    explain:
      'Taking a kata apart to work out what each movement is actually doing against a real opponent, then practising it with a partner. Without it a kata is choreography; with it, a sequence that looked ornamental usually turns out to be a grip break and a throw.',
  },
  'kokyu': {
    romaji: 'kokyu',
    kanji: '呼吸',
    english: 'breathing',
    explain:
      'The deliberate coordination of breath with movement — out on the technique, in on the withdrawal, and audibly under tension in some kata. It is taught as an explicit subject rather than left to instinct, because breath held under effort is what makes a performer fall apart at the end.',
  },
  'chudan': {
    romaji: 'chudan',
    kanji: '中段',
    english: 'middle level',
    explain:
      'The middle of the three target heights, roughly the chest and stomach. Karate names the level rather than the anatomy, so one word tells you the height of both the attack and the defence, and most kata terminology is built from that pairing.',
  },
  'jodan': {
    romaji: 'jodan',
    kanji: '上段',
    english: 'upper level',
    explain:
      'The upper of the three target heights — the head and neck. Naming it separately matters because the same technique performed at a different level is treated as a different technique, with its own name and its own defence.',
  },
  'gedan': {
    romaji: 'gedan',
    kanji: '下段',
    english: 'lower level',
    explain:
      'The lowest of the three target heights, below the belt. It is the level most kata begin at, since the opening block of the canon clears an attack to exactly this height before anything else happens.',
  },
  'bo-dori': {
    romaji: 'bo-dori',
    kanji: '棒取り',
    english: 'staff-taking',
    explain:
      'A sequence read as disarming an opponent holding a long staff — trapping it, levering it and taking it away. Two kata in the canon carry sequences that are widely interpreted this way, which is a reminder that these forms predate the idea that karate is unarmed by definition.',
  },
};

// ─── The canon ──────────────────────────────────────────────────────────────

/**
 * Movement counts follow the convention published in the JKA line, which is
 * what most Shotokan students will have been taught. THEY ARE NOT UNIVERSAL —
 * organisations count preparatory motions and combined techniques differently,
 * so a student trained elsewhere may know the same form by a different number.
 * The surfaces state this in the reader's face rather than in a footnote.
 */
export const MOVEMENT_COUNT_NOTE =
  'Movement counts and kiai points follow the convention most widely published in the Shotokan mainstream. They vary between organisations, which count preparatory and combined motions differently — treat them as a description of the form, not as a ruling.';

/**
 * Why not one video per kata.
 *
 * MMAKF's own channels carry kata TRAINING footage and no per-kata
 * performances, so there is nothing federation-made to attach to Heian Nidan.
 * The alternative was to link a stranger's recording and present it as the
 * kata's video. That was rejected twice over: it would assert that a video I
 * cannot watch shows the form correctly, and it would republish somebody
 * else's footage as federation content, which src/lib/youtube.ts already
 * refuses to do on the grounds that relevance is not permission.
 *
 * Checking the obvious candidate proved the point. `youtube.com/@JKAHQ`
 * returns HTTP 200 and belongs to a channel called "Iron Man" — the same
 * soft-404 trap the regulations link checker exists to catch.
 */
export const VIDEO_POSITION =
  "MMAKF has not recorded a performance of each kata, and this library will not present another organisation's video as the federation's. Where the federation's own kata footage exists it is published below, described as what it is: training, not a performance of any single form.";

const K = (k: Kata): Kata => k;

export const KATA: readonly Kata[] = [
  K({
    slug: 'heian-shodan',
    name: 'Heian Shodan',
    kanji: '平安初段',
    meaning: 'Peaceful mind, first level',
    formerName: 'Pinan Shodan',
    series: 'Heian',
    movements: 21,
    kiai: [9, 17],
    character:
      'The simplest form in the canon and the plainest statement of what Shotokan is. It walks an I-shaped floor pattern on one idea repeated: turn, clear the low line, step, punch. Almost every movement is a downward sweep or a lunge punch, which is deliberate — Itosu composed the series to make a demanding art teachable, and this form asks the body to learn one thing at a time. The back-stance knife-hand sequence at the end is the first glimpse of everything that comes later.',
    develops: [
      'Stepping in a long front stance without rising or dropping between steps',
      'The link between the drawing hand and the striking hand, which is the source of the power',
      'Turning to a new direction without losing the stance in the turn',
      'The habit of finishing exactly where the form began',
    ],
    terms: ['zenkutsu-dachi', 'gedan-barai', 'oi-zuki', 'tettsui-uchi', 'age-uke', 'kokutsu-dachi', 'shuto-uke', 'hikite', 'gedan', 'embusen', 'kiai'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'heian-nidan',
    name: 'Heian Nidan',
    kanji: '平安二段',
    meaning: 'Peaceful mind, second level',
    formerName: 'Pinan Nidan',
    series: 'Heian',
    movements: 26,
    kiai: [11, 26],
    character:
      'Where the series stops walking and starts working. The opening sequence blocks high and low with both arms at once, and the form then adds the first kick, the first back-fist and the first spear hand. Its long back-stance passages ask for something the plainer first form never did: the ability to hold a receiving posture while the hands do two different jobs. In Itosu original ordering this form came first, and it shows — it is noticeably the more complete of the two.',
    develops: [
      'Coordinating two arms performing different techniques in one movement',
      'The side snap kick delivered from a stable base rather than a lean',
      'Holding the back stance through a long sequence without creeping forward',
      'Changing level between the head and the body without changing rhythm',
    ],
    terms: ['kokutsu-dachi', 'shuto-uke', 'yoko-geri-keage', 'uraken-uchi', 'nukite', 'uchi-uke', 'zenkutsu-dachi', 'chudan', 'jodan'],
    gradeAssociation: null,
    video: null,
    note: 'Funakoshi reversed the order of the first two forms of the series when he brought it from Okinawa, so the numbering here does not match the order in which the two were composed.',
  }),
  K({
    slug: 'heian-sandan',
    name: 'Heian Sandan',
    kanji: '平安三段',
    meaning: 'Peaceful mind, third level',
    formerName: 'Pinan Sandan',
    series: 'Heian',
    movements: 20,
    kiai: [10, 20],
    character:
      'The shortest of the five and the one that changes character halfway through. It opens with compact paired blocks in the back stance, close-quarters work with almost no travel, and then drops into the horse stance for a run of hammer-fist and elbow techniques delivered sideways. That switch is the lesson: power does not only come from moving forward, and a form that has spent its first half receiving can turn and deliver without a run-up.',
    develops: [
      'Generating power sideways from the horse stance rather than forward from the front stance',
      'Close-range blocking where there is no room to step away',
      'The stamping entry, which teaches the feet to take ground rather than approach it',
      'Composure in a form that reverses direction twice in twenty movements',
    ],
    terms: ['heisoku-dachi', 'kokutsu-dachi', 'uchi-uke', 'kiba-dachi', 'tettsui-uchi', 'empi-uchi', 'fumikomi', 'zanshin'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'heian-yondan',
    name: 'Heian Yondan',
    kanji: '平安四段',
    meaning: 'Peaceful mind, fourth level',
    formerName: 'Pinan Yondan',
    series: 'Heian',
    movements: 27,
    kiai: [13, 25],
    character:
      'The longest and the most obviously combative of the five. It opens slowly with wide two-handed blocks and then accelerates into kicks paired with back-fists, a wedge block that breaks a two-handed grip, and a closing sequence in which both hands pull down while the knee drives up. That last movement is the point at which the series stops being an exercise in shapes: nothing about it makes sense until somebody explains that the hands are holding a head.',
    develops: [
      'Contrast of speed — deliberately slow openings against explosive combinations',
      'Kicking and striking as one movement rather than two in sequence',
      'Breaking a grab from the inside using both arms together',
      'Pulling and striking simultaneously, which is the principle underneath the whole style',
    ],
    terms: ['kokutsu-dachi', 'shuto-uke', 'yoko-geri-keage', 'uraken-uchi', 'kakiwake-uke', 'mae-geri', 'empi-uchi', 'hiza-geri', 'zenkutsu-dachi'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'heian-godan',
    name: 'Heian Godan',
    kanji: '平安五段',
    meaning: 'Peaceful mind, fifth level',
    formerName: 'Pinan Godan',
    series: 'Heian',
    movements: 23,
    kiai: [12, 19],
    character:
      'The last of the series and the one that introduces leaving the ground. A cross block catches a kick, the hands close on it, and a few movements later the form jumps, lands with the legs crossed and finishes in a wide two-level posture held long enough to be looked at. It also contains a crescent kick into the opposite palm, so the performer hears whether the kick arrived where it was aimed. It is a compact form that behaves like a much longer one.',
    develops: [
      'Jumping and landing under control, without a heavy or noisy landing',
      'Catching and holding rather than only deflecting',
      'Defending two levels at once and holding the finished posture with presence',
      'Accuracy made audible, through a kick that must strike the waiting palm',
    ],
    terms: ['kokutsu-dachi', 'uchi-uke', 'gyaku-zuki', 'juji-uke', 'kosa-dachi', 'manji-uke', 'mikazuki-geri', 'zanshin'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'tekki-shodan',
    name: 'Tekki Shodan',
    kanji: '鉄騎初段',
    meaning: 'Iron horse, first level',
    formerName: 'Naihanchi',
    series: 'Tekki',
    movements: 29,
    kiai: [15, 29],
    character:
      'Performed entirely in the horse stance, travelling only sideways along a single straight line. There is no forward step and no long stance anywhere in it, which makes it the strangest-looking form in the canon and the most physically demanding to hold. The old reading is that it teaches fighting with the back to a wall or on the narrow ridge of a rice field; the modern reading is that it teaches the hips. Funakoshi reportedly spent years on this form alone before being permitted another.',
    develops: [
      'Hip and thigh strength, from a stance that never lets the legs rest',
      'Power generated sideways, with no room to step into a technique',
      'Close-quarters hand work — hooking punches and elbows thrown inside arm length',
      'Defending the legs without moving the feet, through the returning-wave motion',
    ],
    terms: ['kiba-dachi', 'nami-gaeshi', 'kagi-zuki', 'uraken-uchi', 'hikite', 'embusen'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'tekki-nidan',
    name: 'Tekki Nidan',
    kanji: '鉄騎二段',
    meaning: 'Iron horse, second level',
    formerName: 'Naihanchi',
    series: 'Tekki',
    movements: 24,
    kiai: [16, 24],
    character:
      'The second of the horse-stance series, and the one most people find harder than its length suggests. It keeps the straight-line floor pattern and the single stance, but replaces much of the first form arm work with sequences that begin with the hands already in contact — hooking, pressing and pulling before striking. The techniques are smaller and the margin for hiding a weak stance is smaller with them.',
    develops: [
      'Working from contact rather than from distance',
      'Endurance in a stance the form never releases',
      'Precision in short techniques, where a large motion would simply be wrong',
      'Reading a sequence as grappling rather than as blocking',
    ],
    terms: ['kiba-dachi', 'nami-gaeshi', 'kagi-zuki', 'uchi-uke', 'hikite', 'kime'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'tekki-sandan',
    name: 'Tekki Sandan',
    kanji: '鉄騎三段',
    meaning: 'Iron horse, third level',
    formerName: 'Naihanchi',
    series: 'Tekki',
    movements: 36,
    kiai: [16, 36],
    character:
      'The longest and densest of the three, packing more technique into the same straight line and the same single stance than either of the others. Blocks arrive in rapid paired sequences with almost no travel between them, and the form demands that the hips keep supplying power at a tempo that leaves no room to reset. It is the form that shows whether the horse stance has actually become strong or has merely become familiar.',
    develops: [
      'Sustained tempo — many techniques in succession with no recovery step',
      'Independent arm work, with each arm on its own task',
      'Rooted stability under fatigue, late in a long sequence',
      'Focus at the end of each technique rather than at the end of each phrase',
    ],
    terms: ['kiba-dachi', 'nami-gaeshi', 'uchi-uke', 'gedan-barai', 'kagi-zuki', 'kime'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'bassai-dai',
    name: 'Bassai Dai',
    kanji: '抜塞大',
    meaning: 'To storm a fortress, major',
    formerName: 'Passai',
    series: null,
    movements: 42,
    kiai: [19, 42],
    character:
      'A form about reversal. The name is usually rendered as breaking into a fortress, and the whole shape of it is a fighter with the disadvantage repeatedly turning the position around: blocks that become attacks, a defence that changes from one arm to the other without conceding ground, hips that switch the direction of a technique halfway through. It opens with one of the most recognisable movements in karate, a driving entry from a crossed-feet posture straight into a heavy inside block.',
    develops: [
      'Changing a technique from defence to attack without an extra movement',
      'Hip rotation as the thing that switches a block from one side to the other',
      'Committed forward entry against a stronger opponent',
      'Sustained power across a long form without the technique shrinking',
    ],
    terms: ['kamae', 'kosa-dachi', 'uchi-uke', 'soto-uke', 'shuto-uke', 'yoko-geri-kekomi', 'tettsui-uchi', 'gedan-barai', 'zenkutsu-dachi', 'kime'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'bassai-sho',
    name: 'Bassai Sho',
    kanji: '抜塞小',
    meaning: 'To storm a fortress, minor',
    formerName: 'Passai',
    series: null,
    movements: 27,
    kiai: null,
    character:
      'The shorter companion form, and not simply an abbreviation. It shares the floor pattern and the family resemblance but spends much of its length on sequences widely read as taking a staff away from an opponent — trapping it, levering it and turning it. It is lighter and more evasive than its larger namesake, and where that form drives through a position, this one takes the position away.',
    develops: [
      'Deflecting and redirecting rather than meeting force head on',
      'Two-handed trapping, which only makes sense once the application is shown',
      'Lightness and mobility in a form built on the same pattern as a heavier one',
      'Reading old technique as something other than punching and blocking',
    ],
    terms: ['uchi-uke', 'shuto-uke', 'mikazuki-geri', 'tettsui-uchi', 'gedan-barai', 'zenkutsu-dachi', 'bo-dori', 'bunkai'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'kanku-dai',
    name: 'Kanku Dai',
    kanji: '観空大',
    meaning: 'To view the sky, major',
    formerName: 'Kushanku (Kosokun)',
    series: null,
    movements: 65,
    kiai: [15, 45],
    character:
      'The longest of the widely practised forms and, by tradition, Funakoshi favourite. It opens with the hands raised slowly to frame a triangle of sky through the fingers, and then works through nearly the whole vocabulary of the style — every level, every direction, a jump, a drop to the floor and a recovery. Because it contains so much, it is often described as the form in which a student can see the whole art laid out end to end.',
    develops: [
      'Stamina, and technique that does not degrade over sixty-five movements',
      'The full range of levels and directions in one continuous performance',
      'Recovery — dropping to the ground and continuing without a break in rhythm',
      'Pacing, since a form this long cannot be performed at one speed',
    ],
    terms: ['kamae', 'shuto-uke', 'zenkutsu-dachi', 'kokutsu-dachi', 'mae-geri', 'yoko-geri-keage', 'uraken-uchi', 'nukite', 'kosa-dachi', 'embusen', 'kiai'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'kanku-sho',
    name: 'Kanku Sho',
    kanji: '観空小',
    meaning: 'To view the sky, minor',
    formerName: 'Kushanku Sho (Kosokun Sho)',
    series: null,
    movements: 48,
    kiai: null,
    character:
      'The smaller companion, which drops the famous slow opening and starts immediately with augmented blocks against what is read as a staff attack. It is faster and more athletic than the larger form, and it closes with jumping techniques that make it a competition favourite. Where the larger form is a survey, this one is a specialist exercise in defending against a longer weapon and closing the distance afterwards.',
    develops: [
      'Two-armed blocking strong enough to turn a heavier attack',
      'Jumping technique performed with control rather than as a flourish',
      'Speed maintained across a form with very few slow passages',
      'Closing distance immediately after a defence, instead of resetting',
    ],
    terms: ['morote-uke', 'shuto-uke', 'yoko-geri-kekomi', 'uraken-uchi', 'zenkutsu-dachi', 'kokutsu-dachi', 'bo-dori'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'jion',
    name: 'Jion',
    kanji: '慈恩',
    meaning: 'Compassion and kindness; also the name of a Buddhist temple',
    formerName: null,
    series: null,
    movements: 47,
    kiai: [17, 47],
    character:
      'The plainest of the long forms and, for many teachers, the most revealing. It has almost no ornament: strong basic blocks and punches in the front stance along a simple pattern, performed at an even, powerful tempo. There is nowhere to hide in it. A student who can make this form look impressive has genuinely good basics, because there is nothing else in it to be impressive with.',
    develops: [
      'Basic technique performed at full power for a sustained period',
      'Even, deliberate tempo rather than bursts of speed',
      'The wedge block, and what it is actually for',
      'Honest self-assessment, since the form conceals nothing',
    ],
    terms: ['zenkutsu-dachi', 'kokutsu-dachi', 'kakiwake-uke', 'age-uke', 'gyaku-zuki', 'kiba-dachi', 'mae-geri', 'embusen', 'kime'],
    gradeAssociation: null,
    video: null,
    note: 'Three forms in the canon share a temple-derived naming family and a common opening salutation, which is why they are usually taught and discussed together.',
  }),
  K({
    slug: 'jitte',
    name: 'Jitte',
    kanji: '十手',
    meaning: 'Ten hands',
    formerName: null,
    series: null,
    movements: 24,
    kiai: [13, 24],
    character:
      'A short, heavy form whose name is usually read as the claim that a student who masters it can handle ten opponents. It is built on strong horse-stance work and on a closing sequence read almost universally as taking a staff from an attacker and turning it. The techniques are large and slow by comparison with its neighbours, and the form rewards mass and rootedness rather than speed.',
    develops: [
      'Rooted strength, and the ability to receive force without giving ground',
      'Large-frame technique where the whole body commits to one movement',
      'Handling a weapon-length attack at close range',
      'Deliberate pace, holding a technique long enough for it to mean something',
    ],
    terms: ['kiba-dachi', 'zenkutsu-dachi', 'teisho-uchi', 'shuto-uke', 'kokutsu-dachi', 'bo-dori', 'bunkai'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'jiin',
    name: 'Jiin',
    kanji: '慈陰',
    meaning: 'Temple ground; compassionate shade',
    formerName: null,
    series: null,
    movements: 38,
    kiai: null,
    character:
      'The least performed member of the temple family, and unfairly so. It shares the opening salutation and the direct, powerful character of its relatives, but its floor pattern is more angular and its sequences change direction more sharply. It is the form in which a student most often discovers that they have been turning with the shoulders instead of the hips, because the angles do not forgive it.',
    develops: [
      'Sharp changes of angle without losing the line of the form',
      'Turning from the hips, which the pattern exposes immediately',
      'Strong basic blocking sustained across a long sequence',
      'Symmetry, since much of the form repeats to left and right',
    ],
    terms: ['zenkutsu-dachi', 'kokutsu-dachi', 'gedan-barai', 'shuto-uke', 'juji-uke', 'kiba-dachi', 'kime'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'empi',
    name: 'Empi',
    kanji: '燕飛',
    meaning: 'Flying swallow',
    formerName: 'Wanshu',
    series: null,
    movements: 37,
    kiai: [15, 36],
    character:
      'Named for the flight of a swallow, and the name is a description rather than a decoration. The form rises and drops repeatedly — dropping low onto one knee, springing up, turning in the air — so that its height changes as constantly as its direction. It is among the oldest forms in the canon and one of the most distinctive to watch, because almost no other Shotokan form spends so much time leaving and returning to the floor.',
    develops: [
      'Changing height under control, dropping and rising without a stumble',
      'Turning in the air and arriving in a stance already correct',
      'Sudden direction change, which the swallow image is describing literally',
      'Light, quick footwork inside an otherwise heavy style',
    ],
    terms: ['zenkutsu-dachi', 'age-uke', 'tettsui-uchi', 'uraken-uchi', 'kosa-dachi', 'gyaku-zuki', 'zanshin', 'embusen'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'gankaku',
    name: 'Gankaku',
    kanji: '岩鶴',
    meaning: 'Crane on a rock',
    formerName: 'Chinto',
    series: null,
    movements: 42,
    kiai: [28, 42],
    character:
      'The balance form. Its signature posture stands the whole body on one leg with the other folded away, and it returns to that posture repeatedly, each time kicking from it and coming back to it. The image in the name is exact: a crane on a rock, still, on one leg, entirely capable of moving. Most of the form travels along a single line, which removes every opportunity to disguise a balance error by stepping out of it.',
    develops: [
      'One-legged balance held long enough to strike from and return to',
      'Kicking from a base that has no second foot to borrow from',
      'Stillness, since the form asks the performer to stop and be looked at',
      'Ankle and foot strength, which is what balance actually turns out to be',
    ],
    terms: ['tsuru-ashi-dachi', 'yoko-geri-keage', 'uraken-uchi', 'kokutsu-dachi', 'zenkutsu-dachi', 'gedan-barai', 'zanshin', 'kime'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'hangetsu',
    name: 'Hangetsu',
    kanji: '半月',
    meaning: 'Half moon',
    formerName: 'Seishan (Seisan)',
    series: null,
    movements: 41,
    kiai: [11, 40],
    character:
      'The breathing form, and the only one in the Shotokan canon built around its own stance. The first half is performed slowly under continuous muscular tension with the breath deliberately audible, the feet tracing crescents on the floor as they step — which is where both the stance and the form get their name. The second half releases into normal speed. It is unlike anything else in the style, and it is the form that teaches a student that karate has a slow gear.',
    develops: [
      'Breathing coordinated with movement as an explicit discipline',
      'Sustained muscular tension without holding the breath',
      'Inner-leg strength, from a stance that squeezes rather than spreads',
      'Contrast, moving from slow tension into full-speed technique',
    ],
    terms: ['hangetsu-dachi', 'kokyu', 'uchi-uke', 'gyaku-zuki', 'mae-geri', 'teisho-uchi', 'kime'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'chinte',
    name: 'Chinte',
    kanji: '珍手',
    meaning: 'Unusual hand',
    formerName: null,
    series: null,
    movements: 32,
    kiai: null,
    character:
      'The odd one out, and the name says so. It is full of techniques that appear nowhere else in the canon — circular ridge-hand strikes, two-finger thrusts, strikes with the second knuckle — and it ends with three short hops backwards that no other Shotokan form does anything like. The circular, open-handed character has led to it being described as older and less reworked than its neighbours, and it is the form most often left out of a curriculum for exactly that reason.',
    develops: [
      'Circular striking, in a style that is otherwise mostly linear',
      'Open-hand and fingertip technique, and the conditioning it needs',
      'Familiarity with technique that survives nowhere else in the canon',
      'Willingness to perform something that does not look like the rest of the style',
    ],
    terms: ['zenkutsu-dachi', 'haito-uchi', 'nihon-nukite', 'kokutsu-dachi', 'teisho-uchi', 'kiba-dachi'],
    gradeAssociation: null,
    video: null,
    note: 'The closing backward hops are among the most debated movements in the canon; explanations for them differ sharply between organisations, and this library does not pick one.',
  }),
  K({
    slug: 'sochin',
    name: 'Sochin',
    kanji: '壮鎮',
    meaning: 'Strength and calm; tranquil force',
    formerName: null,
    series: null,
    movements: 41,
    kiai: [28, 41],
    character:
      'Built on the rooted stance that shares its name — the length of a front stance with the width and even weighting of a horse stance — and performed with a settled, immovable quality throughout. The name pairs two ideas that sound opposed, strength and calm, and the form is an argument that they are the same thing. It is powerful without being fast, and a performer who rushes it destroys the only quality it has.',
    develops: [
      'Settled, rooted power that does not depend on momentum',
      'Even weight distribution, and the leg strength it costs to hold',
      'Composure — deliberate technique performed without hurry',
      'Driving the hips forward and down rather than only rotating them',
    ],
    terms: ['fudo-dachi', 'kamae', 'gyaku-zuki', 'age-uke', 'mae-geri', 'uchi-uke', 'kime', 'zanshin'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'nijushiho',
    name: 'Nijushiho',
    kanji: '二十四歩',
    meaning: 'Twenty-four steps',
    formerName: 'Niseishi',
    series: null,
    movements: 24,
    kiai: null,
    character:
      'A form about rhythm rather than about any one technique. It repeatedly gathers slowly and then releases in a burst, so the performance is a sequence of accelerations rather than a steady tempo, and much of its striking is done with the palm heel and the elbow at close range. Its name simply counts its movements, which is unusual honesty in a canon full of poetic titles.',
    develops: [
      'Changes of rhythm, gathering and releasing within a single sequence',
      'Close-range striking with the palm heel and the elbow',
      'Flowing, connected movement rather than a series of separate stops',
      'Breath used to drive the transitions, not just the techniques',
    ],
    terms: ['zenkutsu-dachi', 'teisho-uchi', 'empi-uchi', 'yoko-geri-kekomi', 'kiba-dachi', 'kokyu', 'kime'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'meikyo',
    name: 'Meikyo',
    kanji: '明鏡',
    meaning: 'Bright mirror; polished mirror',
    formerName: 'Rohai',
    series: null,
    movements: 33,
    kiai: null,
    character:
      'A quiet, symmetrical form whose name means a mirror polished clear — the image is of a mind reflecting things exactly as they are. It opens with slow, sweeping two-handed movements that frame the face like a mirror being held up, repeats its sequences to left and right with unusual exactness, and finishes with a jump. The symmetry is the discipline: any difference between the left side and the right is on display.',
    develops: [
      'Exact symmetry, since every sequence is performed to both sides',
      'Slow, controlled sweeping movement without loss of tension',
      'A jump used as the resolution of a form rather than as decoration',
      'Calm, which the form is explicitly named after',
    ],
    terms: ['heisoku-dachi', 'zenkutsu-dachi', 'gedan-barai', 'juji-uke', 'kokutsu-dachi', 'neko-ashi-dachi', 'embusen', 'zanshin', 'bunkai'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'unsu',
    name: 'Unsu',
    kanji: '雲手',
    meaning: 'Cloud hands',
    formerName: null,
    series: null,
    movements: 48,
    kiai: [36, 48],
    character:
      'Generally regarded as the most difficult form in the Shotokan canon. Its name describes hands that part clouds, and its opening movements are correspondingly soft and circular — then it turns into the most athletic thing in the style, including a drop to the floor, one-knuckle strikes delivered from ground level, a recovery and a full turning jump. It asks for softness and explosiveness in the same performance, which is why it is usually the last form a student is shown.',
    develops: [
      'Circular, soft technique alongside explosive linear technique',
      'Ground work, and recovering from the floor without losing the form',
      'A full turning jump landed in a correct stance',
      'Concentrated striking with a single knuckle, which forgives no misalignment',
    ],
    terms: ['neko-ashi-dachi', 'fudo-dachi', 'ippon-ken', 'mawashi-geri', 'uraken-uchi', 'zenkutsu-dachi', 'kokutsu-dachi', 'zanshin'],
    gradeAssociation: null,
    video: null,
    note: null,
  }),
  K({
    slug: 'wankan',
    name: 'Wankan',
    kanji: '王冠',
    meaning: 'Kings crown',
    formerName: null,
    series: null,
    movements: 24,
    kiai: null,
    character:
      'The shortest form in the Shotokan canon, and the only one with a single kiai. It is compact and direct, moving along a simple pattern and finishing with a sequence read as pulling an opponent down onto a rising knee. Its brevity is not simplicity: with so few movements, every one of them is exposed, and there is no long passage in which a tired performer can recover.',
    develops: [
      'Economy — a complete form with nothing spare in it',
      'Pulling and striking as one movement, in the closing sequence',
      'Immediate composure, since the form is over almost as soon as it starts',
      'Precision, because a single weak movement is a large fraction of the whole',
    ],
    terms: ['zenkutsu-dachi', 'kokutsu-dachi', 'gedan-barai', 'uchi-uke', 'hiza-geri', 'kime'],
    gradeAssociation: null,
    video: null,
    note: 'This form is known under more than one name across Shotokan organisations, and its versions differ more than most. Treat any description of it, including this one, as one lineage among several.',
  }),
  K({
    slug: 'gojushiho-dai',
    name: 'Gojushiho Dai',
    kanji: '五十四歩大',
    meaning: 'Fifty-four steps, major',
    formerName: 'Useishi',
    series: null,
    movements: 67,
    kiai: null,
    character:
      'One of the two longest forms in the canon and one of the most technically fine. It is full of open-hand work at unusual angles — hooked wrist blocks, back-hand receptions, fingertip thrusts — and it moves in and out of the cat stance constantly, so the weight is repeatedly taken entirely onto one leg. It is often described as a woodpecker striking a tree, for the rapid, precise, repeated tapping of its hand techniques.',
    develops: [
      'Fine open-hand technique at angles the basic curriculum never uses',
      'Constant weight transfer in and out of a stance with no front-foot support',
      'Precision over power, in a form whose targets are small',
      'Endurance across one of the longest performances in the style',
    ],
    terms: ['neko-ashi-dachi', 'nukite', 'keito-uke', 'haishu-uke', 'kokutsu-dachi', 'zenkutsu-dachi', 'teisho-uchi', 'osae-uke', 'kime'],
    gradeAssociation: null,
    video: null,
    note: 'The labels Dai and Sho are attached to these two forms the opposite way round in some Shotokan organisations, so a student trained elsewhere may know this form under the other name. That is a naming difference, not a disagreement about the forms themselves.',
  }),
  K({
    slug: 'gojushiho-sho',
    name: 'Gojushiho Sho',
    kanji: '五十四歩小',
    meaning: 'Fifty-four steps, minor',
    formerName: 'Useishi',
    series: null,
    movements: 65,
    kiai: null,
    character:
      'The companion form, nearly as long and closely related — the two share most of their floor pattern and diverge in the detail of the hand techniques and the sharpness of the finishes. This one is generally the more angular and more percussive of the pair, with more one-knuckle striking, and it is a long-standing favourite in competition for precisely that reason.',
    develops: [
      'Sharp, percussive finishes across a very long form',
      'Concentrated striking with a single knuckle against small targets',
      'Discrimination between two closely related forms, which is a study in itself',
      'Sustained accuracy when the performer is tired',
    ],
    terms: ['neko-ashi-dachi', 'nukite', 'keito-uke', 'ippon-ken', 'kokutsu-dachi', 'zenkutsu-dachi', 'zanshin'],
    gradeAssociation: null,
    video: null,
    note: 'See the note on its companion form: the Dai and Sho labels are reversed in some Shotokan organisations.',
  }),
];

// ─── Federation footage ─────────────────────────────────────────────────────

export interface FederationFootage extends VerifiedVideo {
  /**
   * ALWAYS NULL. This is general kata training from the federation channels,
   * not a performance of a named form. Attributing it to one would be the
   * exact guess the video rule exists to forbid — and a member who followed
   * the link expecting Heian Nidan and found a school demonstration would
   * rightly stop trusting the rest of the library.
   */
  kata: null;
  /** Seconds, as reported by the watch page at the time of the check. */
  durationSeconds: number;
  publishedOn: string;
}

const CHECK_METHOD =
  'Requested the YouTube oEmbed endpoint for the id and then loaded the watch page. Recorded: oEmbed HTTP 200 with the exact title and channel shown here, playabilityStatus OK, and no blockedRegions declared in the player response. A negative control id of eleven A characters returned oEmbed HTTP 404 and playabilityStatus ERROR while the watch page still returned HTTP 200, which is why the status code alone was not treated as proof.';

/**
 * MMAKF's own kata footage, checked one id at a time.
 *
 * These are the only kata videos this library publishes, because they are the
 * only ones the federation made. They are described as training footage
 * because that is what the channels say they are.
 */
export const FEDERATION_KATA_FOOTAGE: readonly FederationFootage[] = [
  {
    youtubeId: 'BzPE4-Kvq7E',
    title: 'Kata #training : Kisan High School,Pithoriya #trending #kata #video #martialarts #sports',
    channel: 'Modern Martialarts Karate Training Centre, Patratu',
    channelUrl: 'https://www.youtube.com/@mmak_india',
    durationSeconds: 66,
    publishedOn: '2023-09-06',
    kata: null,
    verifiedOn: '2026-08-12',
    verifiedBy: CHECK_METHOD,
  },
  {
    youtubeId: '6jDHC7gDEoI',
    title: 'Shotokan kata practice// kata practice  Shifu sensei Ganesh',
    channel: 'Pramod Pathak Martial Arts Academy',
    channelUrl: 'https://www.youtube.com/@PramodPathakMartialArt',
    durationSeconds: 168,
    publishedOn: '2026-02-06',
    kata: null,
    verifiedOn: '2026-08-12',
    verifiedBy: CHECK_METHOD,
  },
  {
    youtubeId: 'GHCYtwmmSpA',
    title: 'KATA PRACTICE TEACHING BY GANESH',
    channel: 'Pramod Pathak Martial Arts Academy',
    channelUrl: 'https://www.youtube.com/@PramodPathakMartialArt',
    durationSeconds: 130,
    publishedOn: '2026-02-09',
    kata: null,
    verifiedOn: '2026-08-12',
    verifiedBy: CHECK_METHOD,
  },
  {
    youtubeId: '531W0mGdskU',
    title: 'Kata practice //Best kata learning',
    channel: 'Pramod Pathak Martial Arts Academy',
    channelUrl: 'https://www.youtube.com/@PramodPathakMartialArt',
    durationSeconds: 86,
    publishedOn: '2026-02-06',
    kata: null,
    verifiedOn: '2026-08-12',
    verifiedBy: CHECK_METHOD,
  },
];

// ─── Lookups ────────────────────────────────────────────────────────────────

/**
 * A Map, not an object literal.
 *
 * `KATA_BY_SLUG['__proto__']` on a plain object returns Object.prototype, which
 * is truthy — so /kata/__proto__ would render a page for an object with no
 * name, or throw. A Map has no prototype keys to inherit, so an unknown slug is
 * simply absent and the route 404s as it should.
 */
const BY_SLUG = new Map<string, Kata>(KATA.map((k) => [k.slug, k]));

export function kataBySlug(slug: string | undefined | null): Kata | null {
  if (!slug) return null;
  return BY_SLUG.get(slug) ?? null;
}

/** Resolved glossary entries, in the order the kata lists them. */
export function kataTerms(k: Pick<Kata, 'terms'>): ResolvedTerm[] {
  const out: ResolvedTerm[] = [];
  for (const key of k.terms) {
    // hasOwnProperty rather than a truthiness test, for the same reason the
    // slug lookup uses a Map: `TERMS['__proto__']` is truthy and is not a term.
    if (!Object.prototype.hasOwnProperty.call(TERMS, key)) continue;
    out.push({ key, ...TERMS[key] });
  }
  return out;
}

/** Only the kata that carry a checked recording. Today this is empty. */
export function kataWithVideo(): Kata[] {
  return KATA.filter((k) => k.video !== null);
}

/** The canon grouped for display: the two named series, then the rest. */
export function kataGroups(): { title: string; blurb: string; members: Kata[] }[] {
  return [
    {
      title: 'The Heian series',
      blurb:
        'Five short forms composed by Itosu Anko in Okinawa around the turn of the twentieth century to make a demanding art teachable. Between them they contain, in miniature, most of what the longer forms later ask for.',
      members: KATA.filter((k) => k.series === 'Heian'),
    },
    {
      title: 'The Tekki series',
      blurb:
        'Three forms performed entirely in the horse stance along a single straight line. They look nothing like the rest of the canon and they are where the hips are built.',
      members: KATA.filter((k) => k.series === 'Tekki'),
    },
    {
      title: 'The remaining canon',
      blurb:
        'Eighteen forms of widely differing age, origin and character — some Okinawan imports renamed in Japan, some paired as a major and minor version of one older form, one of them the only breathing kata in the style.',
      members: KATA.filter((k) => k.series === null),
    },
  ];
}

/** Previous and next within the canon, so a reader can walk the whole library. */
export function kataNeighbours(k: Kata): { prev: Kata | null; next: Kata | null } {
  const i = KATA.findIndex((x) => x.slug === k.slug);
  return {
    prev: i > 0 ? KATA[i - 1] : null,
    next: i >= 0 && i < KATA.length - 1 ? KATA[i + 1] : null,
  };
}
