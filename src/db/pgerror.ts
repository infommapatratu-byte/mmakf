// Postgres error shapes.
//
// Drivers and ORMs wrap the original error to differing depths — Drizzle's
// message is the failed query text and carries no `code` — so detection has to
// walk the cause chain rather than trust the outermost object. Getting this
// wrong is silent: a unique-violation guard simply never fires, and the caller
// sees a raw 500 where it expected a handled conflict.

/** SQLSTATE 23505 — unique constraint violation. */
export function isUniqueViolation(err: any): boolean {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.code === '23505') return true;
    if (/duplicate key value|unique constraint/i.test(String(e.message ?? ''))) return true;
  }
  return false;
}

/** SQLSTATE 23503 — foreign key violation. */
export function isForeignKeyViolation(err: any): boolean {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.code === '23503') return true;
    if (/foreign key constraint/i.test(String(e.message ?? ''))) return true;
  }
  return false;
}
