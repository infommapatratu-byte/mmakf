// Observability. Q-29.
//
// Before this, a background job could fail silently and stay failed. The
// reconciliation cron, the YouTube poller, the ranking calculation and the
// notification queue all run unattended — and a quiet failure in any of them is
// money taken with nothing issued, live classes that stop appearing, or rankings
// frozen at last month.
//
// TWO THINGS THIS MUST NEVER DO, and both are easy to get wrong:
//
//  1. LOG A SECRET. Logs are the most-copied artefact in any system — pasted
//     into tickets, forwarded to vendors, retained far longer than intended.
//     Every value passed through here is redacted by key name before it is
//     written, and the redaction list is deliberately broad.
//
//  2. LOG PERSONAL DATA. A log line naming a member and their grade is a data
//     export with a timestamp. Identifiers are logged; names, contact details
//     and dates of birth are not.
//
// Structured JSON on stdout, because the deploy target aggregates that. No
// dependency, no agent, no vendor lock-in.

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? '').toLowerCase() as Level;
  return LEVELS[configured] ?? LEVELS.info;
}

// ─── Redaction ──────────────────────────────────────────────────────────────

/**
 * Keys whose values never reach a log, matched case-insensitively as substrings.
 *
 * Substring matching is deliberate: `RAZORPAY_KEY_SECRET`, `refreshTokenEncrypted`
 * and `x-razorpay-signature` must all be caught without enumerating every name a
 * field might have. Over-redacting a log line is free; under-redacting is not.
 */
const SECRET_KEYS = [
  'password', 'passwordhash', 'secret', 'token', 'authorization', 'auth',
  'cookie', 'session', 'apikey', 'api_key', 'key_secret', 'clientsecret',
  'client_secret', 'signature', 'refresh', 'credential', 'private',
];

/**
 * Personal data. Logged as absent rather than as a value.
 *
 * `federationId` is deliberately NOT here — it is a durable public identifier
 * and logging it is what makes a problem traceable to a record without naming a
 * human being.
 */
const PERSONAL_KEYS = [
  'email', 'phone', 'mobile', 'dob', 'dateofbirth', 'address', 'fullname',
  'name', 'guardian', 'emergency', 'medical', 'aadhaar', 'pan',
];

function redactValue(key: string, value: unknown): unknown {
  const k = key.toLowerCase();
  if (SECRET_KEYS.some((s) => k.includes(s))) return '[redacted:secret]';
  if (PERSONAL_KEYS.some((p) => k.includes(p))) return '[redacted:personal]';
  return value;
}

/**
 * Deep-redact an object for logging.
 *
 * Depth-limited and breadth-limited: a log line is a diagnostic, not a database
 * dump, and an unbounded walk over a deeply nested payload is itself a way to
 * take a process down.
 */
export function redact(input: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated:depth]';
  if (input === null || input === undefined) return input;

  if (Array.isArray(input)) {
    if (input.length > 20) return [...input.slice(0, 20).map((v) => redact(v, depth + 1)), `[+${input.length - 20} more]`];
    return input.map((v) => redact(v, depth + 1));
  }

  if (input instanceof Error) {
    return { name: input.name, message: input.message, stack: input.stack?.split('\n').slice(0, 5).join('\n') };
  }

  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const redacted = redactValue(k, v);
      out[k] = redacted === v ? redact(v, depth + 1) : redacted;
    }
    return out;
  }

  if (typeof input === 'string' && input.length > 500) {
    return `${input.slice(0, 500)}…[+${input.length - 500} chars]`;
  }

  return input;
}

// ─── Logging ────────────────────────────────────────────────────────────────

export interface LogContext {
  /** Ties every line from one request or job run together. */
  correlationId?: string;
  job?: string;
  route?: string;
  userId?: number | null;
  /** Public federation identifier. Safe, and what makes a line traceable. */
  federationId?: string;
  durationMs?: number;
  [key: string]: unknown;
}

function emit(level: Level, message: string, context: LogContext = {}) {
  if (LEVELS[level] < threshold()) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(redact(context) as Record<string, unknown>),
  };

  // Warnings and errors go to stderr so they are separable at the aggregator
  // without parsing every line.
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  debug: (msg: string, ctx?: LogContext) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit('error', msg, ctx),
};

export function correlationId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Job instrumentation ────────────────────────────────────────────────────

export interface JobResult<T> {
  ok: boolean;
  job: string;
  correlationId: string;
  durationMs: number;
  result?: T;
  error?: string;
}

/**
 * Wrap a background job so it always reports, whichever way it ends.
 *
 * A job that succeeds silently and a job that never ran look identical in a log
 * that only records failures — which is exactly how a cron that stopped firing
 * goes unnoticed for a month. Both outcomes are always emitted.
 *
 * Never re-throws: a scheduler seeing an exception may retry a job that has
 * already had its side effects. The outcome is returned for the caller to act on.
 */
export async function runJob<T>(job: string, fn: (ctx: { correlationId: string }) => Promise<T>): Promise<JobResult<T>> {
  const id = correlationId();
  const started = Date.now();
  log.info(`job.start`, { job, correlationId: id });

  try {
    const result = await fn({ correlationId: id });
    const durationMs = Date.now() - started;
    log.info(`job.complete`, { job, correlationId: id, durationMs, result: redact(result) });
    return { ok: true, job, correlationId: id, durationMs, result };
  } catch (err: any) {
    const durationMs = Date.now() - started;
    log.error(`job.failed`, { job, correlationId: id, durationMs, error: err });
    return { ok: false, job, correlationId: id, durationMs, error: String(err?.message ?? err) };
  }
}

/**
 * Time an operation and warn when it exceeds a budget.
 *
 * The budget is an engineering expectation, not a federation rule, so it lives
 * in code — but exceeding it warns rather than failing. A slow ranking
 * calculation is a signal, not an error, and turning it into one would take the
 * page down over a performance regression.
 */
export async function timed<T>(
  operation: string,
  budgetMs: number,
  fn: () => Promise<T>,
  ctx: LogContext = {}
): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const durationMs = Date.now() - started;
    if (durationMs > budgetMs) {
      log.warn('operation.slow', { ...ctx, operation, durationMs, budgetMs });
    } else {
      log.debug('operation.complete', { ...ctx, operation, durationMs });
    }
  }
}

// ─── Health ─────────────────────────────────────────────────────────────────

export interface HealthCheck {
  name: string;
  status: 'ok' | 'degraded' | 'down' | 'not_configured';
  detail?: string;
  durationMs?: number;
}

/**
 * Run a health probe that can never hang the health endpoint.
 *
 * A probe without a timeout is how a health check becomes the thing that takes
 * the site down: the monitor calls it, the dependency is hung, the request pool
 * fills, and every other page stops responding.
 *
 * `not_configured` is a first-class state, distinct from `down`. A database that
 * was never configured is not an outage, and reporting it as one trains an
 * operator to ignore the alert.
 */
/**
 * How a completed probe is classified.
 *
 * Pulled out of probe() because the test for it was measuring the machine, not
 * the rule: it slept 60ms against a 100ms timeout and expected `degraded`, so a
 * loaded CI box that overshot to 110ms reported `down` and failed a correct
 * implementation. The threshold is the thing worth asserting, and it needs no
 * clock at all.
 *
 * Half the timeout is the line. A dependency answering in half the time we are
 * willing to wait is already the interesting signal — reachable but slow is
 * worth knowing BEFORE it becomes unreachable, which is the whole reason this
 * status exists.
 */
export function probeStatus(ok: boolean, durationMs: number, timeoutMs: number): 'ok' | 'degraded' | 'down' {
  if (!ok) return 'down';
  return durationMs > timeoutMs / 2 ? 'degraded' : 'ok';
}

export async function probe(
  name: string,
  configured: boolean,
  check: () => Promise<boolean>,
  timeoutMs = 3000,
  /**
   * Injectable clock. Default is the real one; a test supplies its own so the
   * classification can be exercised without racing a scheduler.
   */
  now: () => number = Date.now
): Promise<HealthCheck> {
  if (!configured) return { name, status: 'not_configured' };

  const started = now();
  try {
    const ok = await Promise.race([
      check(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timed out')), timeoutMs)),
    ]);
    const durationMs = now() - started;
    const status = probeStatus(Boolean(ok), durationMs, timeoutMs);
    return {
      name,
      status,
      durationMs,
      detail: status === 'degraded' ? `Responded in ${durationMs}ms` : undefined,
    };
  } catch (err: any) {
    return { name, status: 'down', durationMs: now() - started, detail: String(err?.message ?? err).slice(0, 200) };
  }
}

/**
 * Roll individual probes into one status.
 *
 * `not_configured` never degrades the overall result — an unconfigured optional
 * dependency is a deployment fact, not a fault, and treating it as one would
 * leave the system permanently reporting itself unhealthy.
 */
export function overallStatus(checks: HealthCheck[]): 'ok' | 'degraded' | 'down' {
  if (checks.some((c) => c.status === 'down')) return 'down';
  if (checks.some((c) => c.status === 'degraded')) return 'degraded';
  return 'ok';
}
