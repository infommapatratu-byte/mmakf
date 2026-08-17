#!/usr/bin/env node
// Populate the Shotokan technical library in the database.
//
//   npm run db:migrate         FIRST. The seed needs the tables to exist.
//   npm run library:status     count what is there. Writes nothing.
//   npm run library:seed       apply the seed. Idempotent.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GAP THIS CLOSES
// ─────────────────────────────────────────────────────────────────────────────
//
// `seedTechnicalLibrary()` in src/db/library-seed.ts was complete, idempotent
// and covered by tests/technical-library.test.ts — and NOTHING OUTSIDE THE TEST
// SUITE CALLED IT. There was no script and no route, so the only process that
// had ever run it was vitest, against a throwaway PGlite database that is
// deleted when the run ends.
//
// The consequence was quiet and total: an operator could apply every migration,
// deploy the site, open /admin/technical-library and find an empty queue, with
// nothing anywhere to tell them which command they had missed. A seeder nobody
// can run is a seeder that does not exist, however well tested it is.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE CARRIES A RESOLVE HOOK
// ─────────────────────────────────────────────────────────────────────────────
//
// src/db/library-seed.ts imports through the `@/` alias, which is a tsconfig
// path — Vite and vitest resolve it, and plain node does not:
//
//   Cannot find package '@/db' imported from src/db/library-seed.ts
//
// So the hook below teaches node the one mapping the project already uses. It
// is deliberately narrow: `@/x` → `<root>/src/x`, with the extensions this
// codebase actually uses, and it defers to node's own resolver for everything
// else. A broad hook that guessed at other specifiers would fail somewhere far
// from here and blame the wrong file.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHY IT REFUSES RATHER THAN GUESSES
// ─────────────────────────────────────────────────────────────────────────────
//
// DATABASE_URL must be set. There is no fallback target, because pointing a
// seeder at the wrong environment is far worse than failing loudly —
// scripts/migrate.mjs makes the same refusal for the same reason.
//
// It also refuses to run against an UNMIGRATED database. Seeding a database
// with no tables produces a wall of "relation does not exist" from the driver,
// which reads as a broken seeder rather than as a missing step.

import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

// ── The `@/` resolve hook ──────────────────────────────────────────────────

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const EXTS = ['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.js'];

/** First existing file among `base` and `base + ext`, or null. */
function probe(base) {
  if (existsSync(base) && !base.endsWith(path.sep)) {
    // A directory is not a module; fall through to the /index probes.
    try { if (!statSync(base).isDirectory()) return base; } catch { /* fall through */ }
  }
  for (const e of EXTS) {
    const c = base + e;
    if (existsSync(c)) return c;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 1. The project's tsconfig alias, which node knows nothing about.
    if (specifier.startsWith('@/')) {
      const hit = probe(path.join(SRC, specifier.slice(2)));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      throw new Error(
        `Could not resolve "${specifier}" under ${SRC}. The hook in ` +
        'scripts/seed-technical-library.mjs maps @/x to src/x; if the project ' +
        'changes that mapping, change it here too.'
      );
    }

    // 2. EXTENSIONLESS RELATIVE IMPORTS. src/db/schema.ts writes
    // `export * from './geography.schema'` — valid TypeScript, and not
    // resolvable by node's ESM resolver, which requires the extension. Vite
    // and vitest add it; node does not, so this does.
    //
    // Deliberately a FALLBACK rather than a first attempt: node's own resolver
    // handles node_modules, subpath exports and everything else correctly, and
    // second-guessing it is how a loader breaks a package it never heard of.
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw err;
      if (!context?.parentURL?.startsWith('file:')) throw err;
      const parentDir = path.dirname(new URL(context.parentURL).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      const hit = probe(path.resolve(parentDir, specifier));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      throw err;
    }
  },
});

// ── Arguments ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const asJson = args.includes('--json');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    'DATABASE_URL is not set. Refusing to guess a target database.\n' +
    'For a local database: npm run dev:db (in another terminal), then set DATABASE_URL to the URL it prints.'
  );
  process.exit(1);
}

// ── Connect ────────────────────────────────────────────────────────────────

const postgres = (await import('postgres')).default;
const { drizzle } = await import('drizzle-orm/postgres-js');
const { sql: raw } = await import('drizzle-orm');
const schema = await import('../src/db/schema.ts');

// ── TLS ────────────────────────────────────────────────────────────────────
//
// THIS SCRIPT USED TO PASS NO `ssl` OPTION, and the comment below it claimed it
// used "the same settings the application uses". It did not. postgres.js ships
// `ssl: false`, so omitting the option was a decision to open this connection
// IN PLAINTEXT across the open internet — and to send the whole seeded library
// along it. It hides perfectly, because it works: a pooler accepts an
// unencrypted session without complaint and nothing here ever said how the
// bytes travelled.
//
// The rules live in scripts/db-tls.mjs — ONE definition, shared by every runner
// in this directory. They were briefly copied into each file, which is not three
// times the safety but three places for one copy to quietly stop matching.
const { tlsFor } = await import('./db-tls.mjs');

// prepare:false is what keeps this working through a transaction-mode pooler,
// which is the same reason src/db/index.ts sets it.
const client = postgres(url, {
  max: 1,
  prepare: false,
  connect_timeout: 15,
  idle_timeout: 20,
  ...tlsFor(url),
});
const db = drizzle(client, { schema });

async function count(table) {
  try {
    const r = await db.execute(raw`select count(*)::int as n from ${raw.identifier(table)}`);
    return Number(r?.[0]?.n ?? r?.rows?.[0]?.n ?? 0);
  } catch {
    return null; // table absent
  }
}

const TABLES = [
  'technical_sources', 'technical_citations', 'kata', 'techniques',
  'kumite_forms', 'technique_kata_appearances', 'technical_terms',
  'technical_term_aliases', 'media_assets', 'media_technical_links',
  'reference_curricula', 'reference_curriculum_items',
  'sport_kumite_rulesets', 'sport_kumite_provisions',
];

async function snapshot() {
  const out = {};
  for (const t of TABLES) out[t] = await count(t);
  return out;
}

try {
  // ── Refuse an unmigrated database ────────────────────────────────────────
  const ledger = await count('_mmakf_migrations');
  if (ledger === null) {
    console.error(
      'This database has no _mmakf_migrations table, so no migration has ever been applied to it.\n' +
      'Run `npm run db:migrate` first. Seeding an empty schema only produces driver errors.'
    );
    process.exit(1);
  }
  if ((await count('technical_sources')) === null) {
    console.error(
      'The technical library tables are absent — migration 0031_technical_library has not been applied.\n' +
      'Run `npm run db:migrate` first.'
    );
    process.exit(1);
  }

  const before = await snapshot();

  if (statusOnly) {
    if (asJson) {
      console.log(JSON.stringify({ migrationsApplied: ledger, tables: before }, null, 2));
    } else {
      console.log(`Technical library — current contents (${ledger} migrations applied)\n`);
      for (const [t, n] of Object.entries(before)) {
        console.log(`  ${t.padEnd(30)} ${n === null ? 'ABSENT' : n}`);
      }
      const empty = Object.entries(before).filter(([, n]) => n === 0).map(([t]) => t);
      console.log(
        empty.length
          ? `\n${empty.length} of ${TABLES.length} tables are empty. Run \`npm run library:seed\` to populate them.`
          : '\nEvery table has rows.'
      );
    }
    await client.end({ timeout: 5 });
    process.exit(0);
  }

  // ── Seed ─────────────────────────────────────────────────────────────────
  const { seedTechnicalLibrary } = await import('../src/db/library-seed.ts');

  console.log('Seeding the technical library. This is idempotent — re-running it updates rather than duplicates.\n');
  const report = await seedTechnicalLibrary(db);
  const after = await snapshot();

  if (asJson) {
    console.log(JSON.stringify({ report, before, after }, null, 2));
  } else {
    console.log('Seeded:');
    for (const [k, v] of Object.entries(report)) {
      if (k === 'notes' || Array.isArray(v)) continue;
      console.log(`  ${k.padEnd(24)} ${v}`);
    }
    console.log('\nRow counts:');
    for (const t of TABLES) {
      const b = before[t];
      const a = after[t];
      const delta = b === null || a === null ? '' : a - b === 0 ? '' : `  (+${a - b})`;
      console.log(`  ${t.padEnd(30)} ${a === null ? 'ABSENT' : a}${delta}`);
    }

    // Notes are the honest part of the report — a source that could not be
    // verified, a corpus determination that was unavailable. Printed last so
    // they are the thing left on screen.
    const notes = [
      ...(report.notes ?? []),
      ...(report.disputed?.length ? [`Disputed corpus facts recorded: ${report.disputed.join(', ')}`] : []),
    ];
    if (notes.length) {
      console.log('\nNotes:');
      for (const n of notes) console.log(`  · ${n}`);
    }

    console.log('\nNothing here is published. Every imported classification lands in the review');
    console.log('queue at /admin/technical-library for a human to decide. See docs/technical/TECHNICAL-REVIEW.md.');
  }

  await client.end({ timeout: 5 });
  process.exit(0);
} catch (err) {
  console.error(`\nSeeding failed: ${err?.message ?? err}`);
  if (err?.stack) console.error(err.stack.split('\n').slice(1, 6).join('\n'));
  await client.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
