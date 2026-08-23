// The build mutex itself. One `astro build` at a time against this checkout.
//
// The reasoning lives in scripts/build-lock.mjs; this file is the mechanism,
// factored out so THREE callers share one implementation and cannot drift:
//
//   · scripts/build-lock.mjs      — npm `prebuild`
//   · scripts/build-unlock.mjs    — npm `postbuild`
//   · the integration in astro.config.mjs
//
// THE INTEGRATION IS THE ONE THAT MATTERS, and the npm hooks are belt to its
// braces. `npx astro build` does not run npm lifecycle scripts, so a lock wired
// only into `prebuild` is bypassed entirely by the exact invocation that was
// causing the collisions here — five simultaneous `npx astro build` processes.
// An integration hook runs for every build however it was started.

import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

export const LOCK_DIR = path.resolve(process.cwd(), '.build-lock');
const OWNER_FILE = path.join(LOCK_DIR, 'owner.json');

/** How long a lock with no readable owner file is left alone (mid-acquire). */
const OWNERLESS_GRACE_MS = 10_000;
/** A held lock older than this is presumed abandoned even if its pid resolves. */
const STALE_AFTER_MS = 20 * 60_000;
/** How long to wait for a turn before refusing, loudly and by name. */
const ACQUIRE_TIMEOUT_MS = 15 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: gone. EPERM: exists but owned by another user — still running.
    return err?.code === 'EPERM';
  }
}

function readOwner() {
  try {
    return JSON.parse(readFileSync(OWNER_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function breakIfStale() {
  if (!existsSync(LOCK_DIR)) return;

  const owner = readOwner();

  if (!owner) {
    // Ownerless: either debris, or somebody in the microseconds between mkdir
    // and writing the owner file. tests/helpers/astro-dev.ts learned the hard
    // way that deleting the second case destroys a lock that was about to
    // succeed, so age decides.
    let age = Infinity;
    try { age = Date.now() - statSync(LOCK_DIR).mtimeMs; } catch { return; }
    if (age < OWNERLESS_GRACE_MS) return;
    try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* lost the race */ }
    return;
  }

  const pid = Number(owner.pid) || 0;
  let heldFor = Infinity;
  try { heldFor = Date.now() - statSync(OWNER_FILE).mtimeMs; } catch { /* vanished */ }

  if (pid === 0 || !alive(pid) || heldFor > STALE_AFTER_MS) {
    try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* lost the race */ }
  }
}

/**
 * Take the lock, waiting for a turn.
 *
 * @param {number} pid the process to record as owner — the one that lives for
 *   the whole build. From an npm hook that is process.ppid (the hook itself is a
 *   short-lived child); from inside astro it is process.pid.
 * @param {string} label what to call this build in messages.
 * @returns {Promise<boolean>} true if held, false if the wait ran out.
 */
export async function acquire(pid, label = 'build') {
  const until = Date.now() + ACQUIRE_TIMEOUT_MS;
  let announced = false;

  for (;;) {
    try {
      // Atomic: creates, or throws EEXIST. No check-then-act window.
      mkdirSync(LOCK_DIR);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      breakIfStale();

      if (Date.now() > until) {
        const owner = readOwner();
        console.error(
          `\n[build-lock] Waited ${Math.round(ACQUIRE_TIMEOUT_MS / 60_000)} minutes for the build ` +
          `lock and never got it.\n` +
          `Holder: ${owner ? `pid ${owner.pid}, since ${owner.at}` : 'unknown'}\n\n` +
          `Another build is running against this checkout. If none is, delete ${LOCK_DIR}.\n`
        );
        return false;
      }

      if (!announced) {
        const owner = readOwner();
        console.log(
          `[build-lock] another build is running${owner ? ` (pid ${owner.pid})` : ''} — ` +
          `waiting for it to finish.`
        );
        announced = true;
      }

      // Jittered, so two builds released at the same instant do not retry in step.
      await sleep(400 + Math.floor(Math.random() * 400));
      continue;
    }

    // Ours. Claim it by name. A failure here is not fatal — another process may
    // have broken the lock in the window before the owner file appeared, and
    // going round again is the right answer, not failing the build.
    try {
      writeFileSync(
        OWNER_FILE,
        JSON.stringify({ pid, label, at: new Date().toISOString(), cwd: process.cwd() }, null, 2)
      );
    } catch {
      try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* fine */ }
      continue;
    }

    if (announced) console.log('[build-lock] acquired.');
    return true;
  }
}

/**
 * Release the lock, but ONLY if this process still holds it.
 *
 * If the owner file names somebody else, this build lost the lock to a
 * staleness break mid-flight and another build now holds it. Removing the
 * directory there would hand a second build the same output tree — exactly the
 * corruption the lock exists to prevent.
 *
 * @param {number} pid the pid recorded at acquire time.
 */
export function release(pid) {
  if (!existsSync(LOCK_DIR)) return;

  const owner = readOwner();
  if (!owner) return;   // mid-acquire by somebody else; its own grace timer applies

  if (Number(owner.pid) !== pid) {
    console.warn(
      `[build-lock] not releasing: held by pid ${owner.pid}, not this build (${pid}).`
    );
    return;
  }

  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[build-lock] could not release (${err?.code ?? err}); it will be broken as stale.`);
  }
}

/**
 * The Astro integration. This is the enforcement point: it runs for `astro
 * build`, `npx astro build` and `npm run build` alike.
 *
 * It deliberately does nothing on `astro dev` — a dev server is not writing
 * dist/ or .vercel/output, and making one wait behind a build would be a new
 * way to hang. tests/helpers/astro-dev.ts holds its own lock for dev servers.
 */
export function buildLock() {
  let held = false;

  // RELEASED ON PROCESS EXIT, NOT IN astro:build:done, and the difference is
  // the whole point of holding a lock at all.
  //
  // `astro:build:done` fires once per integration in registration order, and
  // the Vercel adapter is an integration too — it does its work (copying the
  // function bundle, `mkdir .vercel/output/server`) in its own copy of that
  // hook. Releasing in mine would therefore free the lock at an unpredictable
  // point relative to the adapter's writes, and .vercel/output is precisely
  // what two builds were colliding over. An exit handler runs after every hook
  // of every integration, so the lock spans the entire build whatever order
  // Astro chooses.
  //
  // It also covers the paths a hook cannot: a build that throws, and one killed
  // with Ctrl-C. Neither reaches astro:build:done; both reach 'exit'.
  const releaseOnce = () => {
    if (!held) return;
    held = false;
    release(process.pid);
  };
  process.once('exit', releaseOnce);
  process.once('SIGINT', () => { releaseOnce(); process.exit(130); });
  process.once('SIGTERM', () => { releaseOnce(); process.exit(143); });

  return {
    name: 'mmakf:build-lock',
    hooks: {
      'astro:build:start': async () => {
        held = await acquire(process.pid, 'astro build');
        if (!held) {
          throw new Error(
            'Could not take the build lock — another build is running against this checkout.'
          );
        }
      },
    },
  };
}
