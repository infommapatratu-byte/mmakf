#!/usr/bin/env node
// The video discovery pipeline (§40, §50).
//
//   node scripts/discover-videos.mjs              report what a fresh pass finds
//   node scripts/discover-videos.mjs --json        machine-readable
//   node scripts/discover-videos.mjs --new-only    only ids not already registered
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// It is the pass that produced src/data/shotokan/video-register.ts, kept in the
// repository so the register is REPRODUCIBLE rather than a set of numbers an
// agent once typed. Anyone can run it and compare.
//
// It is NOT an auto-publisher, and it never writes to the register or to the
// database. §40 is explicit — "Never auto-publish arbitrary web videos" — and
// §39 draws the same line for machine classification: what comes out of here is
// CANDIDATE DATA. A human decides what it means.
//
// The stages, in order, are the ones the directive names:
//
//   DISCOVER          fetch each registered source page, extract the YouTube
//                     ids the page itself embeds. No search engine, no guessing
//                     — if a source does not embed it, this pass never saw it.
//   DEDUPLICATE       one id, one candidate, however many pages carry it.
//   VERIFY            ask the platform. Title, channel and channel URL come
//                     from YouTube, never from the caption on the source page,
//                     because captions drift and a drifted caption is how a
//                     library ends up labelling the wrong form.
//   SOURCE SCORE      the seed authority rank of the page it was found on.
//   CLASSIFY          a conservative guess at kind and kata, from the platform
//                     title only. Marked as a guess in the output.
//   RIGHTS CHECK      the only structural question this pass can answer: did the
//                     organisation being cited upload it, or did somebody else?
//   REVIEW QUEUE      everything is output as a candidate. Nothing is approved.
//
// A NEGATIVE CONTROL RUNS FIRST and the pass aborts if it passes. A verifier
// that cannot fail manufactures confidence, which is the failure this whole
// register exists to prevent.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const newOnly = args.includes('--new-only');

// ── Sources ────────────────────────────────────────────────────────────────
//
// Read from the register rather than restated here, so the script and the data
// cannot drift into disagreeing about where the federation looks.
const REGISTER = 'src/data/shotokan/video-register.ts';
const src = readFileSync(REGISTER, 'utf8');

const sources = [];
{
  const block = src.slice(src.indexOf('export const SOURCES'), src.indexOf('export const BARREN_SOURCES'));
  const RE = /key:\s*'([^']+)'[\s\S]*?url:\s*'([^']+)'[\s\S]*?authorityRank:\s*(\d+)/g;
  let m;
  while ((m = RE.exec(block))) sources.push({ key: m[1], url: m[2], authorityRank: Number(m[3]) });
}
{
  // Barren sources are re-checked too. A source that was empty last time can
  // acquire material, and one that was dropped silently never gets looked at
  // again — which is how a register slowly stops reflecting the world.
  const block = src.slice(src.indexOf('export const BARREN_SOURCES'));
  const RE = /key:\s*'([^']+)',\s*\n\s*organisation:[^\n]*\n\s*url:\s*'([^']+)'/g;
  let m;
  while ((m = RE.exec(block))) sources.push({ key: m[1], url: m[2], authorityRank: 999 });
}

const registeredIds = new Set([...src.matchAll(/id:\s*"([A-Za-z0-9_-]{11})"/g)].map((m) => m[1]));

if (sources.length === 0) {
  console.error(`No sources parsed from ${REGISTER}. Refusing to report an empty discovery as success.`);
  process.exit(1);
}

// ── Stage 1: DISCOVER ──────────────────────────────────────────────────────
const ID_IN_PAGE =
  /(?:youtube\.com\/(?:embed\/|v\/|watch\?[^"'\s]*?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/g;

const found = new Map();          // id → { via, rank, pageContext }
const sourceReport = [];

for (const s of sources) {
  const rec = { key: s.key, url: s.url, status: 0, ids: 0, error: null };
  try {
    const res = await fetch(s.url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; MMAKF-source-research/1.0)' },
      redirect: 'follow',
    });
    rec.status = res.status;
    const html = await res.text();
    const seen = new Set();
    let m;
    ID_IN_PAGE.lastIndex = 0;
    while ((m = ID_IN_PAGE.exec(html))) {
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      // Stage 2: DEDUPLICATE. The most authoritative page that carries an id
      // wins the attribution; a later, lower-ranked page does not overwrite it.
      const prior = found.get(id);
      if (!prior || s.authorityRank < prior.rank) {
        found.set(id, { via: s.key, rank: s.authorityRank });
      }
    }
    rec.ids = seen.size;
  } catch (e) {
    rec.error = String(e?.message ?? e);
  }
  sourceReport.push(rec);
  if (!asJson) {
    console.log(`  ${rec.key.padEnd(12)} HTTP ${rec.status || '---'}  ids=${String(rec.ids).padStart(3)}${rec.error ? `  ERROR ${rec.error}` : ''}`);
  }
}

// ── Negative control ───────────────────────────────────────────────────────
const oembed = async (id) => {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
  const res = await fetch(url, { headers: { 'user-agent': 'MMAKF-source-research/1.0' } });
  return { status: res.status, body: res.status === 200 ? await res.json().catch(() => null) : null };
};

const control = await oembed('AAAAAAAAAAA').catch(() => ({ status: -1 }));
if (control.status === 200 || control.status === -1) {
  console.error('Negative control did not fail as expected. Aborting rather than writing unverified candidates.');
  process.exit(2);
}

// ── Stage 3–6: VERIFY, SCORE, CLASSIFY, RIGHTS ─────────────────────────────

// Longest first, so "bassai sho" is never matched as "bassai dai".
const KATA_MATCH = [
  ['heian shodan', 'heian-shodan'], ['heian nidan', 'heian-nidan'], ['heian sandan', 'heian-sandan'],
  ['heian yondan', 'heian-yondan'], ['heian godan', 'heian-godan'],
  ['tekki shodan', 'tekki-shodan'], ['tekki nidan', 'tekki-nidan'], ['tekki sandan', 'tekki-sandan'],
  ['bassai dai', 'bassai-dai'], ['bassai sho', 'bassai-sho'],
  ['kanku dai', 'kanku-dai'], ['kanku sho', 'kanku-sho'],
  ['gojushiho dai', 'gojushiho-dai'], ['gojushiho-dai', 'gojushiho-dai'],
  ['gojushiho sho', 'gojushiho-sho'], ['gojushiho-sho', 'gojushiho-sho'], ['goju shi ho sho', 'gojushiho-sho'],
  ["ji'in", 'jiin'], ['jiin', 'jiin'], ['jion', 'jion'], ['jitte', 'jitte'],
  ['enpi', 'empi'], ['empi', 'empi'],
  ['hangetsu', 'hangetsu'], ['gankaku', 'gankaku'], ['chinte', 'chinte'], ['sochin', 'sochin'],
  ['nijushiho', 'nijushiho'], ['meikyo', 'meikyo'], ['wankan', 'wankan'], ['unsu', 'unsu'],
].sort((a, b) => b[0].length - a[0].length);

// Channels that ARE the organisation the source page represents. This is the
// only rights question a script can answer, and it decides whether a candidate
// can be cited or must wait for a committee.
const OWN_CHANNEL = {
  'jka-india': ['JKAIndiahq', 'JKA India'],
  cambridge: ['Cambridge University Karate Club'],
};

function classify(title) {
  const s = title.toLowerCase();
  if (/explanation|teaching|instructor camp/.test(s)) return 'teaching_breakdown';
  if (/championship|final|varsity|\bvs\b|boys under|girls kumite|mens individual|men's ind|women's ind/.test(s)) return 'competition_performance';
  if (/camp|seminar|japan trip|message/.test(s)) return 'seminar';
  if (/kumite/.test(s)) return 'kumite_reference';
  if (/kihon|khion|kihion|combination|speed training|budo power/.test(s)) return 'kihon_reference';
  if (/kata/.test(s)) return 'kata_demonstration';
  return 'technical_demonstration';
}

const candidates = [];
let checked = 0;
for (const [id, meta] of found) {
  if (newOnly && registeredIds.has(id)) continue;
  checked++;
  const c = { id, via: meta.via, authorityRank: meta.rank, alreadyRegistered: registeredIds.has(id) };
  try {
    const { status, body } = await oembed(id);
    c.oembedStatus = status;
    if (status === 200 && body) {
      c.title = body.title ?? null;
      c.channel = body.author_name ?? null;
      c.channelUrl = body.author_url ?? null;
      c.thumbnailUrl = body.thumbnail_url ?? null;
      c.embeddable = typeof body.html === 'string' && body.html.includes('/embed/');

      const low = (c.title ?? '').toLowerCase();
      const hit = KATA_MATCH.find(([frag]) => low.includes(frag));
      // MARKED AS A GUESS. §39: AI output is candidate data, not technical
      // truth. A reviewer sees the word "proposed" beside every one of these.
      c.proposedKata = hit ? hit[1] : null;
      c.proposedContentType = hit ? 'kata_demonstration' : classify(c.title ?? '');
      c.channelIsSourceOrganisation = (OWN_CHANNEL[meta.via] ?? []).includes(c.channel);
      c.rightsPosition = c.channelIsSourceOrganisation
        ? 'source_own_channel'
        : 'third_party_upload_requires_review';
    } else {
      c.title = null;
      c.dead = status === 404;
      c.embedDisabled = status === 401;
    }
  } catch (e) {
    c.error = String(e?.message ?? e);
  }
  candidates.push(c);
  await new Promise((r) => setTimeout(r, 120));
}

const live = candidates.filter((c) => c.oembedStatus === 200 && c.embeddable);
const dead = candidates.filter((c) => c.dead);
const noEmbed = candidates.filter((c) => c.embedDisabled);
const fresh = live.filter((c) => !c.alreadyRegistered);

if (asJson) {
  console.log(JSON.stringify({
    ranAt: new Date().toISOString(),
    sources: sourceReport,
    totals: {
      discovered: found.size,
      checked,
      live: live.length,
      dead: dead.length,
      embedDisabled: noEmbed.length,
      notYetRegistered: fresh.length,
      citableWithoutReview: live.filter((c) => c.channelIsSourceOrganisation).length,
    },
    candidates,
  }, null, 2));
} else {
  console.log(`\nDiscovery pass`);
  console.log(`  sources fetched        ${sourceReport.length}`);
  console.log(`  ids discovered         ${found.size}`);
  console.log(`  verified live          ${live.length}`);
  console.log(`  dead (oEmbed 404)      ${dead.length}`);
  console.log(`  embedding disabled     ${noEmbed.length}`);
  console.log(`  not yet in register    ${fresh.length}`);
  console.log(`  citable without review ${live.filter((c) => c.channelIsSourceOrganisation).length}`);

  if (fresh.length) {
    console.log(`\nNEW CANDIDATES — none of these is approved, published, or classified by a human:`);
    for (const c of fresh) {
      console.log(`  ${c.id}  [${c.via}]  ${c.title}`);
      console.log(`            channel: ${c.channel}`);
      console.log(`            proposed: ${c.proposedContentType}${c.proposedKata ? ` / ${c.proposedKata}` : ''}  (machine guess)`);
      console.log(`            rights: ${c.rightsPosition}`);
    }
    console.log(`\nAdd them to ${REGISTER} only after a human has confirmed the classification.`);
  } else {
    console.log(`\nNo candidates the register does not already hold.`);
  }

  if (dead.length) {
    console.log(`\nDEAD ids still embedded on a source page — the source is stale, not this register:`);
    for (const c of dead) console.log(`  ${c.id}  [${c.via}]`);
  }
}

// Discovery finding nothing new is a normal, successful outcome.
process.exit(0);
