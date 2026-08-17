/**
 * Primary-source technical reference material, with its provenance.
 *
 * WHAT THIS FILE IS. The output of a research pass over the sources the
 * technical directive names: the Japan Karate Association's own published
 * material, and the World Karate Federation's competition rules. Every string
 * below was read out of the cited document, and the citation travels with it
 * into `technical_citations` when this is seeded.
 *
 * WHAT IT IS NOT. It is not MMAKF curriculum, MMAKF doctrine, or MMAKF's
 * technical standard. The JKA grading guideline is another organisation's
 * syllabus and lands in `reference_curricula`, which the grading engine cannot
 * reach. The WKF rules are sport regulation and land in `sport_kumite_rulesets`,
 * kept apart from `kumite_forms` so that competition scoring is never mistaken
 * for traditional practice.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE RESEARCH ESTABLISHED, AND WHAT IT DID NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ESTABLISHED. The JKA's public position that kihon, kata and kumite are one
 * subject; its published kyu/dan grading guideline in full for the kyu grades
 * and the first three dan grades; the WKF's current kumite rules, version
 * 2026.01, valid from 1 January 2026, including the whole of the scoring
 * article and the whole of the prohibited-behaviour list.
 *
 * NOT ESTABLISHED — and this is the more important half. PER-KATA MOVEMENT
 * COUNTS COULD NOT BE VERIFIED FROM A PRIMARY SOURCE. A web search will
 * confidently return 21 movements for Heian Shodan, 26 for Nidan, 20 for
 * Sandan, 27 for Yondan and 23 for Godan, attributed to the JKA instructor
 * manual. The manual was fetched and read: it requires an examiner to "verify
 * that there is an accurate number of movements" and states that "one count is
 * equal to one movement", but it does not publish the counts themselves. So the
 * counts are NOT recorded here. Nothing in this file asserts a number that the
 * cited document does not contain.
 *
 * That refusal is the point of the whole exercise. A movement count is the
 * easiest thing in this domain to get plausibly wrong, it is exactly what a
 * grading candidate would rely on, and "everyone prints this number" is not a
 * source.
 */

export interface ReferenceSource {
  slug: string;
  organisation: string;
  sourceType: 'organisation' | 'channel' | 'publication' | 'document' | 'person';
  authorityTier: 'mmakf_official' | 'primary_reference' | 'competition_authority' | 'educational' | 'discovery';
  websiteUrl: string | null;
  channelUrl: string | null;
  style: string | null;
  language: string | null;
  rightsPolicy: string | null;
  notes: string;
}

/** ISO date this research pass was run. Citations carry it as `retrievedOn`. */
export const RETRIEVED_ON = '2026-08-17';

export const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  {
    slug: 'jka',
    organisation: 'Japan Karate Association (公益社団法人日本空手協会)',
    sourceType: 'organisation',
    authorityTier: 'primary_reference',
    websiteUrl: 'https://www.jka.or.jp/en/',
    channelUrl: null,
    style: 'shotokan',
    language: 'en',
    rightsPolicy:
      'Published pages and PDFs are publicly readable and are cited and quoted here under normal ' +
      'quotation practice. NOTHING is rehosted. No permission has been sought or granted for ' +
      'reproduction of JKA instructional media, and none is assumed.',
    notes:
      'Tier B primary reference. The technical directive names JKA material as a primary Shotokan ' +
      'reference. Note that JKA standards are JKA\'s, not MMAKF\'s: adopting any of it is a decision ' +
      'for the MMAKF technical committee, recorded on reference_curricula.adopted_by_mmakf.',
  },
  {
    slug: 'wkf',
    organisation: 'World Karate Federation',
    sourceType: 'organisation',
    authorityTier: 'competition_authority',
    websiteUrl: 'https://www.wkf.net/',
    channelUrl: null,
    style: 'sport',
    language: 'en',
    rightsPolicy:
      'Competition rules are published by the WKF for the governance of the sport and are quoted ' +
      'here article by article with attribution. The PDF is linked, not rehosted.',
    notes:
      'Tier C competition authority. Governs sport kumite and kata competition. Its rules are NOT ' +
      'a description of traditional Shotokan practice and must never be presented as one.',
  },
  {
    slug: 'pramod-pathak-martial-art',
    organisation: 'Pramod Pathak Martial Arts Academy',
    sourceType: 'channel',
    authorityTier: 'educational',
    websiteUrl: null,
    channelUrl: 'https://www.youtube.com/@PramodPathakMartialArt',
    style: 'shotokan',
    language: 'hi',
    rightsPolicy:
      'UNKNOWN pending written confirmation from the channel owner. The channel is public, which ' +
      'is not a licence. No asset from it may be embedded until rights are recorded against the ' +
      'individual asset.',
    notes:
      'THE DIRECTIVE NAMES THIS AS THE MMAKF MASTER TEACHER CHANNEL AND IT IS REGISTERED AT TIER D, ' +
      'NOT TIER A, DELIBERATELY. Tier A is "MMAKF-produced / MMAKF-authorised", and this pass could ' +
      'not verify that authorisation: the channel page could not be read without the YouTube Data ' +
      'API (the public HTML is an application shell), so neither the channel id, the upload count, ' +
      'nor any statement of MMAKF affiliation was confirmed. Promoting this source to ' +
      '\'mmakf_official\' is a one-line change that MMAKF should make once it confirms the ' +
      'authorisation in writing — and it should be a recorded federation decision, not an ' +
      'assumption made by a research pass.',
  },
];

// ─── JKA kyu/dan grading guideline ──────────────────────────────────────────

export interface ReferenceCurriculumItem {
  gradeLabel: string;
  gradeOrdinal: number | null;
  component: 'kihon' | 'kata' | 'kumite';
  requirement: string;
  detail: string | null;
}

/**
 * The JKA's published Kyu / Dan Grading Guideline, transcribed verbatim.
 *
 * Source: https://www.jka.or.jp/wp/wp-content/uploads/2022/03/f421fec70fb6a7004d4e58a7cf567bb9.pdf
 *
 * TRANSCRIPTION RULES FOLLOWED. Grade labels are as the document writes them,
 * inconsistencies included — it writes "10th Kyu", "8 Kyu", "6th Kyu", "3 Kyu"
 * and "1st Dan", and normalising those would be editing a source document.
 * Technique romanisations are likewise the document's own ("CHUUDAN JUNZUKI",
 * "KOUKUTSU SHUTOU UKE"), which differ from the spellings MMAKF's own
 * terminology uses; `technical_term_aliases` is what reconciles the two at
 * search time, rather than a silent rewrite here.
 *
 * COVERAGE. 10th Kyu through 3rd Dan, complete. The document continues to 5th
 * Dan; grades beyond 3rd Dan are not transcribed because their kihon lists were
 * only partially legible in the extracted text, and a half-transcribed
 * requirement is worse than an absent one.
 */
export const JKA_GRADING_GUIDELINE: readonly ReferenceCurriculumItem[] = [
  // ── 10th Kyu ──
  { gradeLabel: '10th Kyu', gradeOrdinal: 10, component: 'kihon', requirement: 'CHUUDAN CHOKUZUKI', detail: 'In place basics in HACHIJIDACHI. "GOREI" command (from right side in turn for each Waza)' },
  { gradeLabel: '10th Kyu', gradeOrdinal: 10, component: 'kihon', requirement: 'JOUDAN AGEUKE', detail: 'In place basics in HACHIJIDACHI' },
  { gradeLabel: '10th Kyu', gradeOrdinal: 10, component: 'kihon', requirement: 'CHUUDAN SOTOUKE', detail: 'In place basics in HACHIJIDACHI' },
  { gradeLabel: '10th Kyu', gradeOrdinal: 10, component: 'kihon', requirement: 'MAEGERI (HEISOKU DACHI GEDAN KAKIWAKE)', detail: 'In place basics in HACHIJIDACHI' },

  // ── 9th Kyu ──
  { gradeLabel: '9th Kyu', gradeOrdinal: 9, component: 'kihon', requirement: 'CHUUDAN JUNZUKI', detail: 'In place basics in SHIZEN TAI to ZENKUTSU DACHI and back to SHIZEN TAI' },
  { gradeLabel: '9th Kyu', gradeOrdinal: 9, component: 'kihon', requirement: 'JOUDAN AGEUKE', detail: null },
  { gradeLabel: '9th Kyu', gradeOrdinal: 9, component: 'kihon', requirement: 'CHUUDAN SOTOUKE', detail: null },
  { gradeLabel: '9th Kyu', gradeOrdinal: 9, component: 'kihon', requirement: 'KOKUTSU SHUTOU UKE', detail: null },
  { gradeLabel: '9th Kyu', gradeOrdinal: 9, component: 'kihon', requirement: 'MAEGERI (HEISOKUDACHI, GEDAN KAKIWAKE)', detail: null },

  // ── 8 Kyu ──
  { gradeLabel: '8 Kyu', gradeOrdinal: 8, component: 'kihon', requirement: 'CHUUDAN JUNZUKI (step in)', detail: 'IDOU KIHON — moving basics' },
  { gradeLabel: '8 Kyu', gradeOrdinal: 8, component: 'kihon', requirement: 'JOUDAN AGEUKE (step in)', detail: null },
  { gradeLabel: '8 Kyu', gradeOrdinal: 8, component: 'kihon', requirement: 'CHUUDAN SOTOUKE (step in)', detail: null },
  { gradeLabel: '8 Kyu', gradeOrdinal: 8, component: 'kihon', requirement: 'GEDAN BARAI (step in)', detail: null },
  { gradeLabel: '8 Kyu', gradeOrdinal: 8, component: 'kihon', requirement: 'KOKUTSU SHUTOU UKE (step in)', detail: null },
  { gradeLabel: '8 Kyu', gradeOrdinal: 8, component: 'kihon', requirement: 'MAEGERI (GEDAN KAKIWAKE) (step in)', detail: null },
  { gradeLabel: '8 Kyu', gradeOrdinal: 8, component: 'kata', requirement: 'TAIKYOKU SHODAN', detail: null },
  { gradeLabel: '8 Kyu', gradeOrdinal: 8, component: 'kumite', requirement: 'GOHON KUMITE', detail: 'JOUDAN JUNZUKI, CHUUDAN JUNZUKI' },

  // ── 7 Kyu ──
  { gradeLabel: '7 Kyu', gradeOrdinal: 7, component: 'kihon', requirement: 'CHUUDAN JUNZUKI (step in)', detail: 'IDOU KIHON — moving basics' },
  { gradeLabel: '7 Kyu', gradeOrdinal: 7, component: 'kihon', requirement: 'JOUDAN AGEUKE (step back)', detail: null },
  { gradeLabel: '7 Kyu', gradeOrdinal: 7, component: 'kihon', requirement: 'CHUUDAN SOTOUKE (step in)', detail: null },
  { gradeLabel: '7 Kyu', gradeOrdinal: 7, component: 'kihon', requirement: 'CHUUDAN UCHIUKE (step back)', detail: null },
  { gradeLabel: '7 Kyu', gradeOrdinal: 7, component: 'kihon', requirement: 'KOUKUTSU SHUTOU UKE (step in)', detail: null },
  { gradeLabel: '7 Kyu', gradeOrdinal: 7, component: 'kihon', requirement: 'MAEGERI (GEDAN KAKIWAKE) (step in)', detail: null },
  { gradeLabel: '7 Kyu', gradeOrdinal: 7, component: 'kihon', requirement: 'YOKOGERI KEAGE', detail: 'in HEISOKU DACHI, right and left alternating' },
  { gradeLabel: '7 Kyu', gradeOrdinal: 7, component: 'kihon', requirement: 'YOKOGERI KEKOMI', detail: 'in HEISOKU DACHI, right and left alternating' },
  { gradeLabel: '7 Kyu', gradeOrdinal: 7, component: 'kata', requirement: 'HEIAN SHODAN', detail: null },
  { gradeLabel: '7 Kyu', gradeOrdinal: 7, component: 'kumite', requirement: 'GOHON KUMITE', detail: 'JOUDAN JUNZUKI, CHUUDAN JUNZUKI' },

  // ── 6th Kyu ──
  { gradeLabel: '6th Kyu', gradeOrdinal: 6, component: 'kihon', requirement: 'CHUUDAN JUNZUKI (step in)', detail: 'IDO KIHON — moving basics' },
  { gradeLabel: '6th Kyu', gradeOrdinal: 6, component: 'kihon', requirement: 'JOUDAN AGEUKE (step back)', detail: null },
  { gradeLabel: '6th Kyu', gradeOrdinal: 6, component: 'kihon', requirement: 'CHUUDAN SOTOUKE (step in)', detail: null },
  { gradeLabel: '6th Kyu', gradeOrdinal: 6, component: 'kihon', requirement: 'CHUUDAN UCHIUKE (step back)', detail: null },
  { gradeLabel: '6th Kyu', gradeOrdinal: 6, component: 'kihon', requirement: 'KOUKUTSU SHUTOU UKE (step in)', detail: null },
  { gradeLabel: '6th Kyu', gradeOrdinal: 6, component: 'kihon', requirement: 'MAEGERI (GEDAN KAKIWAKE) (step in)', detail: null },
  { gradeLabel: '6th Kyu', gradeOrdinal: 6, component: 'kihon', requirement: 'YOKOGERI KEAGE', detail: 'in KIBADACHI, right and left (step in)' },
  { gradeLabel: '6th Kyu', gradeOrdinal: 6, component: 'kihon', requirement: 'YOKOGERI KEKOMI', detail: 'in KIBADACHI, right and left (step in)' },
  { gradeLabel: '6th Kyu', gradeOrdinal: 6, component: 'kata', requirement: 'HEIAN NIDAN', detail: null },
  { gradeLabel: '6th Kyu', gradeOrdinal: 6, component: 'kumite', requirement: 'KIHON IPPON KUMITE', detail: 'JOUDAN JUNZUKI — right and left, CHUUDAN JUNZUKI — right and left' },

  // ── 5th Kyu ──
  { gradeLabel: '5th Kyu', gradeOrdinal: 5, component: 'kihon', requirement: 'CHUUDAN JUNZUKI (step in)', detail: 'IDO KIHON — moving basics' },
  { gradeLabel: '5th Kyu', gradeOrdinal: 5, component: 'kihon', requirement: 'JOUDAN AGEUKE, GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '5th Kyu', gradeOrdinal: 5, component: 'kihon', requirement: 'CHUUDAN SOTOUKE, GYAKUZUKI (step in)', detail: null },
  { gradeLabel: '5th Kyu', gradeOrdinal: 5, component: 'kihon', requirement: 'CHUUDAN UCHIUKE, GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '5th Kyu', gradeOrdinal: 5, component: 'kihon', requirement: 'KOUKUTSU SHUTOUUKE (step in)', detail: null },
  { gradeLabel: '5th Kyu', gradeOrdinal: 5, component: 'kihon', requirement: 'MAEGERI (GEDAN KAKIWAKE) (step in)', detail: null },
  { gradeLabel: '5th Kyu', gradeOrdinal: 5, component: 'kihon', requirement: 'YOKOGERI KEAGE', detail: 'in KIBADACHI, right and left (step in)' },
  { gradeLabel: '5th Kyu', gradeOrdinal: 5, component: 'kihon', requirement: 'YOKOGERI KEKOMI', detail: 'in KIBADACHI, right and left (step in)' },
  { gradeLabel: '5th Kyu', gradeOrdinal: 5, component: 'kata', requirement: 'HEIAN SANDAN', detail: null },
  { gradeLabel: '5th Kyu', gradeOrdinal: 5, component: 'kumite', requirement: 'KIHON IPPON KUMITE', detail: 'JOUDAN JUNZUKI — right and left, CHUUDAN JUNZUKI — right and left, CHUUDAN MAEGERI GEDAN KAKIWAKE — right and left' },

  // ── 4th Kyu ──
  { gradeLabel: '4th Kyu', gradeOrdinal: 4, component: 'kihon', requirement: 'CHUUDAN JUNZUKI (step in)', detail: 'IDO KIHON — moving basics' },
  { gradeLabel: '4th Kyu', gradeOrdinal: 4, component: 'kihon', requirement: 'SANBON RENZUKI (step in)', detail: null },
  { gradeLabel: '4th Kyu', gradeOrdinal: 4, component: 'kihon', requirement: 'JOUDAN AGEUKE, GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '4th Kyu', gradeOrdinal: 4, component: 'kihon', requirement: 'CHUUDAN SOTOUKE, GYAKUZUKI (step in)', detail: null },
  { gradeLabel: '4th Kyu', gradeOrdinal: 4, component: 'kihon', requirement: 'CHUUDAN UCHIUKE, GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '4th Kyu', gradeOrdinal: 4, component: 'kihon', requirement: 'KOUKUTSU SHUTOUUKE, ZENKUTSU NUKITE (step in)', detail: null },
  { gradeLabel: '4th Kyu', gradeOrdinal: 4, component: 'kihon', requirement: 'MAEGERI (GEDAN KAKIWAKE) (step in)', detail: null },
  { gradeLabel: '4th Kyu', gradeOrdinal: 4, component: 'kihon', requirement: 'YOKOGERI KEAGE', detail: 'in KIBADACHI, right and left (step in)' },
  { gradeLabel: '4th Kyu', gradeOrdinal: 4, component: 'kihon', requirement: 'YOKOGERI KEKOMI', detail: 'in ZENKUTSUDACHI (step in)' },
  { gradeLabel: '4th Kyu', gradeOrdinal: 4, component: 'kata', requirement: 'HEIAN YONDAN', detail: null },
  { gradeLabel: '4th Kyu', gradeOrdinal: 4, component: 'kumite', requirement: 'KIHON IPPON KUMITE', detail: 'JOUDAN JUNZUKI — right and left, CHUUDAN JUNZUKI — right and left, CHUUDAN MAEGERI GEDAN KAKIWAKE — right and left, CHUUDAN YOKOGERI KEKOMI — right and left' },

  // ── 3 Kyu ──
  { gradeLabel: '3 Kyu', gradeOrdinal: 3, component: 'kihon', requirement: 'CHUUDAN JUNZUKI (step in)', detail: 'IDO KIHON — moving basics' },
  { gradeLabel: '3 Kyu', gradeOrdinal: 3, component: 'kihon', requirement: 'SANBON RENZUKI (step in)', detail: null },
  { gradeLabel: '3 Kyu', gradeOrdinal: 3, component: 'kihon', requirement: 'JOUDAN AGEUKE, GYAKU ZUKI (step in)', detail: null },
  { gradeLabel: '3 Kyu', gradeOrdinal: 3, component: 'kihon', requirement: 'CHUUDAN SOTOUKE, GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '3 Kyu', gradeOrdinal: 3, component: 'kihon', requirement: 'CHUUDAN UCHIUKE, GYAKU ZUKI (step in)', detail: 'as KOUKUTSUDACHI is' },
  { gradeLabel: '3 Kyu', gradeOrdinal: 3, component: 'kihon', requirement: 'KOUKUTSU SHUTOU UKE, ZENKUTSU NUKITE (step back)', detail: null },
  { gradeLabel: '3 Kyu', gradeOrdinal: 3, component: 'kihon', requirement: 'MAEGERI (GEDAN KAKIWAKE) (step in)', detail: null },
  { gradeLabel: '3 Kyu', gradeOrdinal: 3, component: 'kihon', requirement: 'YOKOGERI KEAGE', detail: 'in KIBA DACHI, right and left (step in)' },
  { gradeLabel: '3 Kyu', gradeOrdinal: 3, component: 'kihon', requirement: 'YOKOGERI KEKOMI', detail: 'in ZENKUTSU DACHI (step in)' },
  { gradeLabel: '3 Kyu', gradeOrdinal: 3, component: 'kata', requirement: 'HEIAN GODAN', detail: null },
  { gradeLabel: '3 Kyu', gradeOrdinal: 3, component: 'kumite', requirement: 'JIYUU IPPON KUMITE', detail: 'JOUDAN JUNZUKI, CHUUDAN JUNZUKI, CHUDAN MAEGERI — right and left' },

  // ── 2 Kyu ──
  { gradeLabel: '2 Kyu', gradeOrdinal: 2, component: 'kihon', requirement: 'JOUDAN JUNZUKI, CHUUDAN GYAKUZUKI (step in)', detail: 'IDO KIHON — moving basics' },
  { gradeLabel: '2 Kyu', gradeOrdinal: 2, component: 'kihon', requirement: 'JOUDAN AGEUKE, GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '2 Kyu', gradeOrdinal: 2, component: 'kihon', requirement: 'CHUUDAN SOTOUKE, GYAKUZUKI (step in)', detail: null },
  { gradeLabel: '2 Kyu', gradeOrdinal: 2, component: 'kihon', requirement: 'CHUUDAN UCHIUKE, GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '2 Kyu', gradeOrdinal: 2, component: 'kihon', requirement: 'KOUKUTSU SHUTOUUKE, ZENKUTSU NUKITE (step in)', detail: null },
  { gradeLabel: '2 Kyu', gradeOrdinal: 2, component: 'kihon', requirement: 'MAEGERI (GEDAN KAKIWAKE) (step in)', detail: null },
  { gradeLabel: '2 Kyu', gradeOrdinal: 2, component: 'kihon', requirement: 'MAWASHIGERI (step in)', detail: null },
  { gradeLabel: '2 Kyu', gradeOrdinal: 2, component: 'kihon', requirement: 'YOKOGERI KEAGE', detail: 'in KIBADACHI, right and left (step in)' },
  { gradeLabel: '2 Kyu', gradeOrdinal: 2, component: 'kihon', requirement: 'YOKOGERI KEKOMI', detail: 'in ZENKUTSUDACHI (step in)' },
  { gradeLabel: '2 Kyu', gradeOrdinal: 2, component: 'kata', requirement: 'TEKKI SHODAN', detail: null },
  { gradeLabel: '2 Kyu', gradeOrdinal: 2, component: 'kumite', requirement: 'JIYUU IPPON KUMITE', detail: 'JODAN JUNZUKI, CHUUDAN JUNZUKI, CHUUDAN MAEGERI, CHUUDAN YOKOGERI KEKOMI, MAWASHIGERI — right and left. Inform your choice of JOUDAN or CHUUDAN for MAWASHIGERI' },

  // ── 1st Kyu ──
  { gradeLabel: '1st Kyu', gradeOrdinal: 1, component: 'kihon', requirement: 'JOUDAN JUNZUKI, CHUUDAN GYAKUZUKI (step in)', detail: 'IDO KIHON — moving basics' },
  { gradeLabel: '1st Kyu', gradeOrdinal: 1, component: 'kihon', requirement: 'JOUDAN AGEUKE, GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '1st Kyu', gradeOrdinal: 1, component: 'kihon', requirement: 'CHUUDAN SOTOUKE, YOKOENPI (step in)', detail: 'ZENKUTSUDACHI changing stance to KIBADACHI' },
  { gradeLabel: '1st Kyu', gradeOrdinal: 1, component: 'kihon', requirement: 'CHUUDAN UCHIUKE, GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '1st Kyu', gradeOrdinal: 1, component: 'kihon', requirement: 'KOUKUTSU SHUTOU UKE, ZENKUTSU NUKITE (step in)', detail: null },
  { gradeLabel: '1st Kyu', gradeOrdinal: 1, component: 'kihon', requirement: 'MAEGERI (on the spot), MAEGERI (step in)', detail: null },
  { gradeLabel: '1st Kyu', gradeOrdinal: 1, component: 'kihon', requirement: 'MAWASHIGERI (step in)', detail: null },
  { gradeLabel: '1st Kyu', gradeOrdinal: 1, component: 'kihon', requirement: 'YOKOGERI KEAGE', detail: 'in KIBADACHI, right and left (step in)' },
  { gradeLabel: '1st Kyu', gradeOrdinal: 1, component: 'kihon', requirement: 'YOKOGERI KEKOMI (ZENKUTSUDACHI) (step in)', detail: null },
  { gradeLabel: '1st Kyu', gradeOrdinal: 1, component: 'kata', requirement: 'BASSAI DAI', detail: null },
  { gradeLabel: '1st Kyu', gradeOrdinal: 1, component: 'kumite', requirement: 'JIYU IPPON KUMITE', detail: 'JOUDAN JUNZUKI, CHUUDAN JUNZUKI, CHUUDAN MAEGERI, CHUUDAN YOKOGERI KEKOMI, MAWASHIGERI — right and left. Inform your choice of JOUDAN or CHUUDAN for MAWASHIGERI' },

  // ── 1st Dan ──
  { gradeLabel: '1st Dan', gradeOrdinal: 11, component: 'kihon', requirement: 'SANBON RENZUKI (step in)', detail: 'IDO KIHON — moving basics' },
  { gradeLabel: '1st Dan', gradeOrdinal: 11, component: 'kihon', requirement: 'JOUDAN AGEUKE, GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '1st Dan', gradeOrdinal: 11, component: 'kihon', requirement: 'CHUUDAN SOTOUKE, YOKOENPI, YOKOURAKEN UCHI, GYAKUZUKI (step in)', detail: 'ZENKUTSUDACHI changing stance to KIBADACHI changing stance to ZENKUTSU DACHI' },
  { gradeLabel: '1st Dan', gradeOrdinal: 11, component: 'kihon', requirement: 'CHUUDAN UCHIUKE, KIZAMIZUKI, GYAKUZUKI (step back)', detail: 'KOUKUTSUDACHI to ZENKUTSUDACHI' },
  { gradeLabel: '1st Dan', gradeOrdinal: 11, component: 'kihon', requirement: 'KOUKUTSU SHUTOU UKE, ZENKUTSU NUKITE (step in)', detail: null },
  { gradeLabel: '1st Dan', gradeOrdinal: 11, component: 'kihon', requirement: 'MAEGERI (on the spot), MAE GERI (step in)', detail: null },
  { gradeLabel: '1st Dan', gradeOrdinal: 11, component: 'kihon', requirement: 'MAWASHIGERI (step in)', detail: null },
  { gradeLabel: '1st Dan', gradeOrdinal: 11, component: 'kihon', requirement: 'YOKOGERI KEAGE', detail: 'in KIBA DACHI, right and left (step in)' },
  { gradeLabel: '1st Dan', gradeOrdinal: 11, component: 'kihon', requirement: 'YOKOGERI KEKOMI (ZENKUTSUDACHI)', detail: null },
  { gradeLabel: '1st Dan', gradeOrdinal: 11, component: 'kata', requirement: 'BASSAI DAI, KANKU DAI, ENPI or JION (your choice)', detail: null },
  { gradeLabel: '1st Dan', gradeOrdinal: 11, component: 'kumite', requirement: 'JIYU IPPON KUMITE', detail: 'JOUDAN JUNZUKI, CHUUDAN JUNZUKI, CHUUDAN MAEGERI, CHUUDAN YOKOGERI KEKOMI, JOUDAN MAWASHIGERI — right and left. Inform your choice of JOUDAN or CHUUDAN for MAWASHIGERI' },

  // ── 2nd Dan ──
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kihon', requirement: 'CHUUDAN JUNZUKI (step in)', detail: 'IDO KIHON — moving basics' },
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kihon', requirement: 'JOUDAN JYUNZUKI, CHUUDAN GYAKUZUKI (step in)', detail: null },
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kihon', requirement: 'SANBON RENZUKI (step in)', detail: null },
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kihon', requirement: 'AGEUKE, SOTOUKE (with same arm), GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kihon', requirement: 'UCHIUKE, KIZAMIZUKI, GYAKUZUKI (step in)', detail: 'KOKUTSUDACHI to ZENKUTSUDACHI' },
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kihon', requirement: 'KOUKUTSHU SHUTOUUKE, ZENKUTSU NUKITE (step back)', detail: null },
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kihon', requirement: 'MAEGERI (on the spot), MAEGERI (step in)', detail: null },
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kihon', requirement: 'YOKOGERI KEAGE, YOKOGERI KEKOMI', detail: 'KIBADACHI, alternate feet' },
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kihon', requirement: 'YOKOGERI KEKOMI (ZENKUTSUDACHI) (step in)', detail: null },
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kihon', requirement: 'MAWASHIGERI, YOKOURAKENUCHI, CHUUDAN GYAKUZUKI (step in)', detail: null },
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kata', requirement: "Student's favorite KATA", detail: null },
  { gradeLabel: '2nd Dan', gradeOrdinal: 12, component: 'kumite', requirement: 'JIYU KUMITE', detail: null },

  // ── 3rd Dan ──
  { gradeLabel: '3rd Dan', gradeOrdinal: 13, component: 'kihon', requirement: 'KIZAMIZUKI, JOUDAN JUNZUKI, CHUUDAN GYAKUZUKI (step in)', detail: 'IDO KIHON — moving basics, free KAMAE' },
  { gradeLabel: '3rd Dan', gradeOrdinal: 13, component: 'kihon', requirement: 'AGEUKE, SOTOUKE (with same arm), GYAKUZUKI (step back)', detail: null },
  { gradeLabel: '3rd Dan', gradeOrdinal: 13, component: 'kihon', requirement: 'UCHIUKE, KIZAMIZUKI, GYAKUZUKI (step in)', detail: 'KOKUTSUDACHI to ZENKUTSUDACHI' },
  { gradeLabel: '3rd Dan', gradeOrdinal: 13, component: 'kihon', requirement: 'KOUKUTSU SHUTOUUKE, KIZAMIMAEGERI, ZENKUTSU NUKITE (step back)', detail: null },
  { gradeLabel: '3rd Dan', gradeOrdinal: 13, component: 'kihon', requirement: 'MAEGERI GYAKUZUKI, YOKOGERI KEKOMI GYAKUZUKI, MAWASHIGERI GYAKUZUKI (step in)', detail: null },
  { gradeLabel: '3rd Dan', gradeOrdinal: 13, component: 'kihon', requirement: 'USHIROGERI (step in)', detail: null },
  { gradeLabel: '3rd Dan', gradeOrdinal: 13, component: 'kihon', requirement: 'MAEGERI, YOKOGERI KEKOMI, USHIROGERI', detail: 'ZENKUTSUDACHI same feet right and left' },
  { gradeLabel: '3rd Dan', gradeOrdinal: 13, component: 'kata', requirement: "Student's favorite KATA (Question and Answer Session)", detail: null },
  { gradeLabel: '3rd Dan', gradeOrdinal: 13, component: 'kumite', requirement: 'JIYU KUMITE', detail: null },
];

// ─── WKF sport kumite ───────────────────────────────────────────────────────

export interface RulesetProvision {
  article: string;
  clause: string | null;
  topic: 'scoring' | 'prohibited' | 'category' | 'time' | 'penalty' | 'protest' | 'area';
  heading: string | null;
  sourceQuote: string;
  appliesTo: string;
}

export const WKF_KUMITE_RULESET = {
  slug: 'wkf-kumite-2026-01',
  authority: 'WKF',
  version: '2026.01',
  title: 'WKF Kumite Competition Rules',
  effectiveFrom: '2026-01-01',
  documentUrl:
    'https://www.wkf.net/files/pdf/documents/WKF%202026%20Kumite%20Competition%20Rules%20MASTER%20COPY_V11.pdf',
  status: 'in_force' as const,
} as const;

/**
 * WKF Kumite Competition Rules, version 2026.01, valid from 1.1.2026.
 *
 * Articles 8 (Scoring) and 9.1.1 (Prohibited behaviour) transcribed clause by
 * clause. These two carry almost all of what a competitor or a coach actually
 * needs to study, and they are the articles a learner is most likely to be
 * given a folk version of.
 *
 * NOT TRADITIONAL SHOTOKAN. Article 8.6 awards three points for a jodan kick
 * and one for any punch; that is a sport-scoring convention and says nothing
 * about the technical value of a technique in Shotokan practice. The two
 * domains are kept in separate tables for precisely this reason.
 */
export const WKF_KUMITE_PROVISIONS: readonly RulesetProvision[] = [
  {
    article: 'Article 8', clause: '8.1', topic: 'scoring', heading: 'When a score is awarded',
    sourceQuote: 'A score is awarded to an Athlete when two or more judges indicate a score or when the Video Review Judge agrees on a score after a Coach has raised a Video Request.',
    appliesTo: 'all',
  },
  {
    article: 'Article 8', clause: '8.2', topic: 'scoring', heading: 'What scores',
    sourceQuote: 'Points are scored by a traditional karate technique with the hand or foot executed with control to the scoring area.',
    appliesTo: 'all',
  },
  {
    article: 'Article 8', clause: '8.3', topic: 'scoring', heading: 'First technique of an exchange',
    sourceQuote: 'Only the first correctly executed technique of an exchange will score, with the exception of an effective combination of techniques, in which case the highest scoring technique will count regardless of the sequence of techniques in the combination.',
    appliesTo: 'all',
  },
  {
    article: 'Article 8', clause: '8.4', topic: 'scoring', heading: 'Scoring areas',
    sourceQuote: 'The scoring areas are the body above the pelvis, up to and including the collarbone (CHUDAN), excluding the junction of the upper bone of the arm with the shoulder blades and collarbones, and the area above the collarbone (JODAN).',
    appliesTo: 'all',
  },
  {
    article: 'Article 8', clause: '8.5', topic: 'scoring', heading: 'The six scoring criteria',
    sourceQuote: 'In order to be considered a score, the technique must have the potential to be effective if it had not been controlled, and must also fulfil the criteria of: 1) Good form (Properly executed technique). 2) Sporting attitude (Delivered without intent to cause injury). 3) Vigorous application (Delivery with speed and power). 4) Maintaining awareness of the opponent both during and after execution of the technique (Not turning away or falling down after completing a technique — unless the fall is caused by a foul by the opponent). 5) Good timing (Delivery of the technique at the correct moment). 6) Correct distance (Delivery at a distance where the technique would be effective). In order to be a valid score, a technique has to fulfil all the six scoring criteria.',
    appliesTo: 'all',
  },
  {
    article: 'Article 8', clause: '8.6', topic: 'scoring', heading: 'The scale of points',
    sourceQuote: 'YUKO (1 point) is awarded for TSUKI (straight punch) or UCHI (strike) to a scoring area. WAZA ARI (2 points) is awarded for CHUDAN kicks. IPPON (3 points) is awarded for JODAN kicks or any legal technique against an opponent whose any part of the body other than the feet is in contact with the mat, with the exception of HIZA GAMAE (One knee touching the mat while executing a technique).',
    appliesTo: 'all',
  },
  {
    article: 'Article 8', clause: '8.7', topic: 'scoring', heading: 'Contact to chudan',
    sourceQuote: 'Techniques to the CHUDAN area may be delivered with controlled impact without causing injury to the opponent. A loss of breath by the recipient of a blow does not in itself indicate lack of control.',
    appliesTo: 'all',
  },
  {
    article: 'Article 8', clause: '8.8', topic: 'scoring', heading: 'Distance to jodan',
    sourceQuote: 'Techniques to the JODAN area can score when stopped within 5 cm of the target for kicks and 2 cm for hand techniques, but may be delivered with light touch (skin touch), without causing impact, with the exception of the throat area, where no physical contact is allowed. For Cadet and U14 competitions, techniques to the JODAN area can score when stopped within 10 cm of the target for kicks and 5 cm for hand techniques, but may be delivered with light touch (skin touch), without causing impact.',
    appliesTo: 'all',
  },
  {
    article: 'Article 8', clause: '8.9', topic: 'scoring', heading: 'Skin touch',
    sourceQuote: '"Skin touch" is allowed in all age categories. "Skin touch" is defined as touching the target without transferring energy into the protected helmet or head of the Athlete.',
    appliesTo: 'all',
  },
  {
    article: 'Article 8', clause: '8.10', topic: 'scoring', heading: 'Techniques at time-up',
    sourceQuote: 'Correctly executed techniques landed at the moment the time runs out are valid. When using electronic judging, points must be signalled within 1.5 seconds of time expiring.',
    appliesTo: 'all',
  },
  {
    article: 'Article 8', clause: '8.11', topic: 'scoring', heading: 'When a technique is invalid',
    sourceQuote: 'A technique is invalid if: a) Executed after the time-up signal or the Referee calling "YAME". b) Executed upon or after "WAKARETE" before "TSUZUKETE" has been called. c) Executed when the performer is outside the competition area (JOGAI). d) Followed by a foul of excessive contact or otherwise causing injury. e) One turns one\'s back to the opponent after a technique (lack of awareness). f) It is executed after a violation of the rules (such as excessive contact, holding, grabbing, etc.) meaning that one cannot use a foul to create the opening for a score.',
    appliesTo: 'all',
  },
  {
    article: 'Article 9', clause: '9.1.1', topic: 'prohibited', heading: 'Prohibited behaviour',
    sourceQuote: 'The following behaviours are prohibited: 1) Techniques that make excessive contact, having regard to the scoring area attacked, and techniques that make contact with the throat. 2) Attacks to the arms, legs, groin, joints, or instep. 3) Attacks to the face with open-hand techniques. 4) Techniques executed after "WAKARETE" and before "TSUZUKETE" have been called. 5) Dangerous or forbidden throwing techniques. 6) Feigning or exaggerating injury. 7) Exit from the competition area (JOGAI) not caused by the opponent or following a score. 8) Self-endangerment by indulging in behaviour that exposes the Athlete to injury by the opponent, or failing to take adequate measures for self-protection (MUBOBI). 9) Avoiding combat as a means of preventing the opponent from having the opportunity to score. 10) Passivity — not attempting to engage in combat (Cannot be given in the first 15 seconds of the bout, after there are less than 15 seconds left of the bout, or to someone having a lead by points or SENSHU). 11) Clinching, wrestling, pushing, or standing chest to chest without attempting a scoring technique or takedown. 12) Grabbing the opponent with both hands for any reason other than executing a takedown upon catching the opponent\'s kicking leg. 13) Grabbing the opponent\'s arm or Karategi with one hand without immediately attempting a scoring technique or takedown. 14) Techniques, which by their nature, cannot be controlled for the safety of the opponent and dangerous and uncontrolled attacks. 15) Simulated or actual attacks with the head, knees, or elbows. 16) Kicking techniques against a downed opponent who is lying flat on the floor. 17) Talking to, or goading the opponent, failing to obey the orders of the Referee, discourteous behaviour towards the Refereeing officials, or other violations of etiquette.',
    appliesTo: 'all',
  },
  {
    article: 'Article 9', clause: '9.1.2', topic: 'prohibited', heading: 'Scoring then exiting',
    sourceQuote: 'An Athlete who delivers a scoring technique and then exits the area before the Referee calls "YAME" will be given the value of the score and JOGAI will not be imposed. If the Athlete\'s attempt to score is unsuccessful, the exit will be recorded as a JOGAI.',
    appliesTo: 'all',
  },
  {
    article: 'Article 1', clause: '1.1', topic: 'area', heading: 'Competition area',
    sourceQuote: 'The competition area will be a WKF Approved matted square with sides of eight metres (measured from the outside) with the mats in the outer one-metre area in another colour marking the boundary, and there will be a 2 metres safety area surrounding the competition area.',
    appliesTo: 'all',
  },
];

/**
 * The JKA's statement of the relationship between the three pillars.
 *
 * Quoted because the directive requires the kihon/kata/kumite relationship to
 * be preserved throughout the data model, and this is the source it rests on.
 */
export const JKA_THREE_PILLARS = {
  sourceUrl: 'https://www.jka.or.jp/en/about-jka/techniques/',
  quote:
    'They are, in essence, one. And they must be studied as one: without the kihon basic techniques, ' +
    'there can be neither kata nor kumite.',
  kihon: 'The foundation of karate is the kihon (basic techniques).',
  kata: 'the core of all karate skills',
  kumite:
    'discover how to respond to situations naturally and freely, and apply your techniques ' +
    'appropriately as the circumstances demand',
} as const;

/**
 * What the JKA instructor manual says about counting movements — the evidence
 * behind this pass's refusal to publish per-kata movement counts.
 */
export const MOVEMENT_COUNT_EVIDENCE = {
  sourceUrl: 'https://www.jka.or.jp/wp/wp-content/uploads/2017/04/tech_manual_instructor.pdf',
  sourceTitle: 'Technical Manual for the Instructor (Japan Karate Association)',
  quotes: [
    'verify that there is an accurate number of movements',
    'one count is equal to one movement; be aware of proper rhythm in counting',
  ],
  finding:
    'The manual requires an accurate movement count but does not publish per-kata counts. No ' +
    'movement count is asserted from this source.',
} as const;
