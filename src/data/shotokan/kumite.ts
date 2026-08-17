/**
 * THE KUMITE LIBRARY
 *
 * Partner practice, from the first five-step exercise to competition tactics.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEPARATION THIS FILE INSISTS ON
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * §13 of the directive asks for traditional kumite development and sport kumite
 * to be kept apart, and the reason is not tidiness. They optimise for different
 * things. Traditional practice trains a decisive technique against a committed
 * attack; sport kumite trains a scoring technique inside a rule set, against an
 * opponent who is also managing a clock and a scoreboard. A student taught the
 * second as though it were the first learns to reach, to score and to stop —
 * and a student taught the first as though it were the second gets penalised.
 *
 * So `category` separates them, and every entry says which world it belongs to.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULES-DEPENDENT MATERIAL IS MARKED AND IS NOT PERMANENT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * §20 is explicit: rules-dependent information must be versioned, and outdated
 * competition rules must never be taught as permanent truth. Competition rules
 * change — scoring values, permitted contact, the length of a bout, the
 * treatment of the area edge, all of it.
 *
 * So `rulesDependent: true` marks every entry whose content depends on a rule
 * set, and NO ENTRY IN THIS FILE STATES A RULE. Not one score value, not one
 * bout length, not one contact level. What is written here is the TACTICAL
 * PRINCIPLE, which survives a rule change; the rule itself belongs in the
 * federation's versioned competition regulations, and the surfaces link there.
 *
 * A library that printed a scoring value would be wrong somewhere in the world
 * on the day it shipped, and wrong everywhere eventually.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND NO INVENTED DOCTRINE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * §17 says the combination library must not be hardcoded as official MMAKF
 * competition doctrine. The combinations here are therefore CONCEPTUAL
 * FAMILIES — "lead hand into reverse punch" — described by what they do and why
 * they work. They are not numbered, not graded, and not attributed to MMAKF.
 * Federation-approved combinations are curriculum data entered by the technical
 * committee through the admin surface.
 */

import type { Fault } from './kihon-types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type KumiteCategory =
  | 'system'        // the formal partner exercises
  | 'fundamental'   // kamae, maai, timing, zanshin …
  | 'footwork'
  | 'initiative'    // the three sen
  | 'defensive'
  | 'competition';

/** A formal partner exercise. §13. */
export interface KumiteSystem {
  slug: string;
  name: string;
  kanji: string | null;
  english: string;
  aliases: readonly string[];
  /** Traditional development, or sport. The distinction the file exists for. */
  world: 'traditional' | 'sport';
  summary: string;
  /** What actually happens, step by step. */
  structure: readonly string[];
  purpose: string;
  /** What it prepares the student for next. */
  progression: string;
  /** Named explicitly: partner work injures people when it is done carelessly. */
  safety: readonly string[];
  commonErrors: readonly Fault[];
  drills: readonly string[];
  terms: readonly string[];
  rulesDependent: boolean;
}

/** A principle, a piece of footwork, an initiative, a tactic. */
export interface KumiteConcept {
  slug: string;
  name: string;
  kanji: string | null;
  english: string;
  aliases: readonly string[];
  category: KumiteCategory;
  world: 'traditional' | 'sport' | 'both';
  summary: string;
  /**
   * The teaching frame §18 asks for. Every field optional because a footwork
   * pattern has no "risk" in the sense an initiative does, and filling one in
   * anyway produces filler.
   */
  teaching: {
    trigger?: string;
    mechanics?: string;
    distance?: string;
    timing?: string;
    decision?: string;
    risk?: string;
    application?: string;
  };
  commonErrors: readonly Fault[];
  drills: readonly string[];
  /** Technique slugs into the kihon library. */
  relatedTechniques: readonly string[];
  /** Kata slugs, where the principle is visible in a form. */
  relatedKata: readonly string[];
  terms: readonly string[];
  /** True when the content depends on a competition rule set. See the header. */
  rulesDependent: boolean;
}

/**
 * A conceptual combination family. NOT an MMAKF grading combination, NOT
 * numbered, NOT doctrine. See the header.
 */
export interface CombinationFamily {
  slug: string;
  name: string;
  /** The shape, as a sequence of technique slugs or plain descriptions. */
  shape: readonly string[];
  /** What the combination is trying to achieve. */
  purpose: string;
  /** The mechanical or tactical reason it works. */
  why: string;
  /** When it fails, and against whom. Every combination has an answer. */
  countered: string;
  world: 'traditional' | 'sport' | 'both';
}

const S = (s: KumiteSystem): KumiteSystem => s;
const C = (c: KumiteConcept): KumiteConcept => c;
const F = (f: CombinationFamily): CombinationFamily => f;

// ─── The formal systems ─────────────────────────────────────────────────────

export const SYSTEMS: readonly KumiteSystem[] = [
  S({
    slug: 'gohon-kumite',
    name: 'Gohon kumite',
    kanji: '五本組手',
    english: 'Five-step sparring',
    aliases: ['gohon kumite', 'five step sparring', 'gohon'],
    world: 'traditional',
    summary:
      'Five identical attacks, five blocks as the defender steps back, then a single counter on the fifth. Everything is announced: the attack, the level, the number of repetitions. Nothing is left to chance except distance and timing, which is precisely what it is for.',
    structure: [
      'Both partners begin in a formal stance at the correct distance and bow.',
      'The attacker announces the level — jodan or chudan — and steps into a ready stance.',
      'The attacker steps forward and attacks; the defender steps back and blocks. Five times.',
      'On the fifth, the defender blocks and counters immediately, with control.',
      'Both return to the starting distance, and the roles reverse.',
    ],
    purpose:
      'To teach distance and timing under an attack the defender already knows is coming, so all the attention can go on those two things. It also teaches a beginner to hold a stance while someone advances on them, which is not a small thing.',
    progression:
      'Leads to sanbon kumite, where the level varies between steps, and then to kihon ippon kumite where there is only one attack and no rhythm to fall into.',
    safety: [
      'The attacker attacks to the correct distance, not through the partner. An attack aimed at the body rather than at the surface of the body is the commonest cause of injury in this exercise.',
      'The counter is controlled. Control is the skill; contact is the failure of it.',
      'Both partners agree the level before starting, every time, out loud.',
    ],
    commonErrors: [
      {
        error: 'The attacker attacks at a distance that cannot reach.',
        why: 'Politeness, or nervousness about hurting the partner.',
        fix: 'Attack to the correct distance. A block against an attack that would have missed teaches nothing to anybody.',
      },
      {
        error: 'The defender steps back before the attack starts.',
        why: 'Anticipating the rhythm, which after four repetitions is easy to do.',
        fix: 'The attacker varies the interval between steps. Anticipation stops immediately.',
      },
      {
        error: 'The counter is forgotten or thrown as an afterthought.',
        why: 'The five blocks feel like the exercise.',
        fix: 'The counter is the exercise. The blocks are how you get to it.',
      },
    ],
    drills: [
      'Jodan five times, then chudan five times, both sides.',
      'The same with the attacker varying the interval so the rhythm cannot be predicted.',
    ],
    terms: ['gohon-kumite', 'maai', 'zanshin'],
    rulesDependent: false,
  }),

  S({
    slug: 'sanbon-kumite',
    name: 'Sanbon kumite',
    kanji: '三本組手',
    english: 'Three-step sparring',
    aliases: ['sanbon kumite', 'three step sparring', 'sanbon'],
    world: 'traditional',
    summary:
      'The same exercise over three steps, with the level of the attack usually changing between them — jodan, then chudan, then a kick. The defender must select the right block rather than repeat one.',
    structure: [
      'Formal start and bow, as gohon kumite.',
      'Three attacks, announced or agreed in advance, at differing levels.',
      'The defender steps back and blocks each with the appropriate technique.',
      'A counter follows the third.',
    ],
    purpose:
      'Selection. Gohon kumite trains one block; sanbon kumite trains choosing between them under a moving opponent.',
    progression: 'Leads to kihon ippon kumite, where the number of steps drops to one and there is no run-up at all.',
    safety: [
      'As gohon kumite. The changing level makes a mistimed block more likely, so control matters more, not less.',
      'Agree the sequence before starting.',
    ],
    commonErrors: [
      {
        error: 'The defender chooses the block before the attack arrives.',
        why: 'The sequence is known.',
        fix: 'Have the attacker vary the order within an agreed set.',
      },
      {
        error: 'The stance degrades over the three steps.',
        why: 'Retreating rather than moving.',
        fix: 'Check the stance at each step; it should be as good on the third as on the first.',
      },
    ],
    drills: ['Jodan, chudan, mae-geri as a fixed set; then the same three in an order the attacker chooses.'],
    terms: ['sanbon-kumite', 'jodan', 'chudan'],
    rulesDependent: false,
  }),

  S({
    slug: 'kihon-ippon-kumite',
    name: 'Kihon ippon kumite',
    kanji: '基本一本組手',
    english: 'Basic one-step sparring',
    aliases: ['kihon ippon kumite', 'basic one step sparring', 'ippon kumite', 'kihon ippon'],
    world: 'traditional',
    summary:
      'One announced attack, one block, one counter. The attack and its level are known; the timing is not. Removing the rhythm of the multi-step exercises is what makes this the first genuinely difficult partner practice.',
    structure: [
      'Both partners face each other at the correct distance and bow.',
      'The attacker announces the attack and level, and settles into a ready stance.',
      'The attacker attacks when ready — not on a count.',
      'The defender blocks, moving off the line where appropriate, and counters decisively with control.',
      'Both reset; roles reverse after an agreed number of repetitions.',
    ],
    purpose:
      'Timing against an unknown moment, and the discipline of one decisive answer rather than a flurry. It is also where tai-sabaki starts to matter: stepping straight back works in gohon kumite and stops working here.',
    progression: 'Leads to jiyu ippon kumite, which adds free-fighting distance, a moving guard, and an opponent who is looking for an opening.',
    safety: [
      'The counter is controlled and stops at the surface. This is the exercise where control is learned properly.',
      'The attacker commits genuinely. A half-hearted attack teaches the defender a defence against nothing.',
      'Neither partner adds a second technique. One attack, one answer, reset.',
    ],
    commonErrors: [
      {
        error: 'The defender moves before the attack.',
        why: 'Reading the attacker’s preparation, which is legitimate — but too early it becomes guessing.',
        fix: 'The attacker should be able to change nothing; if the defender moves first, the attacker simply waits.',
      },
      {
        error: 'The counter is slow, or is not thrown at all.',
        why: 'Treating the block as the goal.',
        fix: 'Block and counter on consecutive beats, never as two separate exercises.',
      },
      {
        error: 'The defender retreats straight back.',
        why: 'Habit inherited from the multi-step exercises.',
        fix: 'Introduce angular movement deliberately; forbid straight-back retreat for a session.',
      },
    ],
    drills: [
      'One attack, one block, one counter, both sides, at increasing speed.',
      'The same with the defender required to finish at an angle to the attacker rather than in front of them.',
    ],
    terms: ['kihon-ippon-kumite', 'tai-sabaki', 'zanshin'],
    rulesDependent: false,
  }),

  S({
    slug: 'jiyu-ippon-kumite',
    name: 'Jiyu ippon kumite',
    kanji: '自由一本組手',
    english: 'Semi-free one-step sparring',
    aliases: ['jiyu ippon kumite', 'jyu ippon kumite', 'semi free sparring', 'jiyu ippon'],
    world: 'traditional',
    summary:
      'One announced attack, but from free-fighting guard and distance, with both partners moving. The bridge between prearranged practice and free fighting, and the exercise where most of what actually works in kumite is learned.',
    structure: [
      'Both partners take free-fighting kamae and move.',
      'The attacker announces the attack and level, then chooses their own moment to close and attack.',
      'The defender manages distance while the attacker sets up, then blocks or evades and counters.',
      'Reset to fighting distance; repeat.',
    ],
    purpose:
      'To join the technical answer to the distance problem. The defender must control maai while the attacker is actively trying to break it — which is the whole of free fighting, with only the choice of attack removed.',
    progression: 'Leads directly to jiyu kumite, and everything in it transfers.',
    safety: [
      'Control is absolute. Both partners are moving and the distance is closing under someone’s initiative, which is when accidents happen.',
      'Agree the level and stick to it.',
      'Stop on the instructor’s call, immediately and every time.',
    ],
    commonErrors: [
      {
        error: 'The defender backs up in a straight line until the area runs out.',
        why: 'Retreat is the instinct and it works for a while.',
        fix: 'Angular movement and counter-attacking on the attacker’s preparation. Drill with a marked area so running out is immediate.',
      },
      {
        error: 'The attacker telegraphs by settling before attacking.',
        why: 'Gathering for the effort.',
        fix: 'Attack from movement, not from a pause.',
      },
      {
        error: 'The counter is thrown after the exchange has finished.',
        why: 'Waiting to be safe.',
        fix: 'Counter on the attacker’s recovery, not after it.',
      },
    ],
    drills: [
      'Announced jodan attack only, defender free to answer however they choose.',
      'Defender forbidden to move straight backward for the whole round.',
      'Defender must counter before the attacker’s attacking hand returns to guard.',
    ],
    terms: ['jiyu-ippon-kumite', 'kamae', 'maai', 'tai-sabaki'],
    rulesDependent: false,
  }),

  S({
    slug: 'jiyu-kumite',
    name: 'Jiyu kumite',
    kanji: '自由組手',
    english: 'Free sparring',
    aliases: ['jiyu kumite', 'jyu kumite', 'free sparring', 'freestyle sparring'],
    world: 'traditional',
    summary:
      'Free practice: neither attack nor defence is prearranged. It is not competition — there is no referee, no score and no clock — and treating the two as the same thing is how students learn to fight for points in the dojo and to spar aimlessly in a match.',
    structure: [
      'Both partners take kamae at fighting distance and bow.',
      'Free exchange under the instructor’s supervision and the dojo’s agreed level of contact.',
      'Stop on command, reset, bow.',
    ],
    purpose:
      'To put everything together under uncertainty: distance, timing, initiative, technique selection and composure, against someone actively trying to prevent all five.',
    progression:
      'Toward competition for those who compete, and toward a deeper understanding of the kata and kihon for everyone. It is a destination, not a stage.',
    safety: [
      'The level of contact is set by the instructor and is not negotiated between partners mid-round.',
      'Protective equipment as the dojo and the federation require.',
      'Experience is matched carefully. A large mismatch is not training for either person.',
      'Stop on the instructor’s command means stop instantly, mid-technique, every time.',
    ],
    commonErrors: [
      {
        error: 'It becomes point-scoring with no structure.',
        why: 'No objective for the round.',
        fix: 'Set a constraint each round — one technique only, no backward movement, counters only. Constraints produce learning; free-for-all produces habits.',
      },
      {
        error: 'The guard drops as the round goes on.',
        why: 'Fatigue.',
        fix: 'Shorter rounds with full attention, rather than long ones with none.',
      },
    ],
    drills: [
      'Constrained rounds: counter-attack only; one technique only; no straight-back movement.',
      'One partner attacking only, the other defending only, then swap.',
    ],
    terms: ['jiyu-kumite', 'kamae', 'maai', 'zanshin'],
    rulesDependent: false,
  }),

  S({
    slug: 'shiai-kumite',
    name: 'Shiai kumite',
    kanji: '試合組手',
    english: 'Competition sparring',
    aliases: ['shiai kumite', 'sport kumite', 'competition sparring', 'shiai', 'match kumite'],
    world: 'sport',
    summary:
      'Sparring under a competition rule set, before officials, for a result. It is a sport with its own demands: scoring criteria, a clock, an area with edges, penalties, and an opponent managing all of the same. The technical foundation is the same karate; the optimisation is not.',
    structure: [
      'Competitors are called, take their positions and bow as the rules require.',
      'The bout runs under the referee’s control, stopping and restarting on command.',
      'Techniques are judged against the criteria the rule set defines.',
      'The result is declared by the officials.',
    ],
    purpose:
      'To test skill under pressure, against a resisting opponent, with a result that matters. Also — not incidentally — to give a national federation a pathway and a ranking.',
    progression:
      'Toward higher levels of competition, and back into the dojo: what fails in a match is what needs work in kihon.',
    safety: [
      'Contact levels, protective equipment and medical provision are governed by the competition rules in force and by the federation’s regulations. This library does not restate them, because a restated rule goes out of date silently.',
      'A competitor who is unfit to continue does not continue. That decision belongs to the officials and the medical staff.',
    ],
    commonErrors: [
      {
        error: 'Training only for the rule set.',
        why: 'The rules define the reward, and training follows reward.',
        fix: 'Keep traditional practice alongside. A rule set that changes should not invalidate a competitor’s whole karate.',
      },
      {
        error: 'Ignoring the area edge until it is a penalty.',
        why: 'Attention entirely on the opponent.',
        fix: 'Drill area awareness deliberately — see the competition entries below.',
      },
    ],
    drills: [
      'Refereed practice bouts with officials calling as they would in competition.',
      'Situational rounds: behind with little time left; ahead with little time left; one penalty away from the next sanction.',
    ],
    terms: ['shiai-kumite', 'jiyu-kumite', 'zanshin'],
    rulesDependent: true,
  }),
];

// ─── Fundamentals ───────────────────────────────────────────────────────────

export const CONCEPTS: readonly KumiteConcept[] = [
  C({
    slug: 'kamae',
    name: 'Kamae',
    kanji: '構え',
    english: 'Guard, posture of readiness',
    aliases: ['kamae', 'guard', 'fighting stance', 'fighting posture'],
    category: 'fundamental',
    world: 'both',
    summary:
      'The position taken up facing an opponent — feet, hips, hands, eyes and breathing together. A good kamae threatens without committing and gives away nothing about what is coming next.',
    teaching: {
      mechanics:
        'Feet about a stride apart, weight distributed so either foot can move first, knees soft. Hips half-facing. Lead hand forward at roughly chin height, rear hand guarding the centre. Shoulders down, chin slightly tucked. Eyes on the opponent as a whole rather than on any one part.',
      distance: 'Established at a range where neither fighter can reach the other without moving. Everything else proceeds from there.',
      decision:
        'A kamae is a set of commitments about what you can do quickly and what you cannot. A low guard buys vision and costs head cover; a square stance buys reach on both sides and costs the target profile.',
      risk: 'A kamae held rigidly is slower than one held relaxed, and a kamae that never changes is one an opponent solves.',
      application: 'Every moment of free fighting that is not an exchange.',
    },
    commonErrors: [
      {
        error: 'Looking at the opponent’s hands or feet.',
        why: 'The moving part attracts the eye.',
        fix: 'Look at the chest or the centre and take in the whole body peripherally. A fighter watching hands will be beaten by feet.',
      },
      {
        error: 'The shoulders are raised and the arms tense.',
        why: 'Confusing readiness with effort.',
        fix: 'Drop the shoulders. Tension is slow, and it is also visible.',
      },
      {
        error: 'Weight settled on one foot.',
        why: 'Standing rather than being ready.',
        fix: 'Check that either foot can leave the floor without a shift first.',
      },
    ],
    drills: [
      'Hold kamae while a partner circles; maintain the relationship without being told to.',
      'Move for a full round without throwing anything, keeping the guard identical throughout.',
    ],
    relatedTechniques: ['ashi-sabaki', 'kizami-zuki'],
    relatedKata: [],
    terms: ['kamae', 'hanmi', 'maai', 'zanshin'],
    rulesDependent: false,
  }),

  C({
    slug: 'maai',
    name: 'Maai',
    kanji: '間合い',
    english: 'Engagement distance',
    aliases: ['maai', 'ma ai', 'distance', 'engagement distance', 'combat distance'],
    category: 'fundamental',
    world: 'both',
    summary:
      'The distance between two fighters, understood as a relationship rather than a measurement. The same gap is close for a tall fighter and long for a short one, and it changes the instant either moves. Controlling it is the largest single skill in free fighting, and the one that most reliably separates two people of otherwise equal technique.',
    teaching: {
      mechanics:
        'Three ranges are worth naming: too far for either to reach without moving; the range where one step or slide reaches; and close range, where hands are already touching and elbows and knees are the weapons. The middle range is where almost all decisions are made.',
      distance: 'The whole subject.',
      timing:
        'Distance and timing are the same problem seen from two angles. A technique thrown at the right moment from the wrong distance misses; one thrown from the right distance at the wrong moment is countered.',
      decision:
        'The fighter who decides the distance decides the fight. Everything else — feints, footwork, initiative — is a means to that end.',
      risk:
        'Closing distance is the moment of maximum vulnerability, for both fighters. That is why sen-no-sen exists.',
      application: 'Every exchange, every entry, every retreat.',
    },
    commonErrors: [
      {
        error: 'Standing at a distance the opponent has chosen.',
        why: 'Reacting rather than managing.',
        fix: 'Move first, constantly and slightly, so the distance is always one you set.',
      },
      {
        error: 'Closing without a plan for what happens on arrival.',
        why: 'Treating the entry as the technique.',
        fix: 'Drill entries that must finish with a specific technique.',
      },
      {
        error: 'Retreating in a straight line when the distance is broken.',
        why: 'The instinctive answer.',
        fix: 'Angular movement. Straight back keeps you exactly where the opponent wants you, only further away.',
      },
    ],
    drills: [
      'Mirror drill: one partner moves freely, the other maintains an exact distance without instruction.',
      'Tag: touch the partner’s shoulder without being touched. No techniques at all.',
      'One partner may only advance, the other only retreat; then reverse.',
    ],
    relatedTechniques: ['ashi-sabaki', 'tai-sabaki', 'kizami-zuki'],
    relatedKata: [],
    terms: ['maai', 'kamae', 'ashi-sabaki'],
    rulesDependent: false,
  }),

  C({
    slug: 'zanshin',
    name: 'Zanshin',
    kanji: '残心',
    english: 'Remaining mind',
    aliases: ['zanshin', 'remaining mind', 'continued awareness', 'follow through awareness'],
    category: 'fundamental',
    world: 'both',
    summary:
      'The alertness that continues after a technique has finished. A fighter who scores and then relaxes has demonstrated its absence, and in competition zanshin is judged as part of the technique rather than as something added to it.',
    teaching: {
      mechanics: 'The technique finishes, the guard recovers, the eyes stay on the opponent, and the body remains able to act. Nothing switches off.',
      timing: 'Immediately after the technique, and continuing until the exchange is genuinely over — which the referee, not the competitor, decides.',
      decision: 'It is not a decision at all once trained, which is the point of training it.',
      risk: 'Its absence is the single commonest way a scoring technique is followed by a scoring counter.',
      application: 'The end of every technique, in kata as much as in kumite.',
    },
    commonErrors: [
      {
        error: 'Dropping the hands to admire a technique that landed.',
        why: 'Satisfaction.',
        fix: 'Partner counters every time the hands drop. It stops within one session.',
      },
      {
        error: 'Turning away after an exchange.',
        why: 'Assuming it is over.',
        fix: 'Reset facing the opponent, always, in every drill.',
      },
    ],
    drills: [
      'Every drill in the dojo finishes with the guard recovered and the eyes on the partner. No exceptions.',
      'Partner throws a light counter whenever attention lapses.',
    ],
    relatedTechniques: [],
    relatedKata: ['heian-shodan', 'bassai-dai'],
    terms: ['zanshin', 'kime'],
    rulesDependent: false,
  }),

  C({
    slug: 'feint',
    name: 'Feint',
    kanji: null,
    english: 'Feint, deception',
    aliases: ['feint', 'fake', 'deception', 'draw'],
    category: 'fundamental',
    world: 'both',
    summary:
      'A movement made to be believed rather than to land, so the opponent commits their defence to somewhere the real attack is not. A feint that does not threaten is simply a wasted movement that shortens your own reaction time.',
    teaching: {
      trigger: 'Used against an opponent who reacts consistently. Against one who does not react at all, a feint is worse than useless.',
      mechanics:
        'The feint must look exactly like the technique it imitates for as long as the opponent needs to decide. A half-committed movement reads as a feint and teaches the opponent to ignore the next one.',
      timing: 'The real technique follows on the opponent’s reaction, not on a count. Too early and the reaction has not happened; too late and it has finished.',
      decision: 'Feint high to attack low, or the reverse; feint on one side to attack the other; feint an entry to draw a counter and take the counter’s opening.',
      risk: 'A feint occupies time and a limb. Against a fighter using sen-no-sen it is an invitation.',
      application: 'Opening a guard that will not open to a direct attack.',
    },
    commonErrors: [
      {
        error: 'The feint is obviously not a real technique.',
        why: 'Half-committing to save time.',
        fix: 'Throw the feint as though it were the attack, and stop it.',
      },
      {
        error: 'Feinting against someone who is not reacting.',
        why: 'Following a plan rather than the opponent.',
        fix: 'Establish that the opponent reacts before spending a feint on them.',
      },
    ],
    drills: [
      'Feint jodan, attack chudan, on a partner instructed to react honestly.',
      'Partner calls out what they believed the feint was, immediately after.',
    ],
    relatedTechniques: ['kizami-zuki', 'uraken-uchi', 'mae-geri'],
    relatedKata: [],
    terms: ['maai', 'kamae'],
    rulesDependent: false,
  }),

  // ── Footwork ─────────────────────────────────────────────────────────────
  C({
    slug: 'kumite-footwork',
    name: 'Kumite footwork',
    kanji: '足捌き',
    english: 'Footwork in free fighting',
    aliases: ['kumite footwork', 'fighting footwork', 'ashi sabaki kumite', 'movement'],
    category: 'footwork',
    world: 'both',
    summary:
      'The patterns of movement that make distance controllable: sliding forward and back, stepping, switching the lead, entering at an angle, moving laterally, and leaving. Everything a fighter can do is bounded by where the feet can put the body, and how fast.',
    teaching: {
      mechanics:
        'Forward and back by sliding — suri-ashi — without lifting or crossing the feet. Distance closed quickly with tsugi-ashi, the rear foot coming up before the front steps. Lead changed with a switch, both feet moving together. Angle entry by stepping the front foot off the line and turning the hips, arriving beside the opponent rather than in front. Lateral movement by sliding, never crossing. Exit by pushing off the front foot, at an angle wherever possible.',
      distance: 'Footwork is how distance is manufactured. There is no other mechanism.',
      timing: 'Movement is most useful on the opponent’s preparation — while they are gathering, they cannot adjust.',
      decision:
        'Straight back is the movement that changes nothing except the gap, and against an opponent who moves well it merely postpones the exchange while giving up the area.',
      risk: 'Crossed feet cannot change direction. A fighter caught with crossed feet has no answer available at all.',
      application: 'Continuously, throughout every exchange and between them.',
    },
    commonErrors: [
      {
        error: 'The head rises and falls with each movement.',
        why: 'Pushing off with a straightening leg.',
        fix: 'Move under an imagined low ceiling; a partner watching from the side sees it immediately.',
      },
      {
        error: 'The feet cross while moving sideways.',
        why: 'Walking rather than sliding.',
        fix: 'Lateral sliding drills where crossing ends the round.',
      },
      {
        error: 'The guard swings with the footwork.',
        why: 'Using the arms for balance.',
        fix: 'Move a full round with the hands deliberately still.',
      },
      {
        error: 'Retreating to the edge of the area without noticing.',
        why: 'Attention entirely on the opponent.',
        fix: 'Practise inside a marked area from the start, not only before competitions.',
      },
    ],
    drills: [
      'Sliding up and down the floor in kamae, hands still, head level.',
      'Angle-entry drill: partner attacks straight, defender steps off the line and finishes beside them.',
      'Marked-square movement with direction changes called out.',
      'A full round with no straight-backward movement permitted.',
    ],
    relatedTechniques: ['ashi-sabaki', 'tai-sabaki'],
    relatedKata: ['heian-yondan', 'unsu'],
    terms: ['ashi-sabaki', 'suri-ashi', 'tsugi-ashi', 'ayumi-ashi', 'maai'],
    rulesDependent: false,
  }),

  // ── Initiative — the three sen ───────────────────────────────────────────
  C({
    slug: 'go-no-sen',
    name: 'Go-no-sen',
    kanji: '後の先',
    english: 'Late initiative — block, then counter',
    aliases: ['go no sen', 'gonosen', 'late initiative', 'block and counter'],
    category: 'initiative',
    world: 'both',
    summary:
      'The opponent attacks; the attack is received; the counter follows. The initiative is taken back after the attack has committed. It is the first of the three initiatives taught, because it is the only one that can be practised safely from the beginning.',
    teaching: {
      trigger: 'A committed attack, already launched.',
      mechanics: 'Receive — block, parry or evade — and counter into the opening the attack has left. The block and the counter are consecutive beats, not two exercises.',
      distance: 'Whatever the attacker chose. The defender is working inside a distance somebody else set, which is the cost of this initiative.',
      timing: 'After the attack commits, before it recovers. That window is the whole technique.',
      decision: 'Chosen when the opponent’s attack cannot be pre-empted, or when their pattern is not yet known.',
      risk: 'It concedes the initiative and therefore the distance. Against a fast opponent with good recovery, the window may not open at all.',
      application: 'The foundation of gohon, sanbon and kihon ippon kumite, and the initiative every student learns first.',
    },
    commonErrors: [
      {
        error: 'A pause between the block and the counter.',
        why: 'Practising them as two techniques.',
        fix: 'Insist on consecutive beats. If the attacker has recovered, it was too slow.',
      },
      {
        error: 'Blocking hard and staying put.',
        why: 'Treating the block as the answer.',
        fix: 'The block finishes with the hips loaded; the counter uses that loading.',
      },
    ],
    drills: [
      'Kihon ippon kumite with the counter required before the attacking hand returns to guard.',
      'Block-counter on a partner throwing at unpredictable intervals.',
    ],
    relatedTechniques: ['age-uke', 'soto-uke', 'uchi-uke', 'gedan-barai', 'shuto-uke', 'gyaku-zuki'],
    relatedKata: ['heian-shodan', 'heian-nidan', 'bassai-dai'],
    terms: ['go-no-sen', 'sen-no-sen', 'tai-no-sen'],
    rulesDependent: false,
  }),

  C({
    slug: 'sen-no-sen',
    name: 'Sen-no-sen',
    kanji: '先の先',
    english: 'Initiative ahead of the initiative',
    aliases: ['sen no sen', 'sennosen', 'anticipating initiative', 'intercepting'],
    category: 'initiative',
    world: 'both',
    summary:
      'Attacking into the opponent’s attack as it begins — after they have committed, but before it arrives. The counter lands into a body already moving forward and already unable to change, which is why it lands so heavily and scores so cleanly.',
    teaching: {
      trigger:
        'The instant of commitment: the weight shifting forward, the shoulder gathering, the breath drawn. The trigger is read from the opponent’s preparation, not from their technique.',
      mechanics: 'A direct technique into the opening the attack itself creates, usually combined with a small movement off the line.',
      distance: 'Closing, and closing fast, because the opponent is doing the closing.',
      timing: 'The narrowest window of the three initiatives, and the reason it takes years.',
      decision: 'Chosen against an opponent whose preparation is readable, and where the technique is short enough to arrive first.',
      risk:
        'Read the preparation wrongly and you have attacked into a technique that was never coming, from a distance you closed yourself. It is the highest-reward and highest-cost initiative.',
      application: 'The most valued counter in both traditional practice and competition.',
    },
    commonErrors: [
      {
        error: 'Moving on a feint.',
        why: 'Reading a preparation that was manufactured to be read.',
        fix: 'Train against partners who deliberately feint. Learn which preparations are genuine.',
      },
      {
        error: 'Attacking before the opponent has committed.',
        why: 'Impatience; this is then simply an attack, and often a countered one.',
        fix: 'Wait for the commitment. It is the difference between sen-no-sen and being predictable.',
      },
      {
        error: 'Choosing a technique too long to arrive in time.',
        why: 'Selecting for power.',
        fix: 'Short techniques — kizami-zuki, a front-leg kick — arrive; long ones do not.',
      },
    ],
    drills: [
      'Partner attacks on their own initiative; defender must land before the attack does.',
      'Partner attacks with an announced technique from free distance; defender intercepts only.',
      'Reading drill: partner alternates real attacks and feints, defender calls which without moving.',
    ],
    relatedTechniques: ['kizami-zuki', 'gyaku-zuki', 'mae-geri', 'tai-sabaki'],
    relatedKata: [],
    terms: ['sen-no-sen', 'go-no-sen', 'tai-no-sen', 'maai'],
    rulesDependent: false,
  }),

  C({
    slug: 'tai-no-sen',
    name: 'Tai-no-sen',
    kanji: '対の先',
    english: 'Simultaneous initiative',
    aliases: ['tai no sen', 'tainosen', 'simultaneous initiative', 'sen no sen no sen'],
    category: 'initiative',
    world: 'traditional',
    summary:
      'Meeting the attack at the same instant it is launched, so both techniques travel together and the outcome is decided by structure, line and distance rather than by who moved first. The rarest of the three, and the one most dependent on reading an opponent completely.',
    teaching: {
      trigger: 'The same instant the opponent chooses — arrived at by reading them, or by having offered them the opening deliberately.',
      mechanics: 'A technique on a line that occupies the space the attack must pass through, with the body structure to win the exchange.',
      distance: 'Fixed by both fighters simultaneously, which is what makes it so difficult.',
      timing: 'Exactly together. Slightly early is sen-no-sen; slightly late is go-no-sen.',
      decision: 'Chosen when the opponent has been drawn into attacking at a moment of your choosing.',
      risk: 'Both techniques land. Where the rules or the practice do not permit that outcome, this is not the initiative to choose.',
      application: 'Advanced traditional practice, and — in competition — the exchanges that judges find hardest to separate.',
    },
    commonErrors: [
      {
        error: 'Treating it as a double knockout and calling it success.',
        why: 'Confusing simultaneity with victory.',
        fix: 'The structure and the line must win the exchange, not merely arrive with it.',
      },
      {
        error: 'Training it before go-no-sen and sen-no-sen are reliable.',
        why: 'It looks impressive.',
        fix: 'Order matters. This is third for a reason.',
      },
    ],
    drills: [
      'Advanced partner work under close supervision, with the instructor calling which initiative was actually used.',
      'Drawing drill: defender deliberately offers an opening and meets the attack it invites.',
    ],
    relatedTechniques: ['gyaku-zuki', 'mae-geri'],
    relatedKata: ['sochin'],
    terms: ['tai-no-sen', 'sen-no-sen', 'go-no-sen'],
    rulesDependent: false,
  }),

  // ── Defensive ────────────────────────────────────────────────────────────
  C({
    slug: 'defensive-kumite',
    name: 'Defensive kumite',
    kanji: null,
    english: 'Defence and counter',
    aliases: ['defensive kumite', 'defence', 'counter attack', 'block counter'],
    category: 'defensive',
    world: 'both',
    summary:
      'The six ways an attack is answered — block and counter, evade and counter, break the distance and counter, angle and counter, intercept, and escape pressure — treated as a set of choices rather than as a single reflex.',
    teaching: {
      trigger: 'An attack, committed or developing.',
      mechanics:
        'BLOCK AND COUNTER receives the attack and answers into the opening. EVADE AND COUNTER removes the target and answers from the new position. DISTANCE AND COUNTER lets the attack fall short and answers on its recovery. ANGLE AND COUNTER moves off the line to arrive beside the attacker. INTERCEPT attacks the attack as it forms — sen-no-sen. PRESSURE ESCAPE breaks contact and resets the distance when none of the others is available.',
      distance:
        'Each choice implies a different distance. Blocking works close; distance-and-counter needs room; angling needs somewhere to go.',
      timing:
        'Each has its own window. Interception is earliest, distance-and-counter is latest, and choosing the wrong one for the moment available is the commonest failure.',
      decision:
        'Governed by distance, by what is behind you, and by what the opponent has committed. It is a selection problem, and it is trained as one.',
      risk: 'Every answer leaves something open. A block occupies a hand; an evasion costs range; breaking distance concedes the area.',
      application: 'Every defensive moment in free fighting.',
    },
    commonErrors: [
      {
        error: 'Only ever using one of the six.',
        why: 'The first one learned becomes the reflex.',
        fix: 'Constrain the round to one answer at a time, rotating through all six.',
      },
      {
        error: 'Defending without countering.',
        why: 'Survival feels like success.',
        fix: 'Every defensive drill has a counter attached. Always.',
      },
      {
        error: 'Escaping pressure by running out of the area.',
        why: 'Backward is the only direction being used.',
        fix: 'Escape at an angle, or by closing. Never straight back into the edge.',
      },
    ],
    drills: [
      'Six-answer rotation: the same attack answered a different way each repetition.',
      'Defender confined to a small marked area, so distance-and-counter is unavailable.',
      'Attacker presses continuously; defender must escape and reset without leaving the area.',
    ],
    relatedTechniques: ['age-uke', 'soto-uke', 'uchi-uke', 'gedan-barai', 'shuto-uke', 'tai-sabaki', 'gyaku-zuki'],
    relatedKata: ['heian-yondan', 'bassai-dai'],
    terms: ['go-no-sen', 'sen-no-sen', 'tai-sabaki', 'maai'],
    rulesDependent: false,
  }),

  C({
    slug: 'kumite-attack',
    name: 'Attacking in kumite',
    kanji: null,
    english: 'Attack selection and delivery',
    aliases: ['kumite attack', 'attacking', 'attack selection', 'offence'],
    category: 'fundamental',
    world: 'both',
    summary:
      'Choosing what to throw, from where, and when — a different problem from being able to throw it. The technique that works in kihon at a fixed distance against a stationary partner is not automatically the technique that arrives against someone moving.',
    teaching: {
      trigger: 'An opening — created by a feint, by the opponent’s own movement, or by pressure that has forced a reaction.',
      mechanics:
        'Short techniques arrive: kizami-zuki, front-leg kicks, gyaku-zuki off a slide. Long committed techniques — oi-zuki, spinning kicks — need an opening already made, and are thrown into a decision the opponent has already committed to.',
      distance: 'Every technique has a distance at which it works and outside which it is either a miss or an invitation.',
      timing: 'On the opponent’s preparation, on their recovery, or on the reaction a feint has produced. Not on your own impulse.',
      decision: 'Head or body; lead hand or rear; hand or foot. The choice follows what the opponent’s guard and stance have left available.',
      risk: 'Every attack opens the attacker. The longer and more committed the technique, the larger and longer the opening.',
      application: 'Every offensive moment in free fighting and competition.',
    },
    commonErrors: [
      {
        error: 'Attacking from a distance the technique cannot cover.',
        why: 'Throwing on impulse rather than on distance.',
        fix: 'Drill entries separately from techniques until the distance is felt rather than judged.',
      },
      {
        error: 'Telegraphing — a hand drop, a shoulder twitch, a settling of the weight.',
        why: 'Gathering for the effort.',
        fix: 'Mirror work, and a partner instructed to counter every telegraph they see.',
      },
      {
        error: 'One attack, then waiting to see what happened.',
        why: 'Treating an attack as an event rather than as an opening.',
        fix: 'Drill combinations where the second technique is thrown on the recovery of the first, whatever the first did.',
      },
    ],
    drills: [
      'Entry drill: close the distance and touch the shoulder, no technique.',
      'One-technique rounds — only kizami-zuki permitted for the whole round.',
      'Attack on the partner’s movement only, never on your own initiative.',
    ],
    relatedTechniques: ['kizami-zuki', 'gyaku-zuki', 'oi-zuki', 'mae-geri', 'mawashi-geri', 'ura-mawashi-geri', 'ushiro-geri'],
    relatedKata: [],
    terms: ['maai', 'kamae', 'zanshin'],
    rulesDependent: false,
  }),

  C({
    slug: 'kumite-combination',
    name: 'Combination attack',
    kanji: '連続技',
    english: 'Combination technique',
    aliases: ['kumite combination', 'renzoku waza', 'combination', 'combinations'],
    category: 'fundamental',
    world: 'both',
    summary:
      'Techniques joined so that the finish of one is the preparation for the next. A combination is not two techniques thrown quickly; it is one technique that makes the second one possible.',
    teaching: {
      mechanics:
        'The first technique moves the opponent’s guard, their weight or their attention. The second goes where the first has made room. If the second would have worked without the first, it was not a combination — it was a repetition.',
      timing: 'The second technique is thrown on the recovery of the first, before the guard resets.',
      distance: 'Combinations change distance as they run. The second technique must suit the distance the first will have created, not the one it started from.',
      decision: 'Chosen against a guard that will not open to a single technique.',
      risk: 'A combination commits the fighter for longer than a single technique, so it is thrown when the opening is real.',
      application: 'Against a well-guarded opponent, and as the standard offensive unit of competition kumite.',
    },
    commonErrors: [
      {
        error: 'The second technique is thrown regardless of what the first did.',
        why: 'Practising combinations as fixed sequences.',
        fix: 'Drill with a partner who reacts genuinely, so the second technique has to go where the reaction left space.',
      },
      {
        error: 'Slowing between techniques to re-set.',
        why: 'Returning fully to guard between them.',
        fix: 'The recovery of the first IS the preparation of the second.',
      },
    ],
    drills: [
      'Two-technique pad work where the pad holder moves the second pad according to how they reacted to the first.',
      'Partner reacts honestly to the first technique; attacker must choose the second live.',
    ],
    relatedTechniques: ['kizami-zuki', 'gyaku-zuki', 'mawashi-geri', 'uraken-uchi'],
    relatedKata: [],
    terms: ['maai', 'zanshin'],
    rulesDependent: false,
  }),

  C({
    slug: 'kumite-principles',
    name: 'Principles of engagement',
    kanji: null,
    english: 'Rhythm, pressure, reaction and initiative',
    aliases: ['kumite principles', 'rhythm', 'pressure', 'tempo', 'reaction'],
    category: 'fundamental',
    world: 'both',
    summary:
      'The qualities that govern an exchange without being techniques themselves: rhythm and its deliberate breaking, pressure applied and absorbed, reaction speed, and the constant contest for the initiative.',
    teaching: {
      mechanics:
        'RHYTHM is the tempo two fighters settle into; the fighter who breaks it first usually scores, which is why an irregular tempo is worth more than a fast one. PRESSURE is advancing intent — closing space, taking the centre, forcing the opponent to respond — and it wins ground without a technique being thrown. REACTION is the delay between seeing and moving, and it shortens with familiarity rather than with speed training. INITIATIVE is who is deciding; the fighter deciding is the fighter winning, whatever the score says.',
      timing: 'Rhythm is timing made visible. Breaking it is the cheapest opening available.',
      decision: 'Whether to establish a rhythm and break it, or to refuse one from the start.',
      risk: 'Pressure applied without the ability to finish simply walks a fighter into a counter.',
      application: 'Continuously, underneath everything else.',
    },
    commonErrors: [
      {
        error: 'Settling into a predictable tempo.',
        why: 'It is comfortable, and both fighters do it together.',
        fix: 'Deliberately vary the interval between every action for a whole round.',
      },
      {
        error: 'Confusing pressure with rushing.',
        why: 'Both look like moving forward.',
        fix: 'Pressure keeps the guard, the distance and the balance. Rushing abandons all three.',
      },
    ],
    drills: [
      'Rhythm-breaking rounds: three actions on a beat, the fourth deliberately off it.',
      'Pressure round: one fighter advances only, without attacking, while the other must not give ground in a straight line.',
    ],
    relatedTechniques: ['ashi-sabaki', 'kizami-zuki'],
    relatedKata: [],
    terms: ['maai', 'zanshin', 'kamae'],
    rulesDependent: false,
  }),

  C({
    slug: 'jiyu-kihon',
    name: 'Jiyu kihon',
    kanji: '自由基本',
    english: 'Free basics',
    aliases: ['jiyu kihon', 'jyu kihon', 'free basics', 'freestyle basics'],
    category: 'fundamental',
    world: 'traditional',
    summary:
      'Basic techniques practised from free-fighting stance and guard, moving, rather than from formal stances on a count. It is the translation layer between kihon and kumite, and the place where techniques that work on the spot are rebuilt to work while moving.',
    teaching: {
      mechanics: 'The same techniques as formal kihon, thrown from kamae with free footwork, without a chamber at the hip and without a count.',
      distance: 'Free-fighting distance throughout.',
      timing: 'Self-selected, or on a partner’s movement.',
      decision: 'Which technique the stance and distance actually allow, rather than which one the count called for.',
      application: 'Everything that transfers from kihon into kumite passes through here.',
    },
    commonErrors: [
      {
        error: 'Reverting to formal chambering.',
        why: 'Habit from kihon.',
        fix: 'Practise in front of a mirror; a hand dropping to the hip is unmistakable.',
      },
      {
        error: 'Losing technical quality because the stance is free.',
        why: 'Treating "free" as "approximate".',
        fix: 'The hip rotation, the hikite and the kime are unchanged. Only the stance and the chamber differ.',
      },
    ],
    drills: [
      'Formal kihon technique, then the same technique from kamae moving, back to back.',
      'Moving up and down the floor in kamae throwing single techniques on no count at all.',
    ],
    relatedTechniques: ['gyaku-zuki', 'kizami-zuki', 'mae-geri', 'mawashi-geri', 'ashi-sabaki'],
    relatedKata: [],
    terms: ['kihon', 'kamae', 'jiyu-kumite'],
    rulesDependent: false,
  }),

  // ── Competition ──────────────────────────────────────────────────────────
  C({
    slug: 'competition-distance',
    name: 'Opening distance and lead management',
    kanji: null,
    english: 'Managing the opening and the lead',
    aliases: ['competition distance', 'opening distance', 'lead management', 'scoreboard management'],
    category: 'competition',
    world: 'sport',
    summary:
      'How a bout is shaped from the first exchange onward: establishing a distance the opponent has to work inside, taking a lead, and then managing the bout differently because you have one. All of it is tactical principle; none of it restates a rule, because rules change.',
    teaching: {
      mechanics:
        'The opening exchanges establish who sets the distance. A lead changes the tactical problem completely: the leader can afford to make the opponent come forward, and the fighter behind cannot afford to wait. Neither position is comfortable, and both are trained.',
      timing: 'The value of time changes through a bout. The same exchange is worth taking early and not worth taking late.',
      decision:
        'With a lead: control distance, refuse exchanges you do not need, and stay clear of the edge and of penalties. Behind: manufacture exchanges, accept more risk, and manage the clock deliberately rather than by feel.',
      risk:
        'Passivity is penalised under most rule sets, so a lead cannot be protected by simply not fighting. The exact treatment differs between rule sets and between versions of the same rule set — which is why this library states the principle and links to the federation’s versioned regulations for the rule.',
      application: 'Every competitive bout, from the first exchange to the last.',
    },
    commonErrors: [
      {
        error: 'Fighting the same way whether ahead or behind.',
        why: 'Never having trained the two situations separately.',
        fix: 'Situational rounds with a scoreboard and a clock, both positions.',
      },
      {
        error: 'Protecting a lead by disengaging entirely.',
        why: 'Assuming the clock is enough.',
        fix: 'Understand what the rule set in force penalises, and train active control instead of retreat.',
      },
    ],
    drills: [
      'Situational rounds: last thirty seconds, one point behind; last thirty seconds, one point ahead.',
      'Refereed practice bouts where officials call as they would in competition.',
    ],
    relatedTechniques: ['ashi-sabaki', 'kizami-zuki', 'gyaku-zuki'],
    relatedKata: [],
    terms: ['maai', 'shiai-kumite', 'zanshin'],
    rulesDependent: true,
  }),

  C({
    slug: 'competition-edge',
    name: 'Area awareness',
    kanji: null,
    english: 'Tatami and edge awareness',
    aliases: ['edge awareness', 'area awareness', 'tatami awareness', 'jogai'],
    category: 'competition',
    world: 'sport',
    summary:
      'Knowing where you are in the competition area without looking, and using the edge as a tactical feature rather than discovering it as a penalty.',
    teaching: {
      mechanics:
        'Position is tracked peripherally and by proprioception, built by always training inside a marked area. An opponent can be steered toward the edge by angling the pressure; a fighter being steered escapes by moving along the edge rather than away from it.',
      distance: 'The edge removes one direction of retreat, which changes every distance decision made near it.',
      decision: 'Whether to press an opponent toward the edge, and how to escape when being pressed toward it.',
      risk:
        'Leaving the area is penalised under every rule set the federation competes under, though the sanction and its accumulation differ between them and between versions. The principle is permanent; the penalty is not, and belongs in the regulations rather than here.',
      application: 'Continuously in competition, and it costs bouts far more often than it is trained.',
    },
    commonErrors: [
      {
        error: 'Discovering the edge by stepping over it.',
        why: 'Attention entirely on the opponent.',
        fix: 'Train inside a marked area always, not only in the weeks before a competition.',
      },
      {
        error: 'Escaping the edge by moving straight along the opponent’s line.',
        why: 'Moving away rather than around.',
        fix: 'Escape by angling along the edge, past the opponent’s shoulder.',
      },
    ],
    drills: [
      'All free sparring inside a properly marked area.',
      'Deliberate edge drill: one fighter starts with their back to the line and must escape without stepping out.',
    ],
    relatedTechniques: ['ashi-sabaki', 'tai-sabaki'],
    relatedKata: [],
    terms: ['shiai-kumite', 'maai'],
    rulesDependent: true,
  }),

  C({
    slug: 'competition-opponent-analysis',
    name: 'Opponent analysis',
    kanji: null,
    english: 'Reading and adapting to an opponent',
    aliases: ['opponent analysis', 'reading the opponent', 'scouting', 'adaptation'],
    category: 'competition',
    world: 'sport',
    summary:
      'Working out, during the bout, what the opponent does and does not do — and changing accordingly. Most competitors have two or three preferred entries and one preferred counter; finding them early decides more bouts than fitness does.',
    teaching: {
      mechanics:
        'Watch which side leads, which technique opens, what they do when pressed, what they do when given space, and whether they react to feints. Test with low-cost probes rather than committed attacks.',
      timing: 'The first exchanges are for information. Spending them on a committed attack wastes them.',
      decision: 'What to change once the pattern is read: distance, lead, tempo, or the initiative being used.',
      risk: 'Reading takes time, and an opponent who reads faster is reading you while you read them.',
      application: 'Every bout, and between bouts where the draw allows the next opponent to be watched.',
    },
    commonErrors: [
      {
        error: 'Fighting a plan rather than an opponent.',
        why: 'The plan was made before the bout.',
        fix: 'Set the first exchanges aside for information, deliberately.',
      },
      {
        error: 'Never changing after the opponent has adapted.',
        why: 'The first read was correct and then stopped being correct.',
        fix: 'Re-read after every scoring exchange, in either direction.',
      },
    ],
    drills: [
      'Rounds where the attacker may use only one technique; the defender must identify and shut it down.',
      'Video review of the competitor’s own bouts, looking for their own tells.',
    ],
    relatedTechniques: ['kizami-zuki', 'ashi-sabaki'],
    relatedKata: [],
    terms: ['maai', 'zanshin', 'shiai-kumite'],
    rulesDependent: true,
  }),
];

// ─── Combination families ───────────────────────────────────────────────────
//
// CONCEPTUAL FAMILIES, NOT MMAKF DOCTRINE. See the header of this file. Nothing
// here is numbered, graded, or attributed to the federation.

export const COMBINATION_FAMILIES: readonly CombinationFamily[] = [
  F({
    slug: 'lead-hand-into-reverse-punch',
    name: 'Lead hand into reverse punch',
    shape: ['kizami-zuki', 'gyaku-zuki'],
    purpose: 'Open the guard with something fast, then land something heavy behind it.',
    why: 'The lead hand arrives first and draws the guard toward it. The reverse punch follows into the space that leaves, powered by the hip rotation the first technique has already begun.',
    countered:
      'By an opponent who does not react to the lead hand, or who intercepts the first technique with sen-no-sen. It also fails if the second technique is thrown on a count rather than on the reaction.',
    world: 'both',
  }),
  F({
    slug: 'lead-hand-into-kick',
    name: 'Lead hand into kick',
    shape: ['kizami-zuki', 'mawashi-geri'],
    purpose: 'Draw the guard up, then attack the level it has left.',
    why: 'A hand technique to the head lifts the guard and the attention. The kick arrives at the ribs or the opposite side of the head while both are still up.',
    countered: 'By an opponent who closes distance on the hand technique, arriving inside the range at which the kick can be thrown at all.',
    world: 'both',
  }),
  F({
    slug: 'kick-into-reverse-punch',
    name: 'Kick into reverse punch',
    shape: ['mae-geri', 'gyaku-zuki'],
    purpose: 'Use the kick to close the distance, and land the punch as the foot comes down.',
    why: 'The kick occupies the guard and the distance. The punch is thrown as the kicking foot lands, which is exactly when the body is again able to rotate.',
    countered: 'By an opponent who moves off the line of the kick, leaving the punch to arrive where they are not.',
    world: 'both',
  }),
  F({
    slug: 'double-hand',
    name: 'Two hand techniques on the same side',
    shape: ['kizami-zuki', 'kizami-zuki'],
    purpose: 'Beat a guard by repetition and rhythm rather than by opening it.',
    why: 'The first is expected and defended; the second arrives on the recovery of the defence, before the guard has fully reset.',
    countered: 'By an opponent who counters the first technique rather than blocking it — the second never gets thrown.',
    world: 'sport',
  }),
  F({
    slug: 'hand-into-kick-into-hand',
    name: 'Hand, kick, hand',
    shape: ['kizami-zuki', 'mawashi-geri', 'gyaku-zuki'],
    purpose: 'Move the guard twice and finish where it is not.',
    why: 'Three techniques at three levels or angles. Each moves the guard; the third arrives at the level the first two have vacated.',
    countered: 'By an opponent who closes during the kick, which is the longest and most committed part of the sequence.',
    world: 'both',
  }),
  F({
    slug: 'feint-into-attack',
    name: 'Feint into attack',
    shape: ['feint', 'any committed technique'],
    purpose: 'Manufacture the opening rather than wait for one.',
    why: 'The feint is believed and defended; the real technique goes to the place the defence has left. It requires an opponent who reacts.',
    countered:
      'By an opponent who does not react, or who has recognised the feint pattern. A feint spent on a non-reactor costs time and gains nothing.',
    world: 'both',
  }),
  F({
    slug: 'attack-angle-attack',
    name: 'Attack, angle, attack',
    shape: ['any committed technique', 'angular movement', 'any committed technique'],
    purpose: 'Attack, move to where the answer is not, and attack again from the new angle.',
    why: 'The opponent turns to face where the first technique came from. The second arrives from somewhere else, against a body still turning.',
    countered: 'By an opponent who turns with the movement rather than to the original position — which good footwork does automatically.',
    world: 'both',
  }),
  F({
    slug: 'block-counter',
    name: 'Receive and counter',
    shape: ['any uke-waza', 'gyaku-zuki'],
    purpose: 'The foundational defensive unit: receive the attack and answer into the opening it leaves.',
    why: 'Every block in the syllabus finishes with the hips loaded in hanmi. The counter uses that loading, which is why the two are one movement rather than two.',
    countered: 'By an attacker who does not over-commit, and who recovers before the counter arrives.',
    world: 'traditional',
  }),
];

// ─── Lookups ────────────────────────────────────────────────────────────────

const SYSTEM_BY_SLUG = new Map<string, KumiteSystem>(SYSTEMS.map((s) => [s.slug, s]));
const CONCEPT_BY_SLUG = new Map<string, KumiteConcept>(CONCEPTS.map((c) => [c.slug, c]));

export function kumiteSystem(slug: string | null | undefined): KumiteSystem | null {
  if (!slug) return null;
  return SYSTEM_BY_SLUG.get(slug) ?? null;
}

export function kumiteConcept(slug: string | null | undefined): KumiteConcept | null {
  if (!slug) return null;
  return CONCEPT_BY_SLUG.get(slug) ?? null;
}

export function conceptsInCategory(category: KumiteCategory): KumiteConcept[] {
  return CONCEPTS.filter((c) => c.category === category);
}

/** Everything that depends on a rule set, for the surfaces that must warn. */
export function rulesDependentEntries(): Array<KumiteSystem | KumiteConcept> {
  return [
    ...SYSTEMS.filter((s) => s.rulesDependent),
    ...CONCEPTS.filter((c) => c.rulesDependent),
  ];
}

/** Traditional development and sport, kept apart. §13. */
export function systemsInWorld(world: 'traditional' | 'sport'): KumiteSystem[] {
  return SYSTEMS.filter((s) => s.world === world);
}
