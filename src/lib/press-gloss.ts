/**
 * English glosses of the PRINTED HEADLINES held in the press archive.
 *
 * This lived inside /press. It now lives here because a second surface — the
 * individual profile at /people/[slug] — shows the same clippings, and a
 * translation table copied into two files is a translation table that will
 * disagree with itself the first time one copy is edited.
 *
 * Keyed on the exact Hindi string held in the store, so a gloss renders only on
 * an exact match: an edited or replaced headline loses its gloss rather than
 * carrying a stale one.
 *
 * These translate the headline and NOTHING ELSE. No clipping body is
 * transcribed from these scans onto any public page, and nothing is said about
 * a clipping beyond the summary the federation recorded with it.
 */
export const HEADLINE_GLOSS: Record<string, string> = {
  'पतरातु में कराटे प्रशिक्षण सह बेल्ट ग्रेडिंग संपन्न':
    'Karate training and belt grading concluded at Patratu',
  'जूनियर टाइगर ली': 'Junior Tiger Lee',
  'मार्शल आर्ट में प्रमोद ने बनाए हैं कई रिकॉर्ड':
    'Pramod has set several records in martial arts',
};

/** Does this string carry Devanagari? Drives the `lang` attribute (WCAG 3.1.2). */
export const hasDevanagari = (s: string): boolean => /[ऀ-ॿ]/.test(s || '');

/** The gloss for a headline, or null. Never a guess, never a machine translation. */
export const glossFor = (headline: string): string | null =>
  HEADLINE_GLOSS[headline || ''] || null;
