// Tsuki-waza, uke-waza and uchi-waza — the hand techniques.
//
// The rules that govern what may be written here live in ./kihon-types.ts and
// apply identically: no grade, no invented combination, no unreviewed bunkai,
// and no number that Shotokan has not actually settled.
//
// One idea recurs in almost every entry and is worth stating once at the top,
// because it is the thing that separates karate from swinging an arm:
//
//   THE ARM DOES NOT SUPPLY THE POWER. The hip supplies it, the back supplies
//   it, the floor supplies it. The arm delivers it and then gets out of the
//   way. Every "common error" below that mentions the shoulder is a symptom of
//   the same disease — an arm trying to do the body's job.

import { T, type Technique } from './kihon-types';

// ─── Tsuki-waza — thrusting techniques ──────────────────────────────────────

export const PUNCHES: readonly Technique[] = [
  T({
    slug: 'choku-zuki',
    name: 'Choku-zuki',
    kanji: '直突き',
    english: 'Straight punch',
    family: 'tsuki',
    aliases: ['choku zuki', 'choku tsuki', 'straight punch', 'chokuzuki'],
    summary:
      'The straight punch delivered from the natural stance, without stepping and without rotation of the body. It is the first punch taught and the one every other punch is measured against, because it isolates the single question that matters: does the fist travel straight to the target and arrive with the body behind it?',
    mechanics: {
      stance: 'Hachiji-dachi, hips square, weight even.',
      start: 'Fist chambered at the side of the ribs, palm upward, elbow behind the body line.',
      trajectory:
        'Straight out from the chamber along the shortest line to the target, the fist rotating palm-down through the last third of the travel.',
      hips: 'Square and still. Choku-zuki deliberately removes the hip so the arm action can be examined alone.',
      shoulders: 'Down and relaxed throughout. A rising shoulder shortens the reach and announces the punch.',
      elbows: 'Stays close to the body until it passes the ribs, then extends. The elbow never flares outward.',
      hikite:
        'The other hand withdraws to the opposite hip at exactly the same speed, palm turning upward. The two arms are one action, not two.',
      contact: 'The first two knuckles, wrist straight, forearm and back of the hand in one line.',
      kime: 'A momentary full-body contraction at the point of impact, released immediately.',
      recovery: 'The arm returns along the same line it went out on, without dropping.',
      breathing: 'Sharp exhale into the moment of kime.',
    },
    principles: [
      'The shortest line is the fastest line. Any curve in the path is time given to the opponent.',
      'Hikite is not decoration: the withdrawing hand accelerates the punching hand, and it is also the hand that has just grabbed something.',
      'Kime is a moment, not a state. Tension held after impact is tension that slows the next technique.',
    ],
    commonErrors: [
      {
        error: 'The shoulder rises and pushes the punch.',
        why: 'The arm is trying to generate power the body should be supplying.',
        fix: 'Punch with a partner’s hand resting on the shoulder. The shoulder should not lift into it.',
      },
      {
        error: 'The wrist bends on impact.',
        why: 'Weak wrist, or a fist that is not properly formed.',
        fix: 'Punch a makiwara or a pad slowly, checking the alignment of the knuckles, wrist and forearm at contact.',
      },
      {
        error: 'The hikite is slow or arrives late.',
        why: 'Attention is entirely on the punching arm.',
        fix: 'Practise the withdrawal alone, then together, insisting both hands finish on the same beat.',
      },
    ],
    drills: [
      'Slow repetitions with attention only on the line of travel.',
      'Alternating punches on a count, checking that both hands finish together every time.',
      'Punching with the back against a wall so the shoulder cannot travel forward.',
    ],
    application:
      'Rarely used in this exact form against a moving opponent. It exists to build the mechanics that oi-zuki, gyaku-zuki and kizami-zuki then apply at range.',
    relatedKata: [],
    relatedKumite: [],
    terms: ['choku-zuki', 'hikite', 'kime', 'seiken'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'oi-zuki',
    name: 'Oi-zuki',
    kanji: '追い突き',
    english: 'Lunge punch, stepping punch',
    family: 'tsuki',
    aliases: ['oi zuki', 'oi tsuki', 'lunge punch', 'stepping punch', 'oizuki'],
    summary:
      'A punch delivered by the hand on the same side as the stepping foot, arriving as the step lands. The whole body mass travels into the target, which makes it the heaviest punch in basic karate and the slowest to arrive — the trade that defines it.',
    mechanics: {
      stance: 'Zenkutsu-dachi, stepping through into zenkutsu-dachi.',
      start: 'Rear hand chambered; the rear foot begins the step.',
      trajectory:
        'The punch begins only as the stepping foot passes the supporting leg, and finishes exactly as the foot lands. Too early and the body arrives after the fist; too late and the momentum has already been spent.',
      hips: 'Square at the finish. The hips travel forward with the step rather than rotating.',
      shoulders: 'Square and level. The commonest fault is the punching shoulder reaching ahead of the hip.',
      hikite: 'The lead hand withdraws to the hip as the punch extends, on the same beat as the foot landing.',
      contact: 'First two knuckles, arm almost but not completely straight.',
      kime: 'Foot, hip and fist arrive together. If they do not, there is no kime — only a punch and a step.',
      distance: 'One full step. It is the technique that covers the most ground.',
      timing: 'Committed. Once the step begins there is no recalling it.',
      breathing: 'Exhale through the step, sharpest at the landing.',
    },
    principles: [
      'The timing IS the technique. Fist, hip and foot on one beat is the entire lesson.',
      'It is the most committed attack in the syllabus, and therefore the most punishable. Distance and timing have to be right before it is thrown.',
      'The step must not rise. A head that lifts through the step is visible from across the dojo, and from across the tatami.',
    ],
    commonErrors: [
      {
        error: 'The punch is thrown before the foot lands.',
        why: 'Anxiety to arrive, or practising the arm and the leg as separate actions.',
        fix: 'Step first with no punch at all, then add the punch and insist it starts only as the foot passes the supporting leg.',
      },
      {
        error: 'The body rises during the step.',
        why: 'Pushing up off the back leg instead of pulling with the front hip.',
        fix: 'Step under a low bar, real or imagined. Keep the crown at one height.',
      },
      {
        error: 'The punching shoulder leads.',
        why: 'Reaching for the target rather than travelling to it.',
        fix: 'Keep the shoulders square to the hips and let the stance deliver the distance.',
      },
    ],
    drills: [
      'Stepping up the floor without a punch, watching head height and stance width.',
      'Stepping with a partner holding a pad at the exact landing distance, so early and late are both obvious.',
      'Counting the beat aloud: one movement, one sound.',
    ],
    application:
      'Closing a large distance with maximum weight behind the technique. In sport kumite it is rarely thrown as a first attack against an alert opponent because of what it costs to commit, but it remains the standard by which basic power is judged.',
    relatedKata: ['heian-shodan', 'heian-nidan', 'heian-sandan', 'jion', 'kanku-dai'],
    relatedKumite: ['gohon-kumite', 'sanbon-kumite', 'kihon-ippon-kumite', 'maai'],
    terms: ['oi-zuki', 'hikite', 'kime', 'zenkutsu-dachi'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'gyaku-zuki',
    name: 'Gyaku-zuki',
    kanji: '逆突き',
    english: 'Reverse punch',
    family: 'tsuki',
    aliases: ['gyaku zuki', 'gyaku tsuki', 'reverse punch', 'gyakuzuki', 'gyaku-tsuki'],
    summary:
      'A punch delivered by the hand on the opposite side to the front foot, powered by rotating the hips from half-facing to square. It is the most-used scoring technique in the sport and, by most accounts, the most powerful single punch in karate — because the hip rotation, not the arm, throws it.',
    mechanics: {
      stance: 'Zenkutsu-dachi, starting hanmi and finishing square, the stance itself unmoved.',
      start: 'Rear hand chambered at the hip, hips half-facing, rear foot flat and loaded.',
      trajectory: 'Straight from chamber to target, the fist rotating palm-down in the last third.',
      hips:
        'The whole technique. The rear hip drives forward and around, rotating the body from hanmi to square. The punch is the last thing to arrive, not the first.',
      shoulders: 'Follow the hips, never lead them. Relaxed until the instant of impact.',
      elbows: 'Close to the body until past the ribs.',
      hikite: 'The lead hand withdraws sharply to the hip, adding to the rotation rather than merely retreating.',
      contact: 'First two knuckles, wrist straight, arm not locked.',
      kime: 'Hip rotation, rear-leg drive, hikite and fist arrive on one beat, and the whole body braces for an instant.',
      recovery: 'Return to guard immediately. A reverse punch admired after it lands is a counter invited.',
      distance: 'No step required, so it can be thrown from a guard already established.',
      breathing: 'Sharp exhale into kime.',
    },
    principles: [
      'The floor, the back leg, the hip, then the arm — in that order. Reverse the order and it becomes an arm punch.',
      'The back foot must stay grounded. It is the anchor the rotation works against; if it slides, the power leaks into the floor.',
      'It needs no step, which is why it counters everything. The opponent commits, the hips turn, the punch is already there.',
    ],
    commonErrors: [
      {
        error: 'The arm punches before the hip turns.',
        why: 'The arm is faster and more obvious, so it goes first.',
        fix: 'Punch with the hands on the hips at first, feeling the rotation alone. Then add the arm and keep the same sequence.',
      },
      {
        error: 'The back heel lifts or the back foot pivots away.',
        why: 'Over-rotating, or a stance too long for the hips to turn in.',
        fix: 'Keep the back foot planted and shorten the stance until the rotation can happen without it.',
      },
      {
        error: 'The body leans forward into the punch.',
        why: 'Reaching for distance the stance is not providing.',
        fix: 'Fix the distance first. The spine stays vertical over the hips.',
      },
      {
        error: 'The shoulder over-rotates past the hip.',
        why: 'Trying to add reach at the end of the technique.',
        fix: 'Shoulders and hips finish square together, and no further.',
      },
    ],
    drills: [
      'Hip rotation alone, hands on the hips, from hanmi to square and back.',
      'Gyaku-zuki against a pad from a fixed stance, checking that the back foot has not moved.',
      'Block-and-counter with a partner, where the counter must arrive before the attacker has recovered.',
    ],
    application:
      'The counter-punch of karate, and the single highest-scoring technique in competition kumite. It follows a block, it follows an evasion, it follows a feint, and it is the second half of most combinations in the sport.',
    relatedKata: ['heian-nidan', 'heian-sandan', 'heian-yondan', 'bassai-dai', 'kanku-dai', 'jion'],
    relatedKumite: ['go-no-sen', 'sen-no-sen', 'kumite-combination', 'kihon-ippon-kumite', 'jiyu-kumite'],
    terms: ['gyaku-zuki', 'hanmi', 'hikite', 'kime'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'kizami-zuki',
    name: 'Kizami-zuki',
    kanji: '刻み突き',
    english: 'Jab, leading-hand punch',
    family: 'tsuki',
    aliases: ['kizami zuki', 'kizami tsuki', 'jab', 'lead punch', 'leading hand punch', 'kizamizuki'],
    summary:
      'A punch with the front hand, usually with a short slide forward of the front foot. It has less mass behind it than the reverse punch and arrives far sooner, which in a sport where the first clean technique scores makes it the most productive attack in competition kumite.',
    mechanics: {
      stance: 'Free-fighting kamae, sliding forward; the hips rotate slightly forward rather than fully.',
      start: 'From the guard, with no chamber and no preparation — a chambered jab is a jab that has been announced.',
      trajectory: 'Directly from the guard position to the target along the shortest line.',
      hips: 'A small forward rotation of the front hip, timed with the slide of the front foot.',
      shoulders: 'The front shoulder extends slightly at the end, adding reach without leaning.',
      hikite: 'The rear hand stays up guarding the head. It does not withdraw to the hip — this is the point where sport kamae departs from basic kihon, and it departs on purpose.',
      contact: 'First two knuckles, controlled to the target as competition rules require.',
      kime: 'Brief and light. The technique is judged on control and timing, not on mass.',
      recovery: 'The hand snaps straight back to guard. Recovery speed matters more than delivery speed.',
      distance: 'Long, because it uses the front hand and a slide.',
      timing: 'Its entire value. Thrown as the opponent moves in, or as a feint to open a second technique.',
    },
    principles: [
      'No telegraph. A jab that starts with a shoulder twitch or a hand drop has already lost.',
      'Recovery is half the technique. The hand must be back before the counter arrives.',
      'It is as much a tool for measuring and disturbing distance as it is a scoring technique.',
    ],
    commonErrors: [
      {
        error: 'The hand drops or chambers before the punch.',
        why: 'Importing the chambering habit from basic kihon into free fighting.',
        fix: 'Practise in front of a mirror and remove every preparatory movement.',
      },
      {
        error: 'The rear hand drops while punching.',
        why: 'Attention entirely on the attacking hand.',
        fix: 'Drill with a partner throwing a light counter at the open side each time it drops.',
      },
      {
        error: 'Leaning forward to reach.',
        why: 'The distance was wrong before the punch started.',
        fix: 'Fix the footwork. The slide provides the distance; the spine stays over the hips.',
      },
    ],
    drills: [
      'Slide-and-jab down the floor, checking that nothing moves before the fist does.',
      'Jab into reverse punch on a pad, with the second technique arriving on the recovery of the first.',
      'Partner distance drill: jab only when the partner steps in, never on your own initiative.',
    ],
    application:
      'The opening technique of competition kumite: it scores, it measures distance, it interrupts an opponent’s preparation, and it sets up the reverse punch behind it.',
    relatedKata: [],
    relatedKumite: ['sen-no-sen', 'kumite-combination', 'feint', 'maai', 'jiyu-kumite', 'kumite-attack'],
    terms: ['kizami-zuki', 'kamae', 'maai'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'age-zuki',
    name: 'Age-zuki',
    kanji: '揚げ突き',
    english: 'Rising punch',
    family: 'tsuki',
    aliases: ['age zuki', 'age tsuki', 'rising punch', 'agezuki'],
    summary:
      'A punch travelling upward along a curved path to the underside of the jaw, delivered from close range where a straight punch has no room to develop.',
    mechanics: {
      start: 'From the hip or from the guard, at close range.',
      trajectory: 'A shallow upward arc rather than a straight line, finishing under the chin.',
      hips: 'Rotate as in gyaku-zuki, with the body rising slightly into the technique.',
      elbows: 'Stays bent throughout; the technique is not an extension but a lift.',
      contact: 'The first two knuckles, the fist turning palm-inward at impact.',
      kime: 'At the top of the arc, with the legs driving upward.',
      distance: 'Close. Outside that range it has no path.',
    },
    principles: [
      'The arc exists because the straight line is unavailable. Range dictates trajectory.',
      'Power comes from the legs rising, not from the arm lifting.',
    ],
    commonErrors: [
      {
        error: 'It becomes a wide hook.',
        why: 'Letting the elbow travel outward.',
        fix: 'Keep the elbow underneath the fist and the path tight to the centre.',
      },
      {
        error: 'Thrown at a distance where a straight punch would serve.',
        why: 'Choosing the technique before reading the range.',
        fix: 'Drill it only from genuinely close range so the choice becomes instinctive.',
      },
    ],
    drills: ['Close-range pad work with the pad held horizontally at chin height.'],
    application: 'Close-quarters counter to the jaw, particularly after slipping inside a straight attack.',
    relatedKata: ['empi'],
    relatedKumite: ['defensive-kumite'],
    terms: ['age-zuki', 'kime'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'tate-zuki',
    name: 'Tate-zuki',
    kanji: '立て突き',
    english: 'Vertical-fist punch',
    family: 'tsuki',
    aliases: ['tate zuki', 'tate tsuki', 'vertical punch', 'vertical fist punch', 'tatezuki'],
    summary:
      'A punch that stops with the fist vertical — thumb uppermost — rather than completing the rotation to palm-down. The shorter rotation suits medium range, and the vertical alignment is naturally strong for the wrist.',
    mechanics: {
      start: 'Chambered at the hip or held in guard.',
      trajectory: 'Straight, the fist rotating only ninety degrees so it finishes vertical.',
      hips: 'As gyaku-zuki, if delivered with the rear hand.',
      elbows: 'Remains slightly bent at full extension.',
      contact: 'First two knuckles, wrist straight, fist vertical.',
      distance: 'Medium — closer than a full straight punch, further than an ura-zuki.',
    },
    principles: [
      'The rotation is shortened because the distance is shortened. The two are the same decision.',
      'A vertical fist is a strong wrist alignment and a natural one for many people.',
    ],
    commonErrors: [
      {
        error: 'Completing the rotation to palm-down anyway.',
        why: 'Habit from choku-zuki.',
        fix: 'Practise slowly and stop the rotation deliberately.',
      },
    ],
    drills: ['Alternating tate-zuki and choku-zuki on a pad so the difference in range is felt, not memorised.'],
    application: 'Medium-range straight punching, particularly to the body where the elbow has less room.',
    relatedKata: ['bassai-sho'],
    relatedKumite: [],
    terms: ['tate-zuki', 'seiken'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'ura-zuki',
    name: 'Ura-zuki',
    kanji: '裏突き',
    english: 'Close punch, inverted punch',
    family: 'tsuki',
    aliases: ['ura zuki', 'ura tsuki', 'close punch', 'inverted punch', 'urazuki', 'uppercut'],
    summary:
      'A short punch delivered with the fist palm-upward and the elbow still bent, used at a range where nothing longer will fit. It is the karate answer to the uppercut, and it appears in kata wherever the opponent is imagined to be very close.',
    mechanics: {
      start: 'From the hip or the guard, at very close range.',
      trajectory: 'Short and upward-forward, the fist staying palm-up throughout.',
      hips: 'Rotate as normal; the shortness is in the arm, not in the body.',
      elbows: 'Stays bent — this is the defining feature, not a fault.',
      contact: 'First two knuckles, palm upward, to the solar plexus or the ribs.',
      distance: 'Very close. It is a technique of last resort in range terms.',
    },
    principles: [
      'A bent arm is not a weak arm at close range; a straight arm simply does not fit.',
      'The body must still rotate. Removing the hip because the arm is short removes the power too.',
    ],
    commonErrors: [
      {
        error: 'Trying to extend the arm.',
        why: 'Assuming every punch finishes straight.',
        fix: 'Set the distance so that extension is impossible, and the technique teaches itself.',
      },
    ],
    drills: ['Body-shot pad work at arm-fold distance, with the partner’s pad held against their own midsection.'],
    application: 'Infighting, and the counter after closing inside an opponent’s guard.',
    relatedKata: ['bassai-dai', 'unsu'],
    relatedKumite: ['defensive-kumite'],
    terms: ['ura-zuki'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'morote-zuki',
    name: 'Morote-zuki',
    kanji: '諸手突き',
    english: 'Double-hand punch, augmented punch',
    family: 'tsuki',
    aliases: ['morote zuki', 'morote tsuki', 'double punch', 'augmented punch', 'morotezuki'],
    summary:
      'Two fists delivered simultaneously to the same or adjacent targets, or one punch supported by the other hand. It trades the acceleration hikite provides for the combined mass of both arms and a fully square, committed body.',
    mechanics: {
      start: 'Both hands chambered, or one supporting the other at the elbow or wrist.',
      trajectory: 'Both fists travel together along parallel lines.',
      hips: 'Square and driving forward. There is no hikite, so the drive must come from the stance.',
      contact: 'First two knuckles of both fists.',
      kime: 'Both arms and the stance arrive on one beat.',
    },
    principles: [
      'Without hikite, the stance must supply what the withdrawing hand normally would.',
      'It commits both hands at once, so it is thrown when the outcome is already decided, not to open an exchange.',
    ],
    commonErrors: [
      {
        error: 'One hand arrives before the other.',
        why: 'The dominant arm leading.',
        fix: 'Slow repetitions until both arrive on the same beat.',
      },
    ],
    drills: ['Double pad work with a partner holding one pad in each hand at the correct spacing.'],
    application: 'A committed close-range attack, and in several kata the technique that finishes a sequence.',
    relatedKata: ['heian-godan', 'bassai-dai', 'kanku-dai'],
    relatedKumite: [],
    terms: ['morote-zuki'],
    contested: null,
    curriculum: null,
  }),
];

// ─── Uke-waza — receiving techniques ────────────────────────────────────────
//
// "Uke" is from ukeru, to receive, and the translation matters. A block that is
// only a barrier stops one attack and returns nothing. Every technique below is
// taught as a receipt that redirects, unbalances or damages, and that finishes
// in a position from which a counter is already available.

export const BLOCKS: readonly Technique[] = [
  T({
    slug: 'age-uke',
    name: 'Age-uke',
    kanji: '揚げ受け',
    english: 'Rising block',
    family: 'uke',
    aliases: ['age uke', 'rising block', 'upward block', 'jodan uke', 'ageuke'],
    summary:
      'A rising forearm block that deflects a descending or head-height attack upward and away. The forearm rotates as it rises so that the attack is turned aside rather than met head-on.',
    mechanics: {
      stance: 'Usually zenkutsu-dachi.',
      start: 'The blocking arm crosses the body low, the other arm extended forward; the two exchange positions.',
      trajectory: 'Rises in front of the face and finishes about a fist’s width above and in front of the forehead, forearm angled so the attack slides off.',
      hips: 'Rotate into the block, supplying the force so the arm does not have to.',
      elbows: 'Ends bent at roughly a right angle, the elbow lower than the fist and never flaring outward.',
      hikite: 'The other hand withdraws to the hip on the same beat.',
      contact: 'The outer forearm, near the wrist.',
      kime: 'The block finishes with the same sharpness as a punch — it is a technique, not a shield.',
    },
    principles: [
      'The angle of the forearm does the work. A horizontal forearm absorbs the whole attack; an angled one deflects it.',
      'Blocking arm and hikite are one action driven by one hip rotation.',
      'The finished position must not cover the eyes.',
    ],
    commonErrors: [
      {
        error: 'The block finishes too high, or on top of the head.',
        why: 'Fear of the attack.',
        fix: 'Set the finish a fist’s width above the forehead and check it in a mirror.',
      },
      {
        error: 'The elbow flares outward.',
        why: 'Lifting with the shoulder rather than rotating with the hip.',
        fix: 'Keep the elbow inside the line of the shoulder and let the hip drive.',
      },
      {
        error: 'Blocking with the arm alone.',
        why: 'The block is treated as a defensive reflex rather than a technique.',
        fix: 'Block a partner’s committed oi-zuki. An arm-only block fails immediately and audibly.',
      },
    ],
    drills: [
      'Age-uke stepping down the floor, checking the finishing height every repetition.',
      'Gohon kumite against jodan oi-zuki — five committed attacks, five blocks.',
      'Block into immediate gyaku-zuki, so the block is never the end of the movement.',
    ],
    application:
      'Receiving a descending strike or a head-height straight attack while moving the head off the line, and finishing with the hips loaded for a counter.',
    relatedKata: ['heian-shodan', 'heian-nidan', 'heian-yondan', 'jion'],
    relatedKumite: ['gohon-kumite', 'go-no-sen', 'defensive-kumite'],
    terms: ['age-uke', 'jodan', 'hikite'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'soto-uke',
    name: 'Soto-uke',
    kanji: '外受け',
    english: 'Outside block',
    family: 'uke',
    aliases: ['soto uke', 'outside block', 'outward block', 'soto ude uke', 'sotouke'],
    summary:
      'A block travelling from outside the body inward, striking the attacking limb with the outer forearm. Its natural finish leaves the arm across the body with the hips loaded, so the counter is already prepared.',
    mechanics: {
      stance: 'Zenkutsu-dachi or kokutsu-dachi.',
      start: 'Blocking arm raised beside the head, elbow high, fist at ear height.',
      trajectory: 'Sweeps down and across the body from outside to inside, finishing with the fist at shoulder height and the elbow bent at about ninety degrees.',
      hips: 'Rotate from square to hanmi, driving the block.',
      elbows: 'Stays bent and stays in front of the body; it does not travel behind the shoulder line.',
      hikite: 'Withdraws to the hip on the same beat.',
      contact: 'The outer forearm.',
      kime: 'Sharp, at the moment the forearm meets the attacking limb.',
    },
    principles: [
      'It is a strike to the attacking arm, not a push against it.',
      'The finishing position is hanmi and loaded — the block and the preparation for the counter are the same movement.',
    ],
    commonErrors: [
      {
        error: 'The elbow travels behind the body.',
        why: 'Winding up for extra force.',
        fix: 'Keep the elbow in front of the shoulder line throughout.',
      },
      {
        error: 'The block finishes too far across the body.',
        why: 'Over-rotating the hips.',
        fix: 'Finish with the fist in line with the shoulder, no further.',
      },
    ],
    drills: [
      'Soto-uke stepping down the floor.',
      'Soto-uke into gyaku-zuki, the two on consecutive beats.',
      'Sanbon kumite against chudan attacks.',
    ],
    application: 'Deflecting a straight attack to the middle level and immediately countering off the loaded hip.',
    relatedKata: ['heian-sandan', 'heian-godan', 'bassai-dai', 'jion'],
    relatedKumite: ['sanbon-kumite', 'go-no-sen', 'defensive-kumite'],
    terms: ['soto-uke', 'chudan', 'hanmi'],
    contested:
      'Shotokan organisations differ on whether "soto" names the direction the block travels or the surface of the arm that makes contact, with the result that soto-uke and uchi-uke are taught the other way round in some schools. The mechanics described here are the JKA-line convention; the name is the part that varies, not the movement.',
    curriculum: null,
  }),

  T({
    slug: 'uchi-uke',
    name: 'Uchi-uke',
    kanji: '内受け',
    english: 'Inside block',
    family: 'uke',
    aliases: ['uchi uke', 'inside block', 'inward block', 'uchi ude uke', 'uchiuke'],
    summary:
      'A block travelling from inside the body outward, meeting the attack with the inner forearm. It is the natural partner to soto-uke, covering the line that block does not.',
    mechanics: {
      stance: 'Zenkutsu-dachi or kokutsu-dachi.',
      start: 'Blocking arm crossed low across the body, the other arm extended.',
      trajectory: 'Sweeps upward and outward from the centre, finishing with the fist at shoulder height, elbow bent at about ninety degrees, forearm vertical.',
      hips: 'Rotate to drive the block outward.',
      elbows: 'Remains bent and close to the body throughout.',
      hikite: 'Withdraws to the hip on the same beat.',
      contact: 'The inner forearm.',
      kime: 'Sharp at contact, the forearm arriving rather than pushing.',
    },
    principles: [
      'Outward from the centre: it clears the centre line, which is the line most attacks travel along.',
      'The forearm finishes vertical. A forearm that finishes horizontal has become a push.',
    ],
    commonErrors: [
      {
        error: 'The elbow lifts away from the body.',
        why: 'Using the shoulder to generate the movement.',
        fix: 'Keep the elbow in and let the hip supply the force.',
      },
      {
        error: 'It becomes a wide sweep.',
        why: 'Over-travelling past the shoulder line.',
        fix: 'Stop at the shoulder line. Anything beyond it opens the ribs.',
      },
    ],
    drills: [
      'Uchi-uke stepping down the floor.',
      'Uchi-uke into gyaku-zuki, and into kizami-zuki, so the same block feeds two different counters.',
    ],
    application: 'Clearing a straight middle-level attack off the centre line and countering into the space it leaves.',
    relatedKata: ['heian-sandan', 'heian-yondan', 'bassai-dai', 'kanku-dai'],
    relatedKumite: ['go-no-sen', 'defensive-kumite'],
    terms: ['uchi-uke', 'chudan'],
    contested:
      'See the note on soto-uke: which of the two is called "inside" and which "outside" is not consistent between Shotokan organisations.',
    curriculum: null,
  }),

  T({
    slug: 'gedan-barai',
    name: 'Gedan-barai',
    kanji: '下段払い',
    english: 'Downward sweep, low-level block',
    family: 'uke',
    aliases: ['gedan barai', 'gedan harai', 'downward block', 'low block', 'down block', 'gedanbarai'],
    summary:
      'A downward sweeping block that clears an attack to the lower level — most often a front kick — with the outer forearm. It is the first block most students learn and the one that opens more Shotokan kata than any other.',
    mechanics: {
      stance: 'Zenkutsu-dachi.',
      start: 'Blocking fist raised to the opposite ear, the other arm extended downward across the body.',
      trajectory: 'Sweeps down and across, finishing with the fist about a fist’s width above the front knee and slightly outside the thigh.',
      hips: 'Rotate into the sweep, supplying the force.',
      elbows: 'Almost straight at the finish, but never locked.',
      hikite: 'Withdraws to the hip on the same beat.',
      contact: 'The outer forearm, near the wrist.',
      kime: 'Sharp at the finish, arriving rather than swiping.',
    },
    principles: [
      'It sweeps the attack aside; it does not chop down onto it.',
      'The finishing position — above and outside the knee — is what protects the leg and the groin. Too high leaves the leg open; too low overcommits.',
      'The hip rotation is what makes it work against a kick, which carries far more mass than an arm.',
    ],
    commonErrors: [
      {
        error: 'The block finishes too far across the body.',
        why: 'Over-rotating, or reaching for the attack.',
        fix: 'Finish outside the line of the thigh, above the knee.',
      },
      {
        error: 'Blocking with the arm alone against a kick.',
        why: 'Underestimating the mass of a leg.',
        fix: 'Block a partner’s controlled mae-geri. An arm-only block loses.',
      },
      {
        error: 'The body bends forward.',
        why: 'Following the arm downward.',
        fix: 'Keep the spine vertical; the arm travels, the torso does not.',
      },
    ],
    drills: [
      'Gedan-barai stepping down the floor.',
      'Against a partner’s controlled mae-geri, five repetitions each side.',
      'Gedan-barai into immediate gyaku-zuki.',
    ],
    application:
      'Deflecting a front kick or a low straight attack while turning the hips into a position from which the counter is already loaded. It is also the technique that opens Heian Shodan.',
    relatedKata: ['heian-shodan', 'heian-nidan', 'heian-sandan', 'heian-yondan', 'heian-godan', 'tekki-shodan', 'bassai-dai', 'jion'],
    relatedKumite: ['gohon-kumite', 'go-no-sen', 'defensive-kumite'],
    terms: ['gedan-barai', 'gedan', 'hikite'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'shuto-uke',
    name: 'Shuto-uke',
    kanji: '手刀受け',
    english: 'Knife-hand block',
    family: 'uke',
    aliases: ['shuto uke', 'knife hand block', 'sword hand block', 'shutouke'],
    summary:
      'A block made with the open hand, the little-finger edge cutting outward, almost always performed in kokutsu-dachi. Because the hand is open it can become a grab or a strike in the same movement, which is why it is taught as the most versatile of the receiving techniques.',
    mechanics: {
      stance: 'Kokutsu-dachi, hips hanmi.',
      start: 'Blocking hand at the opposite ear, palm toward the ear; the other hand extended forward.',
      trajectory: 'Cuts outward and forward, finishing with the hand open at shoulder height, elbow bent, forearm angled slightly forward.',
      hips: 'Half-facing at the finish, which narrows the target and pre-loads the counter.',
      elbows: 'Bent, held in front of the body, not locked.',
      hikite: 'The other hand withdraws to the solar plexus, palm up — not to the hip, and this differs from the closed-fist blocks deliberately.',
      contact: 'The outer edge of the hand, fingers straight and together, thumb bent and tucked.',
      kime: 'Sharp cut at the finish.',
    },
    principles: [
      'An open hand can receive, grab, pull and strike. That optionality is the technique’s real value.',
      'The hanmi position of kokutsu-dachi is inseparable from the block — the two are learned together.',
      'The fingers must be together and the thumb tucked, or the hand is a liability rather than a weapon.',
    ],
    commonErrors: [
      {
        error: 'Fingers splayed or thumb sticking out.',
        why: 'Not attending to the hand itself.',
        fix: 'Check the hand shape at every finish. A splayed hand breaks fingers.',
      },
      {
        error: 'The withdrawing hand goes to the hip.',
        why: 'Habit from the closed-fist blocks.',
        fix: 'It finishes at the solar plexus, palm up, ready to strike or grab.',
      },
      {
        error: 'The stance and the block do not finish together.',
        why: 'Practising the two separately for too long.',
        fix: 'Slow repetitions insisting on one beat.',
      },
    ],
    drills: [
      'Shuto-uke stepping backwards down the floor in kokutsu-dachi.',
      'Shuto-uke into nukite or into shuto-uchi, so the open hand is used as an open hand.',
      'Kihon ippon kumite using shuto-uke as the receipt.',
    ],
    application:
      'Receiving an attack while withdrawing the body, with the option to grab the attacking limb and pull the opponent onto the counter.',
    relatedKata: ['heian-nidan', 'heian-sandan', 'heian-yondan', 'heian-godan', 'bassai-dai', 'kanku-dai', 'jion'],
    relatedKumite: ['kihon-ippon-kumite', 'go-no-sen', 'defensive-kumite'],
    terms: ['shuto-uke', 'kokutsu-dachi', 'hanmi', 'shuto'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'morote-uke',
    name: 'Morote-uke',
    kanji: '諸手受け',
    english: 'Augmented block, two-hand block',
    family: 'uke',
    aliases: ['morote uke', 'augmented block', 'double hand block', 'reinforced block', 'moroteuke'],
    summary:
      'An uchi-uke supported by the other hand pressing against the inside of the blocking forearm or elbow. The supporting hand adds force and stability against an attack too strong to receive with one arm.',
    mechanics: {
      start: 'As uchi-uke, with the supporting hand travelling with the blocking arm.',
      trajectory: 'The blocking arm performs uchi-uke; the supporting fist arrives against the inner forearm near the elbow.',
      hips: 'Rotate as for uchi-uke; both arms are driven by one rotation.',
      contact: 'The inner forearm of the blocking arm.',
      kime: 'Both arms and the stance on one beat.',
    },
    principles: [
      'It buys strength by spending the other hand. That is a real cost, not a free upgrade.',
      'The support presses; it does not merely rest alongside.',
    ],
    commonErrors: [
      {
        error: 'The supporting hand is decorative.',
        why: 'Copying the shape without the pressure.',
        fix: 'Have a partner push against the block. The support either contributes or it does not.',
      },
    ],
    drills: ['Partner pressure-testing the block from the front, with and without the supporting hand.'],
    application: 'Receiving a heavy committed attack when the other hand is not needed elsewhere.',
    relatedKata: ['heian-sandan', 'bassai-dai', 'jion'],
    relatedKumite: ['defensive-kumite'],
    terms: ['morote-uke', 'uchi-uke'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'juji-uke',
    name: 'Juji-uke',
    kanji: '十字受け',
    english: 'Cross block, X block',
    family: 'uke',
    aliases: ['juji uke', 'cross block', 'x block', 'jujiuke'],
    summary:
      'Both forearms crossed at the wrists to receive an attack in the fork they make — downward against a kick, upward against a descending strike. The crossed position naturally becomes a grab, which is how it is most often applied.',
    mechanics: {
      start: 'Both hands chambered or in guard.',
      trajectory: 'Both arms travel together to meet, wrists crossing, either downward to gedan or upward to jodan.',
      hips: 'Square and driving into the block.',
      contact: 'The crossed wrists and forearms.',
      kime: 'Both arms and the stance on one beat.',
      recovery: 'Frequently by grasping the received limb and twisting, rather than by returning to guard.',
    },
    principles: [
      'The fork traps as much as it blocks. It is a beginning, not a conclusion.',
      'It commits both hands, so it is chosen against a threat serious enough to justify that.',
    ],
    commonErrors: [
      {
        error: 'The wrists cross too far up the forearm.',
        why: 'Reaching, or an imprecise finish.',
        fix: 'Cross at the wrists so the fork is at its narrowest and strongest.',
      },
      {
        error: 'Blocking and stopping.',
        why: 'Treating it as a barrier.',
        fix: 'Always follow with the grab. The kata that contain it do.',
      },
    ],
    drills: ['Against a partner’s controlled mae-geri, receiving and then grasping the ankle.'],
    application: 'Receiving and trapping a committed kick or a descending attack, leading directly to a grab or a throw.',
    relatedKata: ['heian-godan', 'bassai-dai', 'jion', 'gankaku'],
    relatedKumite: ['defensive-kumite'],
    terms: ['juji-uke', 'gedan', 'jodan'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'kakiwake-uke',
    name: 'Kakiwake-uke',
    kanji: '掻き分け受け',
    english: 'Wedge block, parting block',
    family: 'uke',
    aliases: ['kakiwake uke', 'wedge block', 'parting block', 'kakiwakeuke'],
    summary:
      'Both forearms start crossed at the centre and drive outward, parting a two-handed grab or forcing an opening between two arms. It is a release as much as a block.',
    mechanics: {
      stance: 'Often hangetsu-dachi or zenkutsu-dachi.',
      start: 'Both arms crossed in front of the chest, palms inward.',
      trajectory: 'Both forearms rotate and drive outward and slightly downward, ending about shoulder-width apart with the elbows bent.',
      hips: 'Square, with the body sinking into the stance to add force.',
      contact: 'The outer forearms.',
      kime: 'Both arms and the sinking of the stance on one beat.',
    },
    principles: [
      'It answers a grab, not a strike. The problem it solves is being held.',
      'The power comes from the body sinking and the back opening, not from the arms pushing apart.',
    ],
    commonErrors: [
      {
        error: 'Pushing the arms apart with the shoulders.',
        why: 'Treating it as an arm action.',
        fix: 'Sink into the stance and open the back; the arms travel as a consequence.',
      },
    ],
    drills: ['Partner takes a two-handed lapel grip; release with kakiwake-uke and follow immediately with a counter.'],
    application: 'Breaking a two-handed grab to the chest or lapels and opening the centre for a counter.',
    relatedKata: ['heian-yondan', 'hangetsu'],
    relatedKumite: ['defensive-kumite'],
    terms: ['kakiwake-uke'],
    contested: null,
    curriculum: null,
  }),
];

// ─── Uchi-waza — striking techniques ────────────────────────────────────────

export const STRIKES: readonly Technique[] = [
  T({
    slug: 'shuto-uchi',
    name: 'Shuto-uchi',
    kanji: '手刀打ち',
    english: 'Knife-hand strike',
    family: 'uchi',
    aliases: ['shuto uchi', 'knife hand strike', 'sword hand strike', 'shutouchi'],
    summary:
      'A strike with the little-finger edge of the open hand, travelling in an arc to the neck, temple or collarbone. The open hand concentrates the force on a narrow edge, which is why it is aimed at soft or bony targets rather than at mass.',
    mechanics: {
      start: 'Striking hand raised beside or behind the opposite ear, palm toward the ear.',
      trajectory: 'An arc travelling outward and forward — either inward across the body (uchi) or outward away from it (soto).',
      hips: 'Rotate into the strike; the arc is driven by the body turning.',
      elbows: 'Extends through the arc, staying slightly bent at impact.',
      hikite: 'Withdraws sharply to accelerate the strike.',
      contact: 'The muscular edge of the hand below the little finger, fingers together and straight, thumb bent and tucked.',
      kime: 'Sharp snap at impact, the hand tightening at the last instant.',
      target: 'Side of the neck, temple, collarbone, floating ribs.',
    },
    principles: [
      'The hand tightens only at impact. A hand held rigid through the arc travels slowly.',
      'It is a strike to a specific small target, not a general blow.',
      'The same hand shape as shuto-uke, which is why the block converts into the strike so readily.',
    ],
    commonErrors: [
      {
        error: 'Striking with the fingers or the wrist rather than the hand edge.',
        why: 'Poor hand shape, or a bent wrist at impact.',
        fix: 'Strike a focus pad slowly, checking the contact point each time.',
      },
      {
        error: 'The arc is generated by the arm.',
        why: 'Neglecting the hip.',
        fix: 'Strike with the feet fixed and the hips turning; the arm follows.',
      },
    ],
    drills: ['Focus-pad work at neck height, alternating inward and outward strikes.'],
    application: 'Striking the neck or temple after receiving an attack, particularly following a shuto-uke that has grabbed and pulled.',
    relatedKata: ['heian-sandan', 'heian-yondan', 'bassai-dai', 'jitte'],
    relatedKumite: ['defensive-kumite'],
    terms: ['shuto-uchi', 'shuto', 'hikite'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'uraken-uchi',
    name: 'Uraken-uchi',
    kanji: '裏拳打ち',
    english: 'Back-fist strike',
    family: 'uchi',
    aliases: ['uraken uchi', 'back fist', 'backfist strike', 'urakenuchi', 'uraken'],
    summary:
      'A whipping strike with the back of the first two knuckles, delivered by snapping the forearm out from a bent elbow. It is fast because it is short, and it recovers instantly, which makes it a natural counter and a natural feint.',
    mechanics: {
      start: 'Elbow raised and bent, fist near the opposite shoulder or beside the head.',
      trajectory: 'The forearm snaps outward around the fixed elbow; the elbow itself barely moves.',
      hips: 'A small rotation, or a body drop, supplies the force.',
      elbows: 'The pivot. If the elbow travels, the technique has become a swing.',
      contact: 'The back of the first two knuckles.',
      kime: 'An instant snap, immediately released.',
      recovery: 'The hand whips back along its own path — as fast out as in.',
      target: 'Temple, bridge of the nose, ribs.',
    },
    principles: [
      'The elbow is a hinge, not a lever. Everything good about the technique comes from that.',
      'Snap and return. A back-fist left extended is an arm offered to the opponent.',
    ],
    commonErrors: [
      {
        error: 'The elbow travels with the fist.',
        why: 'Swinging the whole arm.',
        fix: 'Hold the elbow in place with the other hand and snap the forearm alone.',
      },
      {
        error: 'The strike is pushed rather than snapped.',
        why: 'Tension in the arm.',
        fix: 'Relax entirely until the last instant.',
      },
    ],
    drills: ['Snap the forearm out and back against a hanging target, counting only the return speed.'],
    application: 'A fast counter to the head, a strike to the side in Tekki, and one of the most economical feints available.',
    relatedKata: ['heian-nidan', 'heian-godan', 'tekki-shodan', 'bassai-dai', 'empi'],
    relatedKumite: ['feint', 'kumite-combination'],
    terms: ['uraken-uchi', 'uraken'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'tetsui-uchi',
    name: 'Tetsui-uchi',
    kanji: '鉄鎚打ち',
    english: 'Hammer-fist strike',
    family: 'uchi',
    aliases: ['tetsui uchi', 'hammer fist', 'bottom fist strike', 'kentsui', 'tetsuiuchi'],
    summary:
      'A strike with the muscular little-finger side of the closed fist, swung like a hammer. It is the most forgiving strike in the syllabus — the contact surface is padded and robust, so it does not require the precise alignment a straight punch does.',
    mechanics: {
      start: 'Fist raised, elbow bent, arm cocked across or above the body.',
      trajectory: 'A downward or lateral arc, driven by the body.',
      hips: 'Rotate, or the body drops, to supply the force.',
      contact: 'The padded outer edge of the fist below the little finger.',
      kime: 'At the bottom of the arc.',
      target: 'Collarbone, temple, forearm, bridge of the nose, sternum.',
    },
    principles: [
      'A robust surface means it can be thrown at hard targets a straight punch should not meet.',
      'It is the natural human striking motion, refined rather than replaced.',
    ],
    commonErrors: [
      {
        error: 'Striking with the knuckles instead of the fist edge.',
        why: 'The fist rotating in flight.',
        fix: 'Check the contact surface on a pad, slowly.',
      },
    ],
    drills: ['Downward strikes onto a floor-held pad, checking the contact surface each repetition.'],
    application: 'A close-range strike to bone or to a grabbing arm, and a technique that works when precision has failed.',
    relatedKata: ['heian-shodan', 'tekki-shodan', 'bassai-dai'],
    relatedKumite: [],
    terms: ['tetsui-uchi', 'tetsui'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'empi-uchi',
    name: 'Empi-uchi',
    kanji: '猿臂打ち',
    english: 'Elbow strike',
    family: 'uchi',
    aliases: ['empi uchi', 'enpi uchi', 'elbow strike', 'hiji ate', 'hiji-ate', 'empiuchi', 'empi'],
    summary:
      'A strike with the point of the elbow, delivered forward, upward, sideways, downward or backward. At close range it is the most powerful weapon the body has: the shortest lever, the hardest surface, and the whole body behind it.',
    mechanics: {
      start: 'From the guard or the hip, at close range.',
      trajectory: 'Short and direct along one of five lines — mae, age, yoko, otoshi or ushiro.',
      hips: 'Supply nearly all the power. The arm barely travels.',
      shoulders: 'Stay down; a raised shoulder shortens the strike and weakens it.',
      hikite: 'The other hand withdraws or grips the opponent to hold them in range.',
      contact: 'The point of the elbow or the bone just above it.',
      kime: 'At impact, with the body settling into it.',
      distance: 'Very close. Outside that, it cannot reach.',
    },
    principles: [
      'The shortest lever carries the most force. What it lacks in reach it returns in power.',
      'The power is entirely in the body turning or dropping. An elbow thrown with the arm is barely a strike.',
      'Grip and strike together: the other hand holds the target in place.',
    ],
    commonErrors: [
      {
        error: 'Throwing it from too far away.',
        why: 'Not reading the range.',
        fix: 'Drill it only from genuinely close range.',
      },
      {
        error: 'The shoulder rises.',
        why: 'Trying to add reach.',
        fix: 'Keep the shoulder down and turn the body further instead.',
      },
    ],
    drills: [
      'Pad work in all five directions from a fixed close distance.',
      'Grip the partner’s sleeve with one hand and strike with the other, so the two actions become one.',
    ],
    application: 'Infighting, the answer to a grab, and the reason the kata Enpi carries its name.',
    relatedKata: ['heian-nidan', 'heian-sandan', 'heian-yondan', 'tekki-shodan', 'empi', 'jion'],
    relatedKumite: ['defensive-kumite'],
    terms: ['empi-uchi', 'kime'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'haito-uchi',
    name: 'Haito-uchi',
    kanji: '背刀打ち',
    english: 'Ridge-hand strike',
    family: 'uchi',
    aliases: ['haito uchi', 'ridge hand', 'ridge hand strike', 'haitouchi', 'haito'],
    summary:
      'A strike with the thumb edge of the open hand, swung in a wide arc from outside to inside. It reaches around a guard to targets a straight technique cannot find.',
    mechanics: {
      start: 'Arm extended out to the side, hand open, thumb bent and tucked underneath.',
      trajectory: 'A wide horizontal arc from outside to inside.',
      hips: 'Rotate strongly; the arc is long and needs driving.',
      contact: 'The thumb-side edge of the hand, with the thumb folded under and out of the way.',
      kime: 'At impact, the hand tightening only then.',
      target: 'Side of the neck, temple, ribs.',
    },
    principles: [
      'The wide arc is the point — it curves around the guard.',
      'The thumb must be tucked. An extended thumb takes the impact and breaks.',
    ],
    commonErrors: [
      {
        error: 'The thumb is left out.',
        why: 'Not attending to the hand shape.',
        fix: 'Fold the thumb tightly under the palm and check it every repetition.',
      },
      {
        error: 'The arc is telegraphed.',
        why: 'It is a long path and the preparation is visible.',
        fix: 'Use it as a counter or behind a feint, not as a lead attack.',
      },
    ],
    drills: ['Pad work with the pad held at the side of the head, so the arc must genuinely travel around.'],
    application: 'Reaching around a guard to the neck or temple, usually as a counter or the second technique of a combination.',
    relatedKata: ['heian-godan', 'unsu', 'gankaku'],
    relatedKumite: ['kumite-combination'],
    terms: ['haito-uchi', 'haito'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'teisho-uchi',
    name: 'Teisho-uchi',
    kanji: '底掌打ち',
    english: 'Palm-heel strike',
    family: 'uchi',
    aliases: ['teisho uchi', 'palm heel strike', 'palm heel', 'shotei', 'teishouchi', 'teisho'],
    summary:
      'A strike with the heel of the palm, the wrist bent back and the fingers lifted clear. It puts a large, robust surface behind the whole arm and is far more forgiving of imperfect alignment than a closed fist.',
    mechanics: {
      start: 'From the hip or the guard.',
      trajectory: 'Straight forward, or upward to the chin, the wrist bending back as it arrives.',
      hips: 'Rotate as for a punch.',
      contact: 'The heel of the palm, wrist bent back, fingers curled clear of the target.',
      kime: 'At impact, with the wrist held firm.',
      target: 'Chin, nose, sternum, ribs.',
    },
    principles: [
      'No knuckles to break, and no wrist alignment to get wrong. It is the strike that keeps working under stress.',
      'The bent wrist is a strong structure, not a weak one, provided the elbow is behind it.',
    ],
    commonErrors: [
      {
        error: 'The fingers strike the target.',
        why: 'Insufficient wrist extension.',
        fix: 'Bend the wrist back fully and curl the fingers.',
      },
    ],
    drills: ['Pad work checking the contact surface, and upward strikes to a pad held at chin height.'],
    application: 'Close-range striking where a fist is a liability, and — because it does not require a formed fist — a technique that suits self-defence teaching.',
    relatedKata: ['jitte', 'unsu', 'wankan'],
    relatedKumite: ['defensive-kumite'],
    terms: ['teisho-uchi', 'teisho'],
    contested: null,
    curriculum: null,
  }),
];
