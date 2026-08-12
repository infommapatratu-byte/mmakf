#!/usr/bin/env node
// Local development database.
//
// Runs a real Postgres (PGlite behind the Postgres wire protocol) on 127.0.0.1
// so the whole federation system can be BUILT AND TESTED locally before any
// hosted database exists. Nothing in the app knows the difference: it speaks the
// same protocol to the same driver, so code proven here works unchanged against
// Supabase once DATABASE_URL points at it.
//
//   npm run dev:db          start on 127.0.0.1:5433, persisting to .pgdata/
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres"
//
// Data persists between restarts in .pgdata/ (gitignored) so local records
// survive, which is what makes end-to-end testing meaningful.

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { mkdirSync } from 'node:fs';

const port = Number(process.env.DEV_DB_PORT || 5433);
const dir = process.env.DEV_DB_DIR || '.pgdata';

mkdirSync(dir, { recursive: true });

const db = await PGlite.create({ dataDir: dir });
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();

console.log(`Local federation database ready.

  DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${port}/postgres"

  Apply migrations:  DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${port}/postgres" npm run db:migrate
  Data directory:    ${dir}/  (persists between restarts, gitignored)

Ctrl-C to stop.`);

const shutdown = async () => {
  console.log('\nstopping...');
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
