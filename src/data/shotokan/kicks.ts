// Geri-waza and the body-movement techniques — tai-sabaki and ashi-sabaki.
//
// The rules in ./kihon-types.ts apply here too. One idea governs every kick in
// the file and is stated once rather than eight times:
//
//   THE KNEE TRAVELS FIRST, AND THE FOOT COMES BACK BEFORE IT GOES DOWN.
//
// The chamber — hiza no kamae, the raised and folded knee — is what makes a
// kick a kick rather than a swing of the leg. It hides which kick is coming,
// it puts the joint in a position to extend fast, and it is why the retraction
// is possible at all. A leg that is not re-chambered before it lands is a leg
// somebody else now owns: it can be caught, swept, or simply walked past while
// its owner is standing on one foot. Every entry below repeats the retraction
// instruction because in practice it is the first thing to disappear under
// fatigue.

import { T, type Technique } from './kihon-types';

// ─── Geri-waza — kicking techniques ─────────────────────────────────────────

export const KICKS: readonly Technique[] = [
  T({
    slug: 'mae-geri',
    name: 'Mae-geri',
    kanji: '前蹴り',
    english: 'Front kick',
    family: 'geri',
    aliases: ['mae geri', 'front kick', 'maegeri', 'mae-geri keage', 'mae geri kekomi'],
    summary:
      'The straight kick to the front, delivered with the ball of the foot from a raised and folded knee. It is the first kick taught and the foundation of all the others, because it establishes the chamber-extend-retract cycle that every kick in the syllabus follows.',
    mechanics: {
      stance: 'From zenkutsu-dachi, kokutsu-dachi or free-fighting kamae.',
      chamber:
        'The knee lifts to the target height and the heel folds tight to the buttock. The chamber is set before anything extends, and it is what conceals whether the kick will be mae-geri, mawashi-geri or something else.',
      supportFoot: 'Flat and stable, or pivoting slightly outward as the hip opens. The weight sits over its whole sole, not on the toes.',
      hips: 'Push forward and slightly upward as the leg extends, which is where the penetration comes from.',
      trajectory: 'Straight forward from the chamber along the shortest line to the target.',
      extension: 'The lower leg snaps out from the knee. The toes pull back hard so the ball of the foot leads.',
      contact: 'The ball of the foot — koshi — with the toes pulled up out of the way.',
      target: 'Solar plexus, lower abdomen, or the chin.',
      retraction: 'Snap the lower leg back into the chamber immediately, before the foot is set down anywhere.',
      balance: 'The supporting knee stays soft. The torso stays upright — leaning back to reach is losing balance in advance.',
      guard: 'Both hands stay up. A kick is not a reason to lower the hands.',
      kime: 'At full extension, momentary.',
      breathing: 'Exhale sharply into the extension.',
    },
    principles: [
      'Chamber, extend, retract, place. Four beats, always in that order, however fast it is thrown.',
      'The toes pull back before the kick lands, not as it lands. Kicking with the toes injures the kicker.',
      'The hip drives forward. Snapping only the knee produces a kick that lands but does not penetrate.',
    ],
    commonErrors: [
      {
        error: 'The leg swings up without chambering.',
        why: 'Rushing, or insufficient hip flexor strength.',
        fix: 'Practise the chamber alone, holding it, then extend from the hold.',
      },
      {
        error: 'The foot goes straight to the floor after the kick.',
        why: 'Fatigue, and the fact that not re-chambering is easier.',
        fix: 'Kick, re-chamber, hold the chamber for a count, then place. Insist on the hold.',
      },
      {
        error: 'The body leans back.',
        why: 'Reaching for a target that is too far away.',
        fix: 'Fix the distance. The spine stays vertical over the supporting hip.',
      },
      {
        error: 'The toes are not pulled back.',
        why: 'Not attending to the foot.',
        fix: 'Kick a pad slowly and check the contact surface every repetition.',
      },
    ],
    drills: [
      'Chamber only, held for a count, both legs, no extension at all.',
      'Kick, re-chamber, hold, place — deliberately slowly.',
      'Front kick against a held pad, checking the ball of the foot makes contact.',
      'Front-leg kick from kamae with no weight shift beforehand.',
    ],
    application:
      'Stopping an opponent moving in, and attacking the midsection at a range where hands do not yet reach. Its chamber is also the disguise from which several other kicks are launched.',
    relatedKata: ['heian-shodan', 'heian-nidan', 'heian-sandan', 'heian-yondan', 'bassai-dai', 'kanku-dai', 'jion'],
    relatedKumite: ['gohon-kumite', 'sanbon-kumite', 'kihon-ippon-kumite', 'maai', 'kumite-attack'],
    terms: ['mae-geri', 'koshi', 'hiza'],
    contested:
      'Whether mae-geri is trained primarily as keage — a snap — or as kekomi — a thrust — differs by organisation and by grade. Both exist; the chamber and the retraction are identical in either case.',
    curriculum: null,
  }),

  T({
    slug: 'yoko-geri-keage',
    name: 'Yoko-geri keage',
    kanji: '横蹴り上げ',
    english: 'Side snap kick',
    family: 'geri',
    aliases: ['yoko geri keage', 'side snap kick', 'yokogeri keage', 'keage'],
    summary:
      'A snapping kick to the side with the outer edge of the foot, travelling in a rising arc. It is fast and light rather than heavy, aimed at the ribs, the armpit or the head, and it belongs to the Tekki series where the whole fight is imagined to be sideways.',
    mechanics: {
      chamber: 'The knee lifts across the front of the body, foot folded, ready to whip outward.',
      supportFoot: 'Pivots so the heel points toward the target.',
      hips: 'Open sideways as the leg extends.',
      trajectory: 'A rising arc outward and upward from the chamber.',
      extension: 'A snap from the knee, the leg not fully locking out.',
      contact: 'The outer edge of the foot — sokuto — with the foot edge turned down and the toes pulled up.',
      target: 'Ribs, armpit, side of the head.',
      retraction: 'Snap straight back to the chamber. This kick is defined by its return.',
      balance: 'Torso leans slightly away from the kick to counterbalance, but the spine does not collapse sideways.',
      guard: 'Hands stay up, particularly on the side being turned away from.',
    },
    principles: [
      'Snap, not push. Keage is a whip; kekomi is a thrust, and confusing the two produces neither.',
      'The foot edge is the weapon. A kick landing on the sole has missed its own point.',
    ],
    commonErrors: [
      {
        error: 'It lands on the sole of the foot.',
        why: 'The ankle is not turned.',
        fix: 'Turn the foot edge down and toes up in the chamber, before extending.',
      },
      {
        error: 'The support foot does not pivot.',
        why: 'Neglecting the supporting side.',
        fix: 'Practise the pivot alone until it happens without thought.',
      },
    ],
    drills: [
      'Kiba-dachi with keage to alternate sides, checking the foot edge each time.',
      'Tekki Shodan performed slowly with attention on the kicking side only.',
    ],
    application: 'Striking to the side at close to medium range, particularly in the confined lateral fighting the Tekki series trains.',
    relatedKata: ['heian-nidan', 'tekki-shodan', 'tekki-nidan', 'tekki-sandan', 'kanku-dai'],
    relatedKumite: [],
    terms: ['yoko-geri-keage', 'sokuto', 'kiba-dachi'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'yoko-geri-kekomi',
    name: 'Yoko-geri kekomi',
    kanji: '横蹴り込み',
    english: 'Side thrust kick',
    family: 'geri',
    aliases: ['yoko geri kekomi', 'side thrust kick', 'side kick', 'yokogeri kekomi', 'kekomi'],
    summary:
      'A thrusting kick to the side driven through the target with the outer edge of the foot. Where keage snaps and returns, kekomi penetrates: the hip drives through, the body commits, and the kick is the heaviest in the syllabus.',
    mechanics: {
      chamber: 'The knee lifts across the body as for keage; the chamber is deliberately identical so the two cannot be told apart until the leg extends.',
      supportFoot: 'Pivots until the heel points at the target, and often beyond.',
      hips: 'Thrust through the target. This is the entire difference from keage.',
      trajectory: 'Straight and horizontal, driving through rather than up.',
      extension: 'Full, the leg pushing through the target rather than snapping at it.',
      contact: 'The outer edge of the foot, or the heel.',
      target: 'Ribs, midsection, knee, thigh.',
      retraction: 'Pull back to the chamber before placing. The commitment makes this harder and more necessary.',
      balance: 'The torso leans away in proportion to the height of the kick; the supporting leg stays strong.',
      guard: 'Both hands up throughout.',
    },
    principles: [
      'Kekomi and keage share a chamber and differ only in what happens next. That shared chamber is a tactical asset.',
      'It is a thrust, so it needs a braced supporting leg and a committed hip.',
      'It is heavy and therefore slow to recover. Distance must be right before it is thrown.',
    ],
    commonErrors: [
      {
        error: 'It becomes a push with no snap of the hip.',
        why: 'Confusing "thrust" with "lean".',
        fix: 'Drive the hip into the target and keep the supporting leg braced.',
      },
      {
        error: 'The kick rises like a keage.',
        why: 'Habit from the snapping version.',
        fix: 'Kick at a pad held at hip height and insist the path is horizontal.',
      },
    ],
    drills: [
      'Slow kekomi holding the chamber, extending, holding the extension, re-chambering.',
      'Kekomi against a heavy pad, feeling the difference from keage in the same session.',
    ],
    application: 'Stopping an advancing opponent, attacking the ribs or midsection heavily, and attacking the leg at close range.',
    relatedKata: ['heian-yondan', 'heian-godan', 'kanku-dai', 'gankaku'],
    relatedKumite: ['maai', 'kumite-attack'],
    terms: ['yoko-geri-kekomi', 'sokuto'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'mawashi-geri',
    name: 'Mawashi-geri',
    kanji: '回し蹴り',
    english: 'Roundhouse kick',
    family: 'geri',
    aliases: ['mawashi geri', 'roundhouse kick', 'round kick', 'mawashigeri'],
    summary:
      'A circular kick travelling from the outside inward to the ribs, the body or the head, delivered with the instep or the ball of the foot. It is the most-used kick in competition kumite because it curves around a guard that a straight kick would run into.',
    mechanics: {
      chamber: 'The knee lifts to the side and points at the target; the lower leg is folded back and hangs loose.',
      supportFoot: 'Pivots until the heel points at, or past, the target. Insufficient pivot is what limits the height and strains the supporting knee.',
      hips: 'Rotate over the supporting leg and drive through — the hip, not the leg, throws this kick.',
      trajectory: 'A horizontal arc from outside to inside.',
      extension: 'The lower leg whips out from the knee at the last moment.',
      contact: 'The instep — haisoku — or the ball of the foot where the rules and the target require it.',
      target: 'Thigh, ribs, side of the head.',
      retraction: 'Fold the lower leg straight back to the chamber and set the foot down under control.',
      balance: 'The supporting leg stays slightly bent; the torso leans away only as far as the height demands.',
      guard: 'Both hands stay up. The commonest counter to a roundhouse is a straight punch through the gap the dropped hand leaves.',
    },
    principles: [
      'The support-foot pivot governs everything: the height available, the power delivered and the safety of the knee.',
      'The knee points at the target before the leg extends. That is what makes the kick arrive from an angle the guard is not covering.',
      'It is thrown by the hip rotating over the supporting leg.',
    ],
    commonErrors: [
      {
        error: 'The supporting foot does not pivot.',
        why: 'Rushing the kick, or weak ankle mobility.',
        fix: 'Slow repetitions with the pivot exaggerated, then at speed.',
      },
      {
        error: 'The kick is swung from the hip with a straight leg.',
        why: 'Skipping the chamber.',
        fix: 'Chamber, hold, then extend. Repeat until the chamber is automatic.',
      },
      {
        error: 'The opposite hand drops.',
        why: 'Using the arm for balance.',
        fix: 'Kick with a partner ready to counter the moment the hand drops.',
      },
    ],
    drills: [
      'Chamber and hold, checking the knee points at the target.',
      'Pad work at three heights — thigh, ribs, head — in one set.',
      'Front-leg mawashi from kamae, with no preparatory weight shift.',
    ],
    application:
      'The principal kicking attack of competition kumite, curving around the guard to the ribs or head, and equally useful as the second technique after a hand attack has drawn the guard.',
    relatedKata: ['heian-godan', 'unsu'],
    relatedKumite: ['kumite-attack', 'kumite-combination', 'jiyu-kumite'],
    terms: ['mawashi-geri', 'haisoku'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'ushiro-geri',
    name: 'Ushiro-geri',
    kanji: '後ろ蹴り',
    english: 'Back kick',
    family: 'geri',
    aliases: ['ushiro geri', 'back kick', 'ushirogeri', 'ushiro geri kekomi'],
    summary:
      'A thrusting kick straight to the rear with the heel, the body turning to look over the shoulder at the target. It is the most powerful kick in karate and the most dangerous to throw, because for a moment the kicker cannot see.',
    mechanics: {
      chamber: 'The knee lifts and folds with the leg close to the supporting one; the body begins to turn.',
      supportFoot: 'Pivots so the toes point away from the target.',
      hips: 'Thrust straight backward along the line of the kick.',
      trajectory: 'Straight to the rear, the heel leading, the leg travelling close past the supporting leg.',
      extension: 'Full thrust, driving through the target.',
      contact: 'The heel.',
      target: 'Midsection, solar plexus.',
      retraction: 'Pull back to the chamber and turn to face the opponent immediately.',
      balance: 'The head turns to find the target before the leg extends — the eyes lead.',
      guard: 'Hands stay up through the turn, and the turn is completed fast.',
    },
    principles: [
      'Look before kicking. A back kick thrown blind is a guess.',
      'It travels straight, not in an arc. A kick that swings out is a different, weaker technique.',
      'The turn is the risk. Everything about the training is about shortening the moment of blindness.',
    ],
    commonErrors: [
      {
        error: 'Kicking without looking.',
        why: 'The turn is uncomfortable and slow.',
        fix: 'Turn the head first, every repetition, until it leads automatically.',
      },
      {
        error: 'The kick swings out in an arc.',
        why: 'The hip is not driving straight back.',
        fix: 'Kick along a line on the floor and keep the leg on it.',
      },
    ],
    drills: [
      'The turn alone, without kicking, until the head leads.',
      'Pad work with a partner standing directly behind.',
      'Spinning back kick as a counter to a partner’s forward step.',
    ],
    application: 'A counter to an opponent who has moved past or behind, and — with a spin — a heavy counter to a committed forward attack.',
    relatedKata: ['unsu'],
    relatedKumite: ['go-no-sen', 'kumite-attack'],
    terms: ['ushiro-geri', 'kakato'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'ura-mawashi-geri',
    name: 'Ura-mawashi-geri',
    kanji: '裏回し蹴り',
    english: 'Reverse roundhouse kick, hook kick',
    family: 'geri',
    aliases: ['ura mawashi geri', 'reverse roundhouse', 'hook kick', 'uramawashi geri', 'ura mawashi'],
    summary:
      'A circular kick travelling from inside to outside — the mirror of mawashi-geri — hooking back to strike with the heel or the sole. It arrives from the side an opponent guarding against a roundhouse is not covering.',
    mechanics: {
      chamber: 'The knee lifts, the leg extending past the target before hooking back.',
      supportFoot: 'Pivots strongly, as for mawashi-geri.',
      hips: 'Rotate in the opposite direction to a roundhouse.',
      trajectory: 'Outward past the target, then hooking sharply back inward.',
      extension: 'The leg straightens on the way out and the hook is made by the hip and the knee together.',
      contact: 'The heel, or the sole of the foot.',
      target: 'Side or back of the head, ribs.',
      retraction: 'Fold back to the chamber and recover the guard immediately.',
      balance: 'Demanding. The supporting leg must be strong and the torso controlled.',
      guard: 'Both hands up; the recovery is the vulnerable moment.',
    },
    principles: [
      'It works because it comes from the unexpected side. Thrown predictably, it is simply slow.',
      'Deception first, power second — this is not a heavy kick and does not need to be.',
    ],
    commonErrors: [
      {
        error: 'The hook never happens and it becomes a crescent kick.',
        why: 'Not engaging the knee on the return.',
        fix: 'Kick past a pad and hook back onto it deliberately.',
      },
      {
        error: 'Poor balance on recovery.',
        why: 'Over-rotating, and landing with the weight already past the supporting foot.',
        fix: 'Build up slowly with the hand on a wall for support at first.',
      },
    ],
    drills: ['Pad work with the pad held at the side of the head so the hook is required to land at all.'],
    application: 'A counter or a second technique to the head, arriving on the side a roundhouse guard leaves open.',
    relatedKata: [],
    relatedKumite: ['kumite-attack', 'kumite-combination'],
    terms: ['ura-mawashi-geri', 'kakato'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'mikazuki-geri',
    name: 'Mikazuki-geri',
    kanji: '三日月蹴り',
    english: 'Crescent kick',
    family: 'geri',
    aliases: ['mikazuki geri', 'crescent kick', 'mikazukigeri'],
    summary:
      'A kick swinging in a crescent across the body, striking with the sole or the inner edge of the foot. It is used as much to sweep a guard aside or strike an arm as to hit the head, and in kata it commonly lands against the opposite open palm.',
    mechanics: {
      chamber: 'Less pronounced than in other kicks — the leg travels in an arc from the floor.',
      supportFoot: 'Pivots as the arc develops.',
      hips: 'Rotate into the swing.',
      trajectory: 'A crescent from outside to inside, or inside to outside.',
      contact: 'The sole or the inner edge of the foot.',
      target: 'The opponent’s guarding arm, the side of the head, or a held weapon.',
      retraction: 'Bring the leg down under control, often stepping directly into the following technique.',
      balance: 'The wide arc makes balance the limiting factor.',
    },
    principles: [
      'It is often a block or a clearance made with the leg rather than a strike.',
      'In kata the palm it strikes is a target, and treating it as decoration loses the point of the movement.',
    ],
    commonErrors: [
      {
        error: 'Treating it purely as a head kick.',
        why: 'Assuming every kick is a strike to the opponent.',
        fix: 'Train it against a partner’s guarding arm as well as against a pad.',
      },
    ],
    drills: ['Striking the own opposite palm accurately, then a partner’s held pad at the same height.'],
    application: 'Clearing a guard or a grabbing arm with the leg, and striking the head from an unexpected angle.',
    relatedKata: ['heian-godan', 'kanku-dai', 'unsu'],
    relatedKumite: [],
    terms: ['mikazuki-geri'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'fumikomi',
    name: 'Fumikomi',
    kanji: '踏み込み',
    english: 'Stamping kick',
    family: 'geri',
    aliases: ['fumikomi geri', 'stamping kick', 'stomp kick', 'fumikomi-geri'],
    summary:
      'A downward stamping kick with the heel or the outer edge of the foot, driven into the knee, the shin or the instep of an opponent at very close range. It appears throughout the Tekki series and is one of the few techniques in the syllabus explicitly aimed below the belt.',
    mechanics: {
      chamber: 'The knee lifts high, the foot folded and turned edge-down.',
      supportFoot: 'Flat and strongly weighted; the whole body drops into the technique.',
      hips: 'Drop with the stamp, adding the body weight to it.',
      trajectory: 'Straight down, or down and slightly forward.',
      contact: 'The heel or the outer edge of the foot.',
      target: 'Knee, shin, instep, or the top of the thigh.',
      retraction: 'The foot usually stays down and becomes the new stance — this is the one kick that does not re-chamber.',
      balance: 'The drop is controlled; the body settles rather than falls.',
    },
    principles: [
      'The body weight is the technique. A stamp thrown with the leg alone is a tap.',
      'It is the exception to the retraction rule, because it deliberately becomes the next stance.',
    ],
    commonErrors: [
      {
        error: 'Stamping with the flat of the foot.',
        why: 'Not turning the ankle.',
        fix: 'Turn the foot edge-down in the chamber.',
      },
      {
        error: 'No body drop.',
        why: 'Treating it as a leg action.',
        fix: 'Drop the whole body into it and let the stance finish low.',
      },
    ],
    drills: ['Tekki Shodan slowly with attention on the stamp; and pad work with a pad held low and flat.'],
    application: 'Very close range: attacking the knee or the instep of an opponent who has closed, and breaking their base.',
    relatedKata: ['tekki-shodan', 'tekki-nidan', 'tekki-sandan', 'bassai-dai'],
    relatedKumite: [],
    terms: ['fumikomi', 'sokuto', 'kakato'],
    contested: null,
    curriculum: null,
  }),
];

// ─── Tai-sabaki and ashi-sabaki — body and foot movement ────────────────────
//
// The part of karate that decides whether any of the rest of it lands. Two
// people of equal technique are separated entirely by who is standing in the
// right place.

export const MOVEMENT: readonly Technique[] = [
  T({
    slug: 'tai-sabaki',
    name: 'Tai-sabaki',
    kanji: '体捌き',
    english: 'Body management, body evasion',
    family: 'tai_sabaki',
    aliases: ['tai sabaki', 'body shifting', 'body evasion', 'taisabaki'],
    summary:
      'The whole art of moving the body off the line of an attack while staying in range to answer it. Not a technique but a category: turning, shifting, dropping, angling. It is what separates a defence that survives from a defence that wins.',
    mechanics: {
      movement: 'The body leaves the line of attack by turning around its own axis, shifting laterally, or dropping under. The feet move as little as the situation allows.',
      hips: 'Lead. The hips turn and the rest of the body follows; a turn led by the shoulders leaves the hips still in the line.',
      timing: 'Begins as the attack commits, not before. Moving early tells the attacker to change; moving late is not moving.',
      distance: 'Off the line, but not out of range. Evasion that also leaves range has given up the counter.',
    },
    principles: [
      'Move off the line, not away from it. Backward is the direction that keeps the fight exactly as it was.',
      'The evasion and the counter are one movement, not two.',
      'The smallest sufficient movement is the best one: it is faster, and it keeps you in range.',
    ],
    commonErrors: [
      {
        error: 'Retreating straight back.',
        why: 'It is the instinctive response.',
        fix: 'Drill lateral and angular movement until it displaces the instinct.',
      },
      {
        error: 'Moving so far that the counter cannot reach.',
        why: 'Prioritising safety over the answer.',
        fix: 'Drill with the counter attached, so an evasion that makes the counter impossible fails visibly.',
      },
      {
        error: 'Moving too early.',
        why: 'Anxiety, and the belief that the earliest possible movement is the safest one.',
        fix: 'Partner drills where the attacker is allowed to change target if the defender moves first.',
      },
    ],
    drills: [
      'Partner attacks with oi-zuki; defender moves to forty-five degrees and touches the shoulder — no block at all.',
      'Circling drills where neither player is allowed to move straight backward.',
    ],
    application: 'Every defensive situation in free fighting. It is the first thing a good fighter does and the last thing a beginner thinks of.',
    relatedKata: ['heian-yondan', 'heian-godan', 'bassai-dai', 'kanku-dai', 'unsu'],
    relatedKumite: ['maai', 'sen-no-sen', 'go-no-sen', 'kumite-footwork', 'defensive-kumite'],
    terms: ['tai-sabaki', 'maai', 'zanshin'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'ashi-sabaki',
    name: 'Ashi-sabaki',
    kanji: '足捌き',
    english: 'Footwork',
    family: 'ashi_sabaki',
    aliases: ['ashi sabaki', 'footwork', 'ashisabaki', 'foot movement'],
    summary:
      'The management of the feet: sliding, stepping, switching and turning without losing balance, height or guard. Everything a fighter can do is limited by where the feet can put the body, and how quickly.',
    mechanics: {
      movement:
        'Four basic patterns. Suri-ashi slides the feet without crossing or lifting. Tsugi-ashi brings the rear foot up to the front and then steps. Ayumi-ashi steps through, one foot passing the other. Tenshin turns the body around a fixed foot.',
      supportFoot: 'Weight stays over the feet, never ahead of or behind them.',
      balance: 'The head stays at one height. A head that bobs announces every movement made.',
      guard: 'The hands do not move with the feet. A guard that swings while stepping is an opening on a timer.',
    },
    principles: [
      'Slide, do not lift. A lifted foot is a foot that is not on the floor when it is needed.',
      'One height throughout. Height changes are visible from across the tatami.',
      'The feet never cross in free fighting, because crossed feet cannot change direction.',
    ],
    commonErrors: [
      {
        error: 'The head bobs up and down.',
        why: 'Pushing off with a straightening leg.',
        fix: 'Move under an imagined low ceiling.',
      },
      {
        error: 'The feet cross.',
        why: 'Travelling sideways with an ordinary walking step.',
        fix: 'Use the crossing step only where it belongs, and drill lateral movement without it.',
      },
      {
        error: 'The stance widens or narrows as the fighter moves.',
        why: 'One foot travelling further than the other.',
        fix: 'Move up and down the floor checking the stance dimensions every second step.',
      },
    ],
    drills: [
      'Sliding up and down the floor in kamae, hands still, head level.',
      'Mirror drill: two partners, one leads, the other maintains exact distance without being told to.',
      'Movement on a marked square, changing direction on a call.',
    ],
    application: 'The foundation of distance control, and therefore of everything that happens in free fighting.',
    relatedKata: [],
    relatedKumite: ['kumite-footwork', 'maai', 'jiyu-kumite'],
    terms: ['ashi-sabaki', 'suri-ashi', 'tsugi-ashi', 'ayumi-ashi', 'maai'],
    contested: null,
    curriculum: null,
  }),
];
