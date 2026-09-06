// Web push has a surface, and the surface stays wired.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT CLASS THIS GUARDS, WHICH THIS PROJECT HAS SHIPPED REPEATEDLY
// ─────────────────────────────────────────────────────────────────────────────
//
// src/lib/push.ts was 1,386 lines of correct, tested RFC 8291 and RFC 8292 with
// TWO importers: pushStatus() on /admin/notifications and deliverQueuedPush()
// on the reconcile cron. subscribe(), unsubscribe(), myDevices(),
// myPreferences(), setPreference() and sendTestToSelf() were written, covered
// by tests/push.test.ts, and called by NOTHING a person could reach. The
// federation had a push transport that could deliver to nobody.
//
// It is the same shape as queue item 0d (createPersonForSource with no caller),
// item 9 (seedTechnicalLibrary run only by vitest) and item 4 itself. In every
// case the unit tests passed, because a unit test calls the function directly —
// which is exactly the thing the product could not do.
//
// So this file asserts the WIRING rather than the behaviour. tests/push.test.ts
// owns the cryptography and the policy; these assertions own the three legs a
// capability needs: the code exists, something calls it, and a human can reach
// it. Each one below failed before the surface was built.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

const API_ROUTE = 'src/pages/api/push/[...action].ts';
const PAGE = 'src/pages/my/devices.astro';
const SW = 'public/sw.js';

describe('the service worker can receive a push', () => {
  const sw = read(SW);

  // THE ONE THAT MATTERS MOST. A browser will not keep a subscription alive for
  // a worker that never shows a notification, so without this handler the whole
  // transport is inert even with correct VAPID keys — and nothing errors, which
  // is why it went unnoticed. The worker previously had install/activate/fetch
  // and nothing else.
  it('handles the push event', () => {
    expect(sw).toMatch(/addEventListener\(\s*['"]push['"]/);
  });

  it('handles a click on the notification it showed', () => {
    expect(sw).toMatch(/addEventListener\(\s*['"]notificationclick['"]/);
  });

  // A push service may retire an endpoint. Without this the member's device
  // goes quiet with push_devices still saying `active`.
  it('re-registers when the push service rotates the endpoint', () => {
    expect(sw).toMatch(/addEventListener\(\s*['"]pushsubscriptionchange['"]/);
  });

  // userVisibleOnly is a promise to the browser. A push handler with a path
  // that shows nothing gets "This site has been updated in the background"
  // displayed on the member's behalf, which reads as a bug and teaches them to
  // revoke permission.
  it('always shows a notification, including when the payload is unusable', () => {
    const pushBlock = sw.slice(sw.indexOf("addEventListener('push'"), sw.indexOf("addEventListener('notificationclick'"));
    expect(pushBlock).toContain('showNotification');
    expect(pushBlock).toMatch(/PUSH_FALLBACK/);
  });

  // A push service is not trusted to hand the worker a URL it will open. The
  // guard is EXERCISED rather than pattern-matched: asserting that the source
  // contains a particular regex literal proves the characters are present and
  // nothing whatever about what they do, and it breaks on any reformatting.
  // This lifts the actual expression out of the worker and runs hostile values
  // through it.
  it('only opens a same-origin root-relative path from the payload', () => {
    const found = sw.match(/(\/\^.+?\/)\.test\(parsed\.url\)/);
    expect(found, 'the URL guard in the push handler could not be located').toBeTruthy();
    const guard = new RegExp(found![1].slice(1, -1));

    for (const allowed of ['/my/notifications', '/my', '/grading/results']) {
      expect(guard.test(allowed), `${allowed} should be allowed`).toBe(true);
    }
    for (const hostile of [
      'https://evil.test/steal',   // absolute, another origin
      '//evil.test/steal',         // protocol-relative — the classic miss
      '/\\evil.test/steal',        // backslash form some browsers normalise to //
      'javascript:alert(1)',
      'my/notifications',          // not root-relative
      '',
    ]) {
      expect(guard.test(hostile), `${hostile} should be refused`).toBe(false);
    }
  });
});

describe('there is an HTTP surface for a member to register a device', () => {
  it('the route exists', () => {
    expect(existsSync(API_ROUTE)).toBe(true);
  });

  const route = read(API_ROUTE);

  it('calls the module rather than reimplementing it', () => {
    for (const fn of ['subscribe', 'unsubscribe', 'myDevices', 'myPreferences', 'setPreference', 'sendTestToSelf']) {
      expect(route).toContain(fn);
    }
  });

  it('is rate limited and requires a session for every write', () => {
    expect(route).toContain('rateLimit');
    expect(route).toContain('identify(');
    expect(route).toMatch(/Sign in to change your notification devices/);
  });

  // The VAPID public key is broadcast to every subscriber by design, and a page
  // needs it BEFORE it can decide whether to offer the control at all — so this
  // one read answers without a session. Nothing else here may.
  it('serves the application server key so a page can decide what to render', () => {
    expect(route).toContain('vapidPublicKey');
    expect(route).toContain('pushStatus');
  });

  it('never accepts a user id — every action resolves the subject from the session', () => {
    // A fan-out endpoint that accepts a recipient is a mail-merge pointed at
    // the membership. push.ts is authorised by construction and this route must
    // not undo that by passing an id through.
    expect(route).not.toMatch(/body\s*\.\s*userId/);
    expect(route).not.toMatch(/text\(['"]userId['"]\)/);
  });
});

describe('a member can reach it', () => {
  it('the settings page exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  const page = read(PAGE);

  // The third leg. A page linked from nowhere is a page nobody opens, which is
  // the same outcome as not building it.
  it('is linked from the member area, the inbox and the command palette', () => {
    expect(read('src/pages/my/index.astro')).toContain('/my/devices');
    expect(read('src/pages/my/notifications.astro')).toContain('/my/devices');
    expect(read('src/lib/commands.ts')).toContain("href: '/my/devices'");
  });

  // Not a hand-kept list. A second copy of the topics disagrees with the engine
  // the day one is added, and the member switches something off in a screen
  // that has no effect.
  it('derives its topic list from NOTIFIABLE', () => {
    expect(page).toContain("from '@/lib/notifications'");
    expect(page).toContain('NOTIFIABLE');
  });

  // The house rule: a control that cannot work is ABSENT, not disabled. Without
  // VAPID keys a browser cannot create a subscription at all, so a Register
  // button would teach the member their device was registered when it was not.
  it('withholds the subscribe control when push is not configured', () => {
    expect(page).toContain('vapidPublicKey');
    expect(page).toMatch(/status\.configured/);
    expect(page).toMatch(/not available on this deployment/);
  });

  // Preferences govern in-app and email too, and both work today. Confining
  // them behind the push script would make a working capability depend on an
  // unconfigured one.
  it('saves preferences by posting to itself, so they work without JavaScript', () => {
    expect(page).toContain("Astro.request.method === 'POST'");
    expect(page).toContain('setPreference');
    expect(page).toMatch(/<form method="POST" class="pref"/);
  });

  it('separates the four gates rather than reporting one absence for all of them', () => {
    for (const gate of ['no_database', 'signed_out', 'shared_credential', 'ok']) {
      expect(page).toContain(gate);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('nothing in push.ts is left with no caller outside its tests', () => {
  // The list is EXPLICIT rather than derived from the module's exports, and the
  // distinction is the point: this names the functions that represent something
  // a person can do. A helper with no caller is dead code; a CAPABILITY with no
  // caller is a feature the federation believes it has and does not.
  const CAPABILITIES = [
    'subscribe', 'unsubscribe', 'myDevices',
    'myPreferences', 'setPreference', 'sendTestToSelf',
    'pushStatus', 'vapidPublicKey', 'deliverQueuedPush',
  ];

  const callers = [
    API_ROUTE,
    PAGE,
    'src/pages/admin/notifications.astro',
    'src/pages/api/cron/reconcile.ts',
  ].map(read).join('\n');

  for (const fn of CAPABILITIES) {
    it(`${fn}() is called from a page, a route or the cron`, () => {
      expect(callers).toContain(fn);
    });
  }
});
