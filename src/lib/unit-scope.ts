// What a unit portal session may see.
//
// The rule a federation needs: a unit sees its OWN level, not its state's.
// Before this, every access code — State, District or Club — was filtered on
// state alone, so a single club's code could read the name and phone number of
// every registration applicant in the state.
//
// Enforcement FAILS CLOSED. A District or Club code with no district or unit
// recorded against it sees nothing and is told why, rather than silently
// widening back to the whole state. Falling back to "more data" is how the
// original bug was invisible.

export interface UnitScope {
  name: string;
  level: string;
  state: string;
  district?: string;
}

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** Why a scope can see nothing at all, or null if it is properly configured. */
export function scopeProblem(scope: UnitScope): string | null {
  const level = norm(scope.level);
  if (level === 'state') return norm(scope.state) ? null : 'No state is recorded against this access code.';

  if (level === 'district' && !norm(scope.district)) {
    return 'No district is recorded against this access code, so no records can be shown. ' +
      'Ask the national office to set the district on your Unit Access record.';
  }
  if (level !== 'district' && !norm(scope.name)) {
    return 'No unit name is recorded against this access code, so no records can be shown. ' +
      'Ask the national office to correct your Unit Access record.';
  }
  return null;
}

/** Does this record fall inside the unit's authority? */
export function inScope(scope: UnitScope, record: any): boolean {
  if (!record || typeof record !== 'object') return false;
  if (scopeProblem(scope)) return false;

  // Every level is bounded by its state first.
  if (norm(record.state) !== norm(scope.state)) return false;

  const level = norm(scope.level);
  if (level === 'state') return true;

  if (level === 'district') {
    return norm(record.district) === norm(scope.district);
  }

  // Club, and anything unrecognised, is treated as the narrowest scope: only
  // records that name this unit. An unknown level must never widen access.
  const unit = norm(scope.name);
  return norm(record.unit) === unit || norm(record.dojo) === unit;
}

/** Filter a list to what this unit may see. */
export function scopeList<T>(scope: UnitScope, rows: T[]): T[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => inScope(scope, r));
}

/** A human label for what the unit is looking at. */
export function scopeLabel(scope: UnitScope): string {
  const level = norm(scope.level);
  if (level === 'state') return scope.state;
  if (level === 'district') return scope.district ? `${scope.district}, ${scope.state}` : scope.state;
  return scope.name;
}
