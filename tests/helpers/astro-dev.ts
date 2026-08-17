/**
 * ONE `astro dev` AT A TIME, ACROSS EVERY VITEST WORKER.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS EXISTS FOR, AND WHY THE PREVIOUS FIX COULD NOT HAVE WORKED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three suites boot a real `astro dev` — routes-live, seo-live and
 * live-error-disclosure. Run concurrently, one of them dies with:
 *
 *   EPERM: operation not permitted, rename
 *     '.astro/data-store.json.tmp' -> '.astro/data-store.json'
 *
 * Astro writes its content store by writing a temp file and renaming it over
 * the target. Two servers doing that in one directory race, and on Windows the
 * loser gets EPERM rather than ENOENT. The suite that lost reports "astro dev
 * exited" — naming neither the other suite nor the file — and, because a failed
 * beforeAll makes vitest SKIP the file's tests rather than fail them, the run
 * reports something far worse than a failure:
 *
 *   Test Files  1 failed | 96 passed
 *   Tests       3357 passed | 144 skipped
 *
 * 144 tests skipped, on a tree where every one of them passes when the file is
 * run alone. A green-looking run that verified nothing.
 *
 * THE PREVIOUS FIX WAS `cacheDir`, AND IT NEVER APPLIED IN DEV. astro.config.mjs
 * sets `cacheDir` from ASTRO_CACHE_DIR and each suite passes a different value,
 * on the stated theory that this gives each server its own directory. Read
 * astro's own resolution:
 *
 *   node_modules/astro/dist/content/content-layer.js:338
 *     new URL(DATA_STORE_FILE, isDev ? settings.dotAstroDir : settings.config.cacheDir)
 *
 *   node_modules/astro/dist/core/config/settings.js:21
 *     const dotAstroDir = new URL(".astro/", config.root);
 *
 * In DEV the store goes to `<root>/.astro/`, and `cacheDir` is not consulted at
 * all. `cacheDir` isolates `astro build`. It has never isolated `astro dev`, so
 * three servers have always shared one file and the race was always going to
 * happen — it simply needed enough parallelism to be observed, which is why it
 * moved between suites whenever the file count changed the scheduling.
 *
 * `--root` cannot be varied instead: it is what resolves src/, the config, and
 * every import in the project.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SO: A LOCK, NOT A WORKAROUND
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The servers cannot be isolated, so they take turns. `mkdir` is atomic on
 * every filesystem this project runs on — it either creates the directory or
 * fails with EEXIST, with no window in between — which makes it a correct
 * mutex across vitest's worker PROCESSES, where an in-memory one would not be.
 *
 * It costs wall-clock and buys determinism, and this project has already
 * written down which of those it values: "A test run that cannot finish is a
 * test run nobody performs" (vitest.config.ts).
 *
 * STALE LOCKS ARE RECLAIMED. A worker killed mid-run would otherwise wedge
 * every later run on the machine, and a lock that needs manual clearing is a
 * lock somebody deletes permanently. The owner's pid is recorded and checked
 * for liveness; a lock whose owner is gone, or which is older than the ceiling
 * below, is broken and taken.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const LOCK_DIR = path.resolve(process.cwd(), '.astro-dev-lock');
const OWNER_FILE = path.join(LOCK_DIR, 'owner.json');

/**
 * How long a lock may be held before another worker assumes its owner died.
 *
 * Generously above the slowest legitimate hold: `astro dev` boot plus a suite's
 * requests. Too low and a healthy slow suite gets its server stolen mid-run,
 * which is a far more confusing failure than waiting.
 */
const STALE_AFTER_MS = 6 * 60_000;

/** Total time a worker will wait for its turn before giving up loudly. */
const ACQUIRE_TIMEOUT_MS = 8 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything. ESRCH means no such process.
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/**
 * How long a lock directory with no readable owner file is left alone.
 *
 * THE BUG THIS CONSTANT EXISTS FOR. Acquiring is two steps — `mkdirSync` then
 * `writeFileSync(owner.json)` — and between them the lock exists with no owner
 * record. The first version of breakIfStale() treated exactly that state as
 * "debris from a crash between mkdir and write" and deleted the directory, so a
 * second worker arriving in that window destroyed the lock of a worker that was
 * about to succeed. The victim's writeFileSync then died:
 *
 *   ENOENT: no such file or directory, open '.astro-dev-lock\owner.json'
 *
 * and vitest reported its whole file as SKIPPED — the same misleading symptom
 * the lock was introduced to remove, now caused by the lock itself. It
 * reproduced in roughly one full run in two.
 *
 * The reasoning was right and the conclusion was wrong: an ownerless lock IS
 * usually debris, but it is also the normal state for a few microseconds. So it
 * is given a grace period measured from the DIRECTORY's own mtime — long enough
 * that a healthy creator has certainly written its owner file, short enough
 * that genuine debris clears without human help.
 */
const OWNERLESS_GRACE_MS = 15_000;

function breakIfStale(): void {
  if (!existsSync(LOCK_DIR)) return;

  let owner: { pid?: number } | null = null;
  try {
    owner = JSON.parse(readFileSync(OWNER_FILE, 'utf8'));
  } catch {
    owner = null;
  }

  if (!owner) {
    // No owner record yet. Either a creator mid-acquire, or debris. The
    // directory's age is what separates them.
    let age = Infinity;
    try { age = Date.now() - statSync(LOCK_DIR).mtimeMs; } catch { return; }
    if (age < OWNERLESS_GRACE_MS) return; // somebody is mid-acquire; leave it
    try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* lost the race to break it */ }
    return;
  }

  const ownerPid = Number(owner.pid) || 0;
  let heldFor = Infinity;
  try { heldFor = Date.now() - statSync(OWNER_FILE).mtimeMs; } catch { /* vanished under us */ }

  if (ownerPid === 0 || !alive(ownerPid) || heldFor > STALE_AFTER_MS) {
    try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* lost the race to break it */ }
  }
}

async function acquire(label: string): Promise<void> {
  const until = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      // Atomic. Creates, or throws EEXIST. There is no check-then-act window.
      mkdirSync(LOCK_DIR);
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      breakIfStale();
      if (Date.now() > until) {
        let owner = 'unknown';
        try { owner = readFileSync(OWNER_FILE, 'utf8'); } catch { /* gone between the check and here */ }
        throw new Error(
          `Waited ${Math.round(ACQUIRE_TIMEOUT_MS / 1000)}s for the astro dev lock and never got it. ` +
          `Current owner: ${owner}. If no test run is in progress, delete ${LOCK_DIR}.`
        );
      }
      await sleep(250 + Math.floor(Math.random() * 250));
      continue;
    }

    // The directory is ours. Claim it by name.
    //
    // A failure HERE is not fatal and must not be treated as one: another worker
    // may have broken the lock in the window before the owner file appeared, in
    // which case the right response is to go round again rather than to fail a
    // whole test file. The grace period in breakIfStale() makes this rare; this
    // makes it harmless.
    try {
      writeFileSync(OWNER_FILE, JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() }));
      return;
    } catch {
      try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* already gone */ }
      await sleep(100 + Math.floor(Math.random() * 200));
    }
  }
}

function release(): void {
  try {
    // Only release a lock this process actually owns. A worker that had its
    // stale lock broken must not then delete the lock of whoever took it.
    const owner = JSON.parse(readFileSync(OWNER_FILE, 'utf8'));
    if (Number(owner?.pid) !== process.pid) return;
  } catch {
    // Unreadable owner file: fall through and clear the directory anyway,
    // because leaving an unownable lock behind wedges every later run.
  }
  try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* already gone */ }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface DevServer {
  /** `http://127.0.0.1:<port>` — no trailing slash. */
  base: string;
  /** Everything the server has written to stdout and stderr so far. */
  log: () => string;
  /**
   * Kill the server, WAIT FOR IT TO ACTUALLY EXIT, then release the lock.
   * Safe to call twice. Await it — see the note on release ordering below.
   */
  stop: () => Promise<void>;
}

export interface StartOptions {
  /** Which suite is asking. Recorded in the lock, so a wedge names its cause. */
  label: string;
  /**
   * A cheap path to poll as a fallback readiness signal. The ready LINE is the
   * primary signal; this only matters if a future astro stops printing it.
   */
  probePath?: string;
  /** Extra environment for the child. */
  env?: Record<string, string>;
  /** How long to wait for the server to answer. */
  readyTimeoutMs?: number;
}

/**
 * Boot `astro dev`, exclusively.
 *
 * Readiness is decided by THREE signals, in this order, and the order is the
 * point:
 *
 *  1. THE CHILD EXITED — fail immediately with its log. Polling a dead process
 *     for ninety seconds buries the real error, which is the log we are holding.
 *  2. THE SERVER'S OWN READY LINE — `astro dev` prints "ready in <n> ms" when it
 *     is listening. That is the server saying so, and it costs no compile.
 *  3. A BOUNDED FETCH — the fallback. Generously bounded, because the FIRST
 *     request compiles the page and everything it imports; a four-second
 *     timeout aborted its own in-flight compile every time and could spend the
 *     whole window never letting one finish.
 */
export async function startAstroDev(opts: StartOptions): Promise<DevServer> {
  await acquire(opts.label);

  let proc: ChildProcess | null = null;
  let log = '';
  let stopped = false;

  /**
   * KILLING IS NOT THE SAME AS HAVING EXITED, and the difference is a race.
   *
   * The first version released the lock immediately after `proc.kill()`. A
   * killed astro dev can still have an in-flight `writeToDisk` on
   * `.astro/data-store.json` — the very file all three servers share — so the
   * next suite could acquire the lock, start its own server, and collide with
   * the dying one's rename. That produced exactly one unexplained
   * `astro dev never came up` in a full run, and passed when run alone: the
   * signature of a race, not of a broken suite.
   *
   * So the lock is held until the process has genuinely exited. Bounded, because
   * a child that refuses to die must not wedge every later suite — after the
   * grace period it is escalated and the lock released regardless, which is the
   * lesser of the two failures.
   */
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const child = proc;
    try {
      if (child && child.exitCode === null) {
        const exited = new Promise<void>((resolve) => {
          const done = () => resolve();
          child.once('exit', done);
          child.once('close', done);
        });
        child.kill();
        await Promise.race([exited, sleep(8_000)]);
        if (child.exitCode === null) {
          // Still alive after the grace period. SIGKILL on POSIX; on Windows
          // node's kill() is already terminal, so this is belt and braces.
          try { child.kill('SIGKILL'); } catch { /* platform may refuse */ }
          await Promise.race([exited, sleep(2_000)]);
        }
      }
    } catch { /* already gone */ }
    release();
  };

  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;

    proc = spawn(
      process.execPath,
      ['node_modules/astro/astro.js', 'dev', '--port', String(port), '--host', '127.0.0.1'],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(opts.env ?? {}) },
      }
    );
    proc.stdout?.on('data', (d) => (log += d));
    proc.stderr?.on('data', (d) => (log += d));

    const READY_LINE = /ready in\s+\d+/i;
    const until = Date.now() + (opts.readyTimeoutMs ?? 120_000);
    const probe = opts.probePath ?? '/';

    for (;;) {
      if (proc.exitCode !== null) {
        throw new Error(`astro dev exited with ${proc.exitCode} before serving:\n${log.slice(-3000)}`);
      }
      if (READY_LINE.test(log)) break;
      try {
        const r = await fetch(base + probe, { signal: AbortSignal.timeout(30_000) });
        if (r.status) { await r.text(); break; }
      } catch { /* not listening yet */ }
      if (Date.now() > until) {
        throw new Error(`astro dev never came up on ${base}:\n${log.slice(-3000)}`);
      }
      await sleep(400);
    }

    return { base, log: () => log, stop };
  } catch (err) {
    // The lock must not survive a boot failure, or the next suite waits eight
    // minutes for a server that was never going to start. Awaited for the same
    // reason the callers await it: a half-dead child still holds the data store.
    await stop();
    throw err;
  }
}
