/**
 * THE KIHON LIBRARY — the rules, and the shape of a technique record.
 *
 * The entries themselves live in ./stances.ts, ./hand-techniques.ts and
 * ./kicks.ts; ./kihon.ts is the barrel that assembles them. Everything in this
 * header binds all four files.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE MAY SAY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Shotokan technique is public martial-arts knowledge. How the hip drives
 * gyaku-zuki, where the weight sits in kokutsu-dachi, why the knee must be
 * lifted before the foot travels in mae-geri — none of this is an MMAKF claim,
 * and the directive asked for principles rather than names, so it is written
 * here at length.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT MAY NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. NO GRADE. Which technique MMAKF examines at which kyu is federation
 *    policy, MMAKF has not published it, and inventing it is the failure this
 *    project treats as unforgivable. Every entry carries `curriculum: null`.
 *    The field exists so that the day the syllabus is published it is filled
 *    in rather than designed; the null is the honest current state, and the
 *    surfaces name the absence out loud instead of quietly omitting it.
 *
 * 2. NO INVENTED GRADING COMBINATION. §12 of the directive is explicit. The
 *    combinations here are described as the CONCEPTUAL FAMILIES they are —
 *    "lead hand into reverse punch" — and never as a numbered federation
 *    requirement tied to a rank. Federation-approved combinations are curriculum data,
 *    entered by the technical committee through the admin surface, not shipped
 *    in a source file by an agent.
 *
 * 3. NO INVENTED BUNKAI. §27 and §39 both say it: an application is a
 *    technical claim requiring review. `relatedKata` records only where a
 *    technique demonstrably and uncontroversially appears — the opening
 *    gedan-barai of Heian Shodan is not a matter of opinion — and stops there.
 *    Movement-by-movement application mapping is a reviewed database record,
 *    not a constant in this file.
 *
 * 4. NO NUMBER THAT IS NOT SETTLED. Where Shotokan organisations genuinely
 *    differ — the exact angle of a stance, the precise proportion of weight —
 *    the text says what is agreed and names the disagreement instead of
 *    printing a false precision. See `contested` on the entries that have it.
 *
 * The vocabulary is defined once in ./terminology.ts and referenced by key, for
 * the same reason the kata library does it: forty entries each explaining
 * `hikite` in their own words end up explaining it four different ways, and the
 * student learning from the library is the one who pays.
 */

import type { KihonFamily } from './terminology';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Where MMAKF's syllabus association goes when the federation publishes one.
 *
 * Declared and unset on every entry, deliberately. A reader can see exactly
 * what the federation still has to decide.
 */
export interface CurriculumPlacement {
  /** The grade MMAKF examines this at, in the federation's own words. */
  grade: string;
  /** The federation document it came from. Never inferred from practice. */
  source: string;
  /** ISO date the federation published it. */
  publishedOn: string;
}

/** A fault, why it happens, and what fixes it. A name alone teaches nobody. */
export interface Fault {
  error: string;
  why: string;
  fix: string;
}

/**
 * The mechanical description. Every field optional because a stance has no
 * hikite and a punch has no support foot — an interface that demanded both
 * would be filled with filler, and filler is how a library stops being read.
 */
export interface Mechanics {
  // Universal
  stance?: string;
  start?: string;
  trajectory?: string;
  contact?: string;
  kime?: string;
  recovery?: string;
  distance?: string;
  timing?: string;
  breathing?: string;
  // Hand technique
  hips?: string;
  shoulders?: string;
  elbows?: string;
  hikite?: string;
  // Stance
  weight?: string;
  feet?: string;
  knees?: string;
  centre?: string;
  movement?: string;
  // Kicking
  chamber?: string;
  supportFoot?: string;
  extension?: string;
  retraction?: string;
  balance?: string;
  guard?: string;
  target?: string;
}

export interface Technique {
  slug: string;
  /** Hyphenated romaji, the form a student sees on a syllabus sheet. */
  name: string;
  /** Characters where they are certain. Null rather than romaji in disguise. */
  kanji: string | null;
  /** The English rendering. A translation, not an explanation. */
  english: string;
  family: KihonFamily;
  /** Spellings and synonyms search must match. See ./search.ts. */
  aliases: readonly string[];
  /** What it is and what it is for. Prose, not a stub. */
  summary: string;
  mechanics: Mechanics;
  /** The ideas that survive when the name is forgotten. */
  principles: readonly string[];
  commonErrors: readonly Fault[];
  /** How it is trained. Practice, not theory. */
  drills: readonly string[];
  /** What it is actually for, against a person. */
  application: string;
  /**
   * Kata in which it appears uncontroversially. Slugs into src/data/kata.ts.
   * Empty is a legitimate answer and far better than a guess.
   */
  relatedKata: readonly string[];
  /** Kumite concept slugs into ./kumite.ts. */
  relatedKumite: readonly string[];
  /** Keys into ./terminology.ts. */
  terms: readonly string[];
  /** A genuine disagreement between Shotokan organisations, or null. */
  contested: string | null;
  /** ALWAYS null. See the header of this file. */
  curriculum: CurriculumPlacement | null;
}

/** Identity helper: gives every literal below full type-checking at authoring time. */
export const T = (t: Technique): Technique => t;
