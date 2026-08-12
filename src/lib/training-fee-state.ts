// What a public page may ask the fee engine.
//
// A thin, DELIBERATELY NARROW seam between the training surfaces and
// src/db/fees.ts. It exists for two reasons, and both are about what a public
// page must not be able to do.
//
// FIRST: a public page must never import the authoring side of the fee engine.
// createFramework(), addRule() and publishFramework() all sit behind
// finance:write, and a template that has them in scope is one refactor away
// from calling one. Re-exporting only the read path means the capability is not
// present on the page at all, which is a stronger guarantee than remembering
// not to use it.
//
// SECOND: it keeps the "has the federation published fees yet?" question in ONE
// place. Several surfaces need it — /training, the estimator, the institutional
// request flow — and each answering it its own way is how one page ends up
// saying "no fees published" while another quietly shows a figure.

export { activeFramework, computeFee, formatINR, PPM, isFeeError } from '@/db/fees';
export type { FeeInputs, Computation, ComputedLine } from '@/db/fees';

/**
 * Today, as an ISO date, for asking which framework is in force.
 *
 * Named distinctly rather than exported as `todayIso` because this codebase
 * already has two of those — in src/lib/calendar.ts and src/db/membership.ts —
 * and a third identically-named export is how an import resolves to the wrong
 * one without anybody noticing.
 */
export function todayIsoForFees(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * What a surface should say about fees right now.
 *
 * Three states, not two, and the third is the one that matters: "the federation
 * has not published fees" and "we could not read the fee register" are
 * completely different sentences to somebody deciding whether to trust MMAKF
 * with their child's school. Collapsing them into "pricing unavailable" tells a
 * visitor nothing and tells an operator less.
 */
export type FeeAvailability =
  | { state: 'published'; frameworkCode: string }
  | { state: 'not_published' }
  | { state: 'unreadable'; detail: string };

export async function feeAvailability(
  db: unknown,
  asAt: string
): Promise<FeeAvailability> {
  const { activeFramework: active } = await import('@/db/fees');
  try {
    const fw = await active(db as any, asAt);
    return fw ? { state: 'published', frameworkCode: fw.code } : { state: 'not_published' };
  } catch (err: any) {
    return { state: 'unreadable', detail: String(err?.message ?? err).slice(0, 200) };
  }
}
