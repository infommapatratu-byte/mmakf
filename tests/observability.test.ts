// Observability.
//
// The invariants: a log line NEVER carries a secret or personal data, and a
// background job ALWAYS reports whichever way it ends.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  redact, log, runJob, timed, probe, probeStatus, overallStatus, correlationId,
} from '../src/lib/observability';

let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((s: any) => { out.push(String(s)); });
  vi.spyOn(console, 'error').mockImplementation((s: any) => { err.push(String(s)); });
  process.env.LOG_LEVEL = 'debug';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOG_LEVEL;
});

describe('redaction — the thing that must never fail', () => {
  it('removes every shape of secret, matched as a substring', () => {
    const r = redact({
      password: 'hunter2',
      passwordHash: 'scrypt$32768$...',
      RAZORPAY_KEY_SECRET: 'rzp_secret',
      refreshTokenEncrypted: 'v1.abc.def.ghi',
      authorization: 'Bearer eyJ...',
      'x-razorpay-signature': 'deadbeef',
      cookie: 'mmakf_admin=...',
      clientSecret: 'google-secret',
      apiKey: 'AIza...',
    }) as Record<string, string>;

    for (const v of Object.values(r)) expect(v).toBe('[redacted:secret]');
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(JSON.stringify(r)).not.toContain('rzp_secret');
    expect(JSON.stringify(r)).not.toContain('eyJ');
  });

  it('removes personal data', () => {
    const r = redact({
      email: 'member@example.in',
      phone: '9876543210',
      dob: '2008-04-15',
      fullName: 'Ravi Kumar',
      guardianPhone: '9876543211',
      medicalNotes: 'asthma',
    }) as Record<string, string>;

    for (const v of Object.values(r)) expect(v).toBe('[redacted:personal]');
    expect(JSON.stringify(r)).not.toContain('member@example.in');
    expect(JSON.stringify(r)).not.toContain('asthma');
  });

  it('KEEPS the federation id, which is what makes a line traceable', () => {
    const r = redact({ federationId: 'MMAKF-MEM-2026-000123', orderNo: 'MMAKF-ORD-2026-000001' }) as any;
    expect(r.federationId).toBe('MMAKF-MEM-2026-000123');
    expect(r.orderNo).toBe('MMAKF-ORD-2026-000001');
  });

  it('redacts inside nested objects and arrays', () => {
    const r = redact({
      user: { profile: { email: 'a@b.in', password: 'x' } },
      items: [{ token: 'secret1' }, { token: 'secret2' }],
    });
    const dumped = JSON.stringify(r);
    expect(dumped).not.toContain('a@b.in');
    expect(dumped).not.toContain('secret1');
    expect(dumped).not.toContain('secret2');
  });

  it('bounds depth, breadth and string length so a log line cannot become a dump', () => {
    let deep: any = { value: 'bottom' };
    for (let i = 0; i < 10; i++) deep = { nested: deep };
    expect(JSON.stringify(redact(deep))).toContain('[truncated:depth]');

    const wide = redact(Array.from({ length: 100 }, (_, i) => i)) as any[];
    expect(wide.length).toBe(21);
    expect(wide[20]).toBe('[+80 more]');

    expect(String(redact('x'.repeat(2000)))).toMatch(/\[\+1500 chars\]$/);
  });

  it('serialises an Error without dumping the whole stack', () => {
    const r = redact(new Error('boom')) as any;
    expect(r.name).toBe('Error');
    expect(r.message).toBe('boom');
    expect(r.stack.split('\n').length).toBeLessThanOrEqual(5);
  });
});

describe('log levels', () => {
  it('honours LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'warn';
    log.debug('quiet'); log.info('also quiet'); log.warn('loud');
    expect(out.length).toBe(0);
    expect(err.length).toBe(1);
  });

  it('sends warn and error to stderr so they are separable at the aggregator', () => {
    log.info('a'); log.warn('b'); log.error('c');
    expect(out.length).toBe(1);
    expect(err.length).toBe(2);
  });

  it('emits structured JSON with a timestamp and level', () => {
    log.info('something happened', { job: 'test', correlationId: 'abc' });
    const line = JSON.parse(out[0]);
    expect(line.level).toBe('info');
    expect(line.msg).toBe('something happened');
    expect(line.job).toBe('test');
    expect(Date.parse(line.ts)).not.toBeNaN();
  });

  it('redacts context passed to a log call', () => {
    log.info('sign-in', { federationId: 'MMAKF-MEM-2026-1', password: 'hunter2', email: 'a@b.in' });
    expect(out[0]).not.toContain('hunter2');
    expect(out[0]).not.toContain('a@b.in');
    expect(out[0]).toContain('MMAKF-MEM-2026-1');
  });
});

describe('job instrumentation', () => {
  it('reports BOTH start and completion — silence must not look like success', () => {
    // A job that succeeds silently and a job that never ran are identical in a
    // log that only records failures.
    return runJob('reconcile', async () => ({ processed: 3 })).then((r) => {
      expect(r.ok).toBe(true);
      expect(r.result).toEqual({ processed: 3 });
      const events = out.map((l) => JSON.parse(l).msg);
      expect(events).toContain('job.start');
      expect(events).toContain('job.complete');
    });
  });

  it('reports a failure and does NOT re-throw', async () => {
    // Re-throwing would let a scheduler retry a job whose side effects already
    // happened.
    const r = await runJob('failing', async () => { throw new Error('database unreachable'); });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/database unreachable/);
    expect(JSON.parse(err[0]).msg).toBe('job.failed');
  });

  it('records duration on both paths', async () => {
    const ok = await runJob('quick', async () => 'done');
    const bad = await runJob('bad', async () => { throw new Error('x'); });
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);
    expect(bad.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ties every line of one run together with a correlation id', async () => {
    const r = await runJob('correlated', async () => 'ok');
    const ids = out.map((l) => JSON.parse(l).correlationId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(r.correlationId);
  });

  it('redacts a job result before logging it', async () => {
    await runJob('leaky', async () => ({ email: 'a@b.in', count: 1 }));
    expect(out.join()).not.toContain('a@b.in');
  });

  it('generates distinct correlation ids', () => {
    expect(new Set(Array.from({ length: 200 }, () => correlationId())).size).toBe(200);
  });
});

describe('timed operations', () => {
  it('warns when a budget is exceeded but still returns the value', async () => {
    const value = await timed('slow-op', 0, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'result';
    });
    expect(value).toBe('result');
    expect(JSON.parse(err[0]).msg).toBe('operation.slow');
  });

  it('does not warn inside budget', async () => {
    await timed('fast-op', 10_000, async () => 'x');
    expect(err.length).toBe(0);
  });

  it('still records the timing when the operation throws', async () => {
    // Asserted across BOTH streams and on the operation name, not on the warn
    // stream alone: whether a throw lands over or under its budget is a race,
    // and the invariant under test is that the finally block ran at all.
    await expect(
      timed('throwing-op', 0, async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');

    const emitted = [...out, ...err].join(' ');
    expect(emitted).toContain('throwing-op');
    expect(emitted).toMatch(/durationMs/);
  });
});

describe('health probes', () => {
  it('treats not-configured as its own state, never as down', async () => {
    // A database that was never configured is not an outage, and reporting it as
    // one trains an operator to ignore the alert.
    const p = await probe('database', false, async () => true);
    expect(p.status).toBe('not_configured');
    expect(overallStatus([p])).toBe('ok');
  });

  it('reports ok for a fast healthy dependency', async () => {
    const p = await probe('redis', true, async () => true, 3000);
    expect(p.status).toBe('ok');
  });

  it('reports down when the check returns false', async () => {
    expect((await probe('redis', true, async () => false)).status).toBe('down');
  });

  it('TIMES OUT rather than hanging the health endpoint', async () => {
    // A probe without a timeout is how a health check becomes the thing that
    // takes the site down.
    const started = Date.now();
    const p = await probe('hung', true, () => new Promise(() => {}), 50);
    expect(p.status).toBe('down');
    expect(p.detail).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports down when the check throws', async () => {
    const p = await probe('throwing', true, async () => { throw new Error('ECONNREFUSED'); });
    expect(p.status).toBe('down');
    expect(p.detail).toMatch(/ECONNREFUSED/);
  });

  it('classifies a reachable but slow dependency as degraded, without a stopwatch', () => {
    // This test used to sleep 60ms against a 100ms timeout, which measured the
    // scheduler: a loaded machine that overshot to 110ms reported `down` and
    // failed a correct implementation. The threshold is what matters.
    expect(probeStatus(true, 0, 100)).toBe('ok');
    expect(probeStatus(true, 50, 100)).toBe('ok');          // exactly half is not slow
    expect(probeStatus(true, 51, 100)).toBe('degraded');
    expect(probeStatus(true, 99, 100)).toBe('degraded');
    // A probe that completed but reported failure is down however fast it was.
    expect(probeStatus(false, 1, 100)).toBe('down');
  });

  it('reports degraded end to end, with an injected clock rather than a sleep', async () => {
    let t = 1_000;
    const p = await probe('slow', true, async () => { t += 60; return true; }, 100, () => t);
    expect(p.status).toBe('degraded');
    expect(p.durationMs).toBe(60);
    expect(p.detail).toMatch(/Responded in 60ms/);
  });

  it('still says nothing about duration when a probe is healthy', async () => {
    let t = 1_000;
    const p = await probe('fast', true, async () => { t += 5; return true; }, 100, () => t);
    expect(p.status).toBe('ok');
    expect(p.detail).toBeUndefined();
  });

  it('rolls up to the worst real status', () => {
    expect(overallStatus([{ name: 'a', status: 'ok' }, { name: 'b', status: 'not_configured' }])).toBe('ok');
    expect(overallStatus([{ name: 'a', status: 'ok' }, { name: 'b', status: 'degraded' }])).toBe('degraded');
    expect(overallStatus([{ name: 'a', status: 'degraded' }, { name: 'b', status: 'down' }])).toBe('down');
  });
});
