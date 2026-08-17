// Dachi-waza — the stances.
//
// Split from kihon.ts because one file holding forty techniques is a file
// nobody opens. The rules that govern what may be written here live in
// ./kihon-types.ts and apply identically.

import { T, type Technique } from './kihon-types';

// ─── Stances — dachi-waza ───────────────────────────────────────────────────

export const STANCES: readonly Technique[] = [
  T({
    slug: 'zenkutsu-dachi',
    name: 'Zenkutsu-dachi',
    kanji: '前屈立ち',
    english: 'Front stance',
    family: 'dachi',
    aliases: ['zenkutsu dachi', 'front stance', 'forward stance', 'zenkutsu'],
    summary:
      'The stance Shotokan is recognised by, and the one that teaches everything else. A long forward stance with the front knee bent over the foot and the back leg straight, it exists to put body weight behind a technique travelling forward and to give the hips a stable platform to rotate against. Almost every forward-moving technique in the syllabus is first learned in it.',
    mechanics: {
      weight: 'Roughly sixty per cent on the front leg, forty on the back. The distribution is a consequence of the shape rather than something to be held deliberately — a student thinking about percentages stops moving.',
      feet: 'About two shoulder-widths long and one shoulder-width wide. The width is the part most often lost: a stance on a tightrope has no lateral stability at all. Front foot points forward, back foot turned out no more than about thirty degrees.',
      knees: 'Front knee bent until it is above the front foot — the shin close to vertical, the kneecap over the laces. Beyond that the knee is loaded past its joint line. Back knee straight but not locked.',
      centre: 'Hips square to the front for a forward-facing technique, or half-turned for hanmi. The centre of gravity sits between the feet and low, not over the front foot.',
      movement:
        'Stepping travels in a shallow arc through the centre, the moving knee passing close to the supporting one, with the hips staying level. A head that rises and falls through a step is a head that telegraphs it.',
      breathing: 'Exhale into the settling of the stance; the stance finishes when the breath does.',
    },
    principles: [
      'The back leg is the engine. It is straight so it can transmit drive from the floor to the target without collapsing on the way.',
      'Length buys power and costs mobility. That trade is the whole reason a syllabus contains more than one stance.',
      'The stance is a destination, not a place to live. In kihon it is held; in kumite it is passed through.',
    ],
    commonErrors: [
      {
        error: 'The stance is too narrow — both feet on one line.',
        why: 'Stepping through by swinging the foot along a straight track rather than around the supporting leg.',
        fix: 'Step so the moving foot passes the supporting ankle and lands on its own track. Practising along the join between two floorboards makes the fault visible immediately.',
      },
      {
        error: 'The back heel lifts.',
        why: 'The stance is longer than the hips can currently open to, so the heel escapes to make up the difference.',
        fix: 'Shorten the stance until the heel stays down, and lengthen it as hip flexibility allows. A long stance on a raised heel transmits nothing.',
      },
      {
        error: 'The front knee drifts inside the foot.',
        why: 'Weak hip abductors, or driving forward from the knee instead of the hip.',
        fix: 'Track the knee over the second toe consciously, and strengthen the hip. This one is worth fixing early — it is the fault that ends knees.',
      },
      {
        error: 'The body rises during the step.',
        why: 'Straightening the supporting leg to move rather than pulling with the hip.',
        fix: 'Step under a low bar, real or imagined, and keep the crown of the head at one height throughout.',
      },
    ],
    drills: [
      'Stepping up and down the floor in zenkutsu-dachi with no hand technique at all, watching only the head height and the width.',
      'Holding the stance while a partner pushes gently at the shoulder from four directions — the stance either holds its shape or shows where it does not.',
      'Stepping with the hands on the hips, so nothing can be hidden behind an arm movement.',
    ],
    application:
      'It is the shape a body takes when it commits weight forward into a technique — a stepping punch, a strong block against a committed attack, the moment of a throw. Its length is also its warning: a person in a deep front stance has traded the ability to move for the ability to hit.',
    relatedKata: ['heian-shodan', 'heian-nidan', 'heian-sandan', 'heian-yondan', 'heian-godan', 'bassai-dai', 'kanku-dai', 'jion'],
    relatedKumite: ['maai', 'kamae'],
    terms: ['zenkutsu-dachi', 'hanmi', 'kime'],
    contested:
      'The exact length and the permitted angle of the back foot differ measurably between Shotokan organisations, and between the same organisation in different decades. What is agreed is the shape and its purpose; the centimetres are not, and are not printed here as though they were.',
    curriculum: null,
  }),

  T({
    slug: 'kokutsu-dachi',
    name: 'Kokutsu-dachi',
    kanji: '後屈立ち',
    english: 'Back stance',
    family: 'dachi',
    aliases: ['kokutsu dachi', 'back stance', 'kokutsu'],
    summary:
      'The defensive counterpart to zenkutsu-dachi. Most of the weight sits on the rear leg, which withdraws the body from an incoming attack while leaving the front leg light enough to kick or to slide. It is the stance of shuto-uke and of most of the receiving positions in the Heian series.',
    mechanics: {
      weight: 'About seventy per cent on the back leg. The front foot rests rather than carries.',
      feet: 'The feet form an L: the back foot points to the side, the front foot forward, both heels on one line. That heel line is what makes the stance stable rather than merely leaning.',
      knees: 'The back knee is bent deeply and pushed out over the back foot, not allowed to fall inward. The front knee is slightly bent, never locked.',
      centre: 'The hips are half-facing — hanmi — which narrows the target presented and pre-loads the rotation for a counter.',
      movement:
        'Changing stance rotates around the back heel rather than stepping wide. The withdrawal is a turn, not a retreat.',
      breathing: 'Exhale as the block arrives; the stance and the technique finish together.',
    },
    principles: [
      'Weight back is distance bought without moving the feet. The head leaves range while the front leg stays in it.',
      'The front leg is free. A stance that loads it has thrown away the kick it was holding.',
      'Hanmi is not decoration. The half-facing hips are what let the block become a counter without a preparatory movement.',
    ],
    commonErrors: [
      {
        error: 'The back knee collapses inward.',
        why: 'Insufficient hip external rotation, or simply not attending to it.',
        fix: 'Push the knee out over the little toe of the back foot and hold it there. As with the front stance, this is a joint-preservation issue, not an aesthetic one.',
      },
      {
        error: 'The upper body leans back.',
        why: 'Confusing "weight on the back leg" with "lean away".',
        fix: 'Keep the spine vertical over the hips. The weight goes back by bending the back knee, not by tipping the torso.',
      },
      {
        error: 'The heels are not on one line.',
        why: 'Stepping into the stance without reference to the back foot.',
        fix: 'Set the back foot first and place the front heel on its line. A stance built front-foot-first almost never finds the line.',
      },
    ],
    drills: [
      'Alternating kokutsu-dachi and zenkutsu-dachi on the spot, feeling the weight travel without the head rising.',
      'Front-leg mae-geri from kokutsu-dachi with no weight shift beforehand — this proves the front leg was genuinely free.',
      'Shuto-uke stepping backwards down the floor, checking the heel line at every stance.',
    ],
    application:
      'Receiving a committed attack while removing the head from its line, with the front leg already loaded for the counter. In kumite the full stance rarely appears, but the idea underneath it — weight back, front leg free, hips half-facing — is present in almost every defensive posture.',
    relatedKata: ['heian-shodan', 'heian-nidan', 'heian-sandan', 'heian-yondan', 'heian-godan', 'bassai-dai', 'kanku-dai'],
    relatedKumite: ['maai', 'go-no-sen', 'kamae'],
    terms: ['kokutsu-dachi', 'hanmi', 'shuto-uke'],
    contested:
      'The seventy-thirty weight distribution is the figure usually taught in the JKA line; other Shotokan organisations teach sixty-forty and some teach a deeper stance again. The principle — clearly weighted to the rear, front leg free — is not in dispute.',
    curriculum: null,
  }),

  T({
    slug: 'kiba-dachi',
    name: 'Kiba-dachi',
    kanji: '騎馬立ち',
    english: 'Horse-riding stance',
    family: 'dachi',
    aliases: ['kiba dachi', 'horse stance', 'straddle stance', 'kiba'],
    summary:
      'A wide, square, evenly weighted stance in which both knees are bent and pushed outward, as though sitting astride a horse. It builds the leg strength and hip opening the rest of the syllabus spends, and it is the stance of the entire Tekki series.',
    mechanics: {
      weight: 'Even, fifty-fifty, and low. The weight sits down through the heels rather than forward on the balls of the feet.',
      feet: 'About two shoulder-widths apart, both feet parallel and pointing forward. Feet turning outward is the commonest and most weakening fault.',
      knees: 'Bent until the thighs approach horizontal, and pushed outward over the feet so the shins are close to vertical when seen from the front.',
      centre: 'Hips tucked slightly under, lower back long rather than arched. The torso is upright and square.',
      movement:
        'Travelling is done with the crossing step — yoko-ashi — the feet passing in front of or behind one another without the height changing.',
      breathing: 'Long, low breathing. Kiba-dachi is where breath control is trained because there is nothing else to hide behind.',
    },
    principles: [
      'It develops what it costs. The stance is deliberately hard: the strength it demands is the strength it builds.',
      'Feet parallel is the whole stance. Turned-out feet convert it into a comfortable squat that trains nothing.',
      'Power in kiba-dachi is lateral. It is the platform for techniques delivered to the side, which is why Tekki lives in it.',
    ],
    commonErrors: [
      {
        error: 'The feet turn outward.',
        why: 'It is easier, and the difference is hard to see from inside the stance.',
        fix: 'Set the stance facing a mirror or a wall line. Shorten the width until the feet can be parallel, and widen as the hips open.',
      },
      {
        error: 'The knees fall inward.',
        why: 'The stance is wider than the hip strength currently supports.',
        fix: 'Actively push the knees out. A resistance band around the thighs makes the required effort obvious in one repetition.',
      },
      {
        error: 'The backside pushes out behind.',
        why: 'Sitting back into the stance instead of down into it.',
        fix: 'Tuck the pelvis and lengthen the lower back. The torso should be able to rise straight up out of the stance without first shifting forward.',
      },
    ],
    drills: [
      'Simply holding the stance for increasing counts, which is how it has always been trained.',
      'Yoko-ashi travelling the length of the floor without the head changing height.',
      'Tekki Shodan performed slowly, watching only the stance.',
    ],
    application:
      'Directly, it is a stance for fighting to the side and for close work where the feet cannot be repositioned. Indirectly — and more importantly — it is the conditioning that makes every other stance possible.',
    relatedKata: ['tekki-shodan', 'tekki-nidan', 'tekki-sandan', 'heian-nidan', 'heian-sandan', 'bassai-dai', 'jitte'],
    relatedKumite: ['kamae'],
    terms: ['kiba-dachi', 'kime'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'fudo-dachi',
    name: 'Fudo-dachi',
    kanji: '不動立ち',
    english: 'Rooted stance, immovable stance',
    family: 'dachi',
    aliases: ['fudo dachi', 'sochin-dachi', 'sochin dachi', 'rooted stance', 'immovable stance'],
    summary:
      'A hybrid of the front stance and the horse stance: the length and forward orientation of zenkutsu-dachi with the even weighting and outward knee pressure of kiba-dachi. It is the stance of Sochin, from which its alternative name comes, and it is used where a technique must be absorbed rather than evaded.',
    mechanics: {
      weight: 'Even between the feet, low, and driven downward. The name is the instruction: immovable.',
      feet: 'The length of a front stance, the width of a horse stance. Both feet turned out slightly.',
      knees: 'Both bent and both pushed outward, the tension between them being what roots the stance.',
      centre: 'Hips square and low, spine upright.',
      movement: 'Travels like a front stance but never rises; the sensation is of dragging the floor rather than stepping on it.',
    },
    principles: [
      'The rooting comes from opposing tension, not from mass. The knees pressing outward is what makes it immovable.',
      'It is a stance for meeting force, chosen where retreating is not the answer.',
    ],
    commonErrors: [
      {
        error: 'It becomes a front stance with a bent back leg.',
        why: 'Weight drifting forward out of habit.',
        fix: 'Check that a push from either side is resisted equally. If the front foot carries more, it is not fudo-dachi.',
      },
      {
        error: 'The outward knee pressure is absent.',
        why: 'Treating it as a shape rather than as an action.',
        fix: 'Consciously press both knees out and feel the stance tighten.',
      },
    ],
    drills: [
      'Alternating between zenkutsu-dachi and fudo-dachi on the spot to feel exactly what changes.',
      'Sochin performed slowly, checking that the stance is genuinely even at every position.',
    ],
    application:
      'Meeting an attack without giving ground, and delivering a technique whose power comes from the whole body settling rather than from travelling forward.',
    relatedKata: ['sochin', 'jitte'],
    relatedKumite: ['tai-no-sen'],
    terms: ['fudo-dachi', 'kime'],
    contested:
      'Whether fudo-dachi and sochin-dachi name the same stance or two subtly different ones is answered differently by different Shotokan organisations. They are treated here as one entry with both names recorded, which is how most of the JKA line teaches it.',
    curriculum: null,
  }),

  T({
    slug: 'neko-ashi-dachi',
    name: 'Neko-ashi-dachi',
    kanji: '猫足立ち',
    english: 'Cat-foot stance',
    family: 'dachi',
    aliases: ['neko ashi dachi', 'cat stance', 'cat foot stance', 'nekoashi'],
    summary:
      'A short, high stance with almost all the weight on the rear leg and the front foot resting on the ball with the heel raised — the posture of a cat about to move. It is the most mobile of the classical stances and the one from which a front-leg kick arrives with no preparation at all.',
    mechanics: {
      weight: 'Ninety per cent or more on the back leg. The front foot carries almost nothing and can be lifted without any weight shift.',
      feet: 'Short — the front foot is barely more than a foot-length ahead. Front heel raised, ball of the foot touching. Back foot turned out about forty-five degrees.',
      knees: 'Back knee deeply bent and pushed out; front knee bent and drawn slightly inward, covering the groin.',
      centre: 'Hips half-facing and low. The body is coiled rather than settled.',
      movement: 'Moves by pushing off the back leg. The front foot leads and the back foot follows without the height changing.',
    },
    principles: [
      'The front leg is a weapon held at the ready, not a support. Any weight on it is a kick given away.',
      'Shortness is mobility. What the stance loses in stability it returns in the speed with which it can leave.',
    ],
    commonErrors: [
      {
        error: 'Weight creeps onto the front foot.',
        why: 'Fatigue in the supporting leg.',
        fix: 'Test it: lift the front foot. If the body moves at all, the weight was on it.',
      },
      {
        error: 'The stance is too long.',
        why: 'Importing the length of a back stance.',
        fix: 'Shorten until the front foot can be lifted and replaced without a shift.',
      },
    ],
    drills: [
      'Standing in the stance and repeatedly lifting the front foot without moving the body.',
      'Front-leg mae-geri from neko-ashi-dachi, aiming for no preparatory movement whatsoever.',
    ],
    application:
      'Receiving at close range with the option to kick immediately, and moving out of range fast. Its logic — weight back, front leg free, no telegraph — is the logic of the modern kumite guard, even though the classical shape is rarely seen in a match.',
    relatedKata: ['heian-yondan', 'bassai-sho', 'unsu'],
    relatedKumite: ['kamae', 'maai', 'sen-no-sen'],
    terms: ['neko-ashi-dachi', 'hanmi'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'hangetsu-dachi',
    name: 'Hangetsu-dachi',
    kanji: '半月立ち',
    english: 'Half-moon stance',
    family: 'dachi',
    aliases: ['hangetsu dachi', 'half moon stance', 'hangetsu'],
    summary:
      'A shorter, narrower front stance with both knees bent and squeezed inward, the feet turned in. It is named for the crescent path the foot travels when stepping, and it is the stance of the kata Hangetsu, where it is trained together with the breathing that gives that kata its character.',
    mechanics: {
      weight: 'Even or slightly forward, and the whole stance is under constant inward tension.',
      feet: 'Shorter and narrower than zenkutsu-dachi, with both feet turned inward.',
      knees: 'Both bent and squeezed toward each other, protecting the centre line.',
      centre: 'Hips square, torso upright, abdomen engaged.',
      movement: 'The stepping foot travels a crescent — in toward the supporting leg, then out — which is where the name comes from.',
      breathing: 'Deliberate and audible in the kata. The stance is a vehicle for breath training as much as for movement.',
    },
    principles: [
      'Inward tension closes the centre. The stance protects the groin and lower abdomen by its shape alone.',
      'The crescent step keeps the supporting leg covered while moving, at the cost of speed.',
    ],
    commonErrors: [
      {
        error: 'The feet point forward.',
        why: 'Defaulting to the more familiar front stance.',
        fix: 'Turn the toes in consciously and feel the knees draw together.',
      },
      {
        error: 'The step travels straight.',
        why: 'The crescent is easy to abandon under tempo.',
        fix: 'Practise the step alone, slowly, tracing the arc on the floor.',
      },
    ],
    drills: [
      'The stepping pattern alone, slowly, with attention only to the arc of the foot.',
      'Hangetsu performed at its proper tempo, which is where the stance and the breathing meet.',
    ],
    application:
      'Close-range work where the centre line must stay closed, and the stance in which Shotokan trains its most explicit breathing method.',
    relatedKata: ['hangetsu'],
    relatedKumite: [],
    terms: ['hangetsu-dachi'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'sanchin-dachi',
    name: 'Sanchin-dachi',
    kanji: '三戦立ち',
    english: 'Hourglass stance',
    family: 'dachi',
    aliases: ['sanchin dachi', 'hourglass stance', 'sanchin'],
    summary:
      'A short, rooted stance with the feet turned inward and the knees drawn together, one foot advanced by about a foot-length. It belongs to the Naha-te lineages rather than to Shotokan proper, and appears in this library because Shotokan students meet it in cross-style training and because hangetsu-dachi is its close relative.',
    mechanics: {
      weight: 'Even, low, and rooted downward.',
      feet: 'Both turned inward, heels roughly on the corners of a small rectangle, one foot advanced by about its own length.',
      knees: 'Bent and drawn inward under continuous tension.',
      centre: 'Hips tucked, abdomen strongly engaged, spine long.',
      breathing: 'Central to the stance in the styles that own it, and the reason it exists.',
    },
    principles: [
      'It is a conditioning posture before it is a fighting one.',
      'Its relationship to hangetsu-dachi is the useful thing for a Shotokan student: the same idea, adapted.',
    ],
    commonErrors: [
      {
        error: 'Practising it as a Shotokan stance.',
        why: 'Assuming every stance in a karate curriculum belongs to the same lineage.',
        fix: 'Learn it from the tradition that owns it, and do not import its tension into Shotokan stances where it does not belong.',
      },
    ],
    drills: ['Best trained under an instructor of a style in which it is native.'],
    application:
      'Close-range rooted work in the Naha-te lineages. Included here for completeness and cross-reference, explicitly flagged as not native to Shotokan.',
    relatedKata: [],
    relatedKumite: [],
    terms: ['sanchin-dachi'],
    contested:
      'Sanchin-dachi is not a Shotokan stance. It is documented here because the directive lists it "where applicable" and because students encounter it; it is not presented as part of the Shotokan canon.',
    curriculum: null,
  }),

  T({
    slug: 'musubi-dachi',
    name: 'Musubi-dachi',
    kanji: '結び立ち',
    english: 'Joined-feet stance, heels together with toes out',
    family: 'dachi',
    aliases: ['musubi dachi', 'informal attention stance', 'musubi'],
    summary:
      'Heels together, toes turned out about forty-five degrees, legs straight. It is the formal stance of the bow at the beginning and end of practice, and it belongs to etiquette as much as to technique.',
    mechanics: {
      weight: 'Even, upright, relaxed but not slack.',
      feet: 'Heels touching, toes turned out roughly forty-five degrees.',
      knees: 'Straight without being locked.',
      centre: 'Spine vertical, shoulders down, hands relaxed at the thighs.',
    },
    principles: [
      'It is where reigi — courtesy — is expressed physically. Standing badly in it says something.',
      'Feet together means committed to nothing, which is exactly right for a bow and exactly wrong for a fight.',
    ],
    commonErrors: [
      {
        error: 'Slouching, or looking down while bowing.',
        why: 'Treating the bow as a formality to be got through.',
        fix: 'Bow from the hips with the spine long. Where the eyes go during the bow differs by dojo convention; follow the instructor.',
      },
    ],
    drills: ['Practised every session at the opening and closing bow, which is drill enough.'],
    application:
      'Formal etiquette: the opening and closing of practice, the bow to the shomen, the bow to a partner before and after an exercise.',
    relatedKata: [],
    relatedKumite: [],
    terms: ['musubi-dachi', 'rei'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'heisoku-dachi',
    name: 'Heisoku-dachi',
    kanji: '閉足立ち',
    english: 'Closed-feet stance',
    family: 'dachi',
    aliases: ['heisoku dachi', 'closed foot stance', 'feet together stance', 'heisoku'],
    summary:
      'Feet together and parallel, legs straight. A transitional position rather than a fighting one: it appears at the start of several kata and in the moment of gathering before a technique opens outward.',
    mechanics: {
      weight: 'Even, upright.',
      feet: 'Together and parallel, inner edges touching.',
      knees: 'Straight, soft.',
      centre: 'Spine vertical, weight through the centre of both feet.',
    },
    principles: [
      'A gathering point. Its function is to be left.',
      'Feet together is maximally unstable laterally, which is why it is passed through rather than held.',
    ],
    commonErrors: [
      {
        error: 'Holding it as though it were a fighting stance.',
        why: 'Misreading a transition as a position.',
        fix: 'Understand where in the sequence it occurs and what it is preparing.',
      },
    ],
    drills: ['Trained in place, within the kata that use it.'],
    application:
      'The gathered moment before a technique opens — the start position of several kata, and the closing of a sequence.',
    relatedKata: ['heian-godan', 'kanku-dai', 'gankaku'],
    relatedKumite: [],
    terms: ['heisoku-dachi'],
    contested: null,
    curriculum: null,
  }),

  T({
    slug: 'hachiji-dachi',
    name: 'Hachiji-dachi',
    kanji: '八字立ち',
    english: 'Open-leg stance, "figure eight" stance',
    family: 'dachi',
    aliases: ['hachiji dachi', 'natural stance', 'ready stance', 'shizentai', 'yoi', 'hachiji'],
    summary:
      'Feet about shoulder-width apart with the toes turned slightly out, legs straight, weight even. It is the ready position — yoi — from which kihon begins and to which it returns, and the shape the character 八 gives it its name.',
    mechanics: {
      weight: 'Even, settled, relaxed.',
      feet: 'Shoulder-width apart, toes turned out slightly.',
      knees: 'Straight but not locked; the legs are alive.',
      centre: 'Hips square, spine vertical, shoulders down, hands in front of the thighs.',
      breathing: 'Settled and low. Yoi is where the breath is gathered before work begins.',
    },
    principles: [
      'Readiness is not tension. A ready stance held rigid is slower than one held relaxed.',
      'It is neutral by design — committed to no direction, therefore available to all of them.',
    ],
    commonErrors: [
      {
        error: 'Shoulders raised and arms tense in yoi.',
        why: 'Confusing alertness with effort.',
        fix: 'Drop the shoulders and let the arms hang with the elbows slightly bent. Alertness lives in the eyes and the breath.',
      },
      {
        error: 'The stance is too wide or too narrow.',
        why: 'No reference point.',
        fix: 'Shoulder-width, measured against the shoulders, every time.',
      },
    ],
    drills: ['Entering yoi from shizen-tai and settling the breath before every kihon sequence.'],
    application:
      'The starting and finishing position of formal practice, and the everyday posture from which a technique can begin without a preparatory movement.',
    relatedKata: ['heian-shodan', 'heian-nidan', 'heian-sandan', 'heian-yondan', 'heian-godan'],
    relatedKumite: ['kamae'],
    terms: ['hachiji-dachi', 'yoi', 'shizentai'],
    contested: null,
    curriculum: null,
  }),
];
