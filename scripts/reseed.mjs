#!/usr/bin/env node
// Push corrected content into the editorial store.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS, AND WHY IT DID NOT BEFORE
// ─────────────────────────────────────────────────────────────────────────────
//
// src/lib/storage.ts reads editorial content from Upstash Redis and falls back
// to src/data/seed.ts ONLY WHEN A KEY IS MISSING. Once a key exists in Redis,
// the seed file is never consulted again.
//
// That is correct — the admin console writes to Redis, and a deploy must not
// silently revert what the federation typed. But it has a consequence nobody
// had faced until now: EDITING seed.ts DOES NOTHING TO A RUNNING SITE.
//
// The federation asked for the personal phone number, the personal UPI handle,
// the fabricated events and the "Tiger Lee lineage" claim to be removed. All of
// that was removed from seed.ts, committed, and pushed — and the live site went
// on showing every one of them, because the live values were in Redis. There
// was no path from a correction to the running federation at all.
//
// This script is that path.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT IS DESTRUCTIVE, SO IT REFUSES TO BE CASUAL
// ─────────────────────────────────────────────────────────────────────────────
//
// Overwriting a key discards whatever the federation last edited through the
// admin console. So:
//
//   · DRY RUN IS THE DEFAULT. With no flags it writes nothing and prints, per
//     key, exactly what would change.
//   · --write is required to change anything, and it names each key as it goes.
//   · --key=<name> narrows it to one key. Correcting a phone number should not
//     have to overwrite the gallery.
//   · IT SHOWS THE OLD VALUE. A tool that tells you what it destroyed after the
//     fact is a tool you cannot use with any confidence beforehand.
//
// Usage:
//   node scripts/reseed.mjs                      inspect everything, change nothing
//   node scripts/reseed.mjs --key=federation     inspect one key
//   node scripts/reseed.mjs --key=federation --write
//   node scripts/reseed.mjs --write              overwrite every drifted key
//
// Requires UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN in the
// environment — the same names src/lib/storage.ts reads.

import { SEED, KEYS } from '../src/data/seed.ts';

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';

if (!URL_ || !TOKEN) {
  console.error(
    'No editorial store configured.\n\n' +
    'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or the KV_REST_API_*\n' +
    'equivalents) to the SAME store the site reads. Without them this script would\n' +
    'report that every key needs writing, which is true of an empty store and\n' +
    'false of the federation.'
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const only = (argv.find((a) => a.startsWith('--key=')) || '').split('=')[1] || null;

if (only && !KEYS.includes(only)) {
  console.error(`Unknown key "${only}". Known keys:\n  ${KEYS.join('\n  ')}`);
  process.exit(1);
}

const { Redis } = await import('@upstash/redis');
const redis = new Redis({ url: URL_, token: TOKEN });

/** A short, readable rendering of a value, for the diff. */
function preview(v) {
  if (v === null || v === undefined) return '(absent)';
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 160 ? s.slice(0, 157) + '…' : s;
  }
  return JSON.stringify(v);
}

/**
 * The fields whose removal the federation actually asked for.
 *
 * Called out by name in the report, because "the federation object differs" is
 * not something an operator can act on, and these are the differences that
 * prompted the whole exercise.
 */
function notableChanges(key, live, next) {
  const notes = [];
  const j = (v) => JSON.stringify(v ?? '');
  if (key === 'federation') {
    if (live?.contact?.phone && !next?.contact?.phone) notes.push(`removes the telephone number ${j(live.contact.phone)}`);
    if (live?.upi && !next?.upi) notes.push(`removes the UPI handle ${j(live.upi)}`);
    if (live?.lineage && !next?.lineage) notes.push(`removes the lineage claim ${j(live.lineage)}`);
  }
  if (key === 'programs' && Array.isArray(live)) {
    const priced = live.filter((p) => p && p.fee !== undefined).length;
    if (priced) notes.push(`removes ${priced} monthly price${priced === 1 ? '' : 's'} from the training pathways`);
  }
  for (const [k, label] of [['events', 'fabricated fixtures'], ['circulars', 'fabricated circulars'], ['members', 'hand-typed member rows']]) {
    if (key === k && Array.isArray(live) && live.length && !next?.length) {
      notes.push(`removes ${live.length} ${label}`);
    }
  }
  return notes;
}

const keys = only ? [only] : KEYS;
let drifted = 0;
let written = 0;

console.log(WRITE ? 'WRITING corrected content.\n' : 'DRY RUN — nothing will be changed.\n');

for (const key of keys) {
  const next = SEED[key];
  if (next === undefined) continue;

  let live;
  try {
    live = await redis.get(`mmakf:${key}`);
  } catch (e) {
    console.log(`  ${key.padEnd(14)} COULD NOT READ — ${String(e?.message ?? e).slice(0, 80)}`);
    continue;
  }

  if (live === null || live === undefined) {
    console.log(`  ${key.padEnd(14)} absent in the store; the site already falls back to the corrected seed`);
    continue;
  }

  if (JSON.stringify(live) === JSON.stringify(next)) {
    console.log(`  ${key.padEnd(14)} already matches`);
    continue;
  }

  drifted++;
  console.log(`\n  ${key} DIFFERS`);
  console.log(`    live : ${preview(live)}`);
  console.log(`    seed : ${preview(next)}`);
  for (const n of notableChanges(key, live, next)) console.log(`    → ${n}`);

  if (WRITE) {
    await redis.set(`mmakf:${key}`, next);
    written++;
    console.log('    WRITTEN');
  }
}

console.log('');
if (!drifted) {
  console.log('Nothing differs. The store already carries the corrected content.');
} else if (WRITE) {
  console.log(`${written} key(s) written. The live site will serve the corrected content immediately —`);
  console.log('the store is read per request, so no redeploy is needed.');
} else {
  console.log(`${drifted} key(s) differ and NOTHING WAS CHANGED.`);
  console.log('Re-run with --write to apply, or --key=<name> --write for one at a time.');
}
