#!/usr/bin/env node
// Serves an in-process PGlite database over the real Postgres wire protocol.
//
// This exists so scripts/migrate.mjs can be verified EXACTLY as it runs against
// production — same driver, same TCP socket, same transactions — without
// depending on Docker or an installed Postgres. Used by scripts/verify-migrate.mjs.
//
//   node scripts/pg-testserver.mjs [port]

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.argv[2] || 5433);
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });

await server.start();
console.log(`ready on 127.0.0.1:${port}`);

const shutdown = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
