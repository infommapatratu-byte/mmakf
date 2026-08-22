import { describe, it, expect } from 'vitest';

const ACCOUNT = '50100123456789';

function allStrings(value: unknown, out: string[] = []): string[] {
  if (value === null || value === undefined) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (typeof value === 'number' || typeof value === 'boolean') { out.push(String(value)); return out; }
  if (value instanceof Error) {
    out.push(value.message, value.name, String(value.stack ?? ''));
    for (const k of Object.keys(value as any)) allStrings((value as any)[k], out);
    return out;
  }
  if (Array.isArray(value)) { for (const v of value) allStrings(v, out); return out; }
  if (typeof value === 'object') {
    for (const k of Object.keys(value as any)) allStrings(v(value), out);
    return out;
  }
  return out;
}
function v(o: any) { return Object.values(o); }

describe('the leak detector actually detects', () => {
  it('finds a nested account number in a plain object', () => {
    const leaky = { a: { b: [{ detail: { body: `acct=${ACCOUNT}` } }] } };
    expect(allStrings(leaky).join(' ')).toContain(ACCOUNT);
  });

  it('finds one on a custom error property', () => {
    const err: any = new Error('nothing here');
    err.detail = { request: { account_number: ACCOUNT } };
    expect(allStrings(err).join(' ')).toContain(ACCOUNT);
  });

  it('finds one in an error message', () => {
    const err = new Error(`refused for account ${ACCOUNT}`);
    expect(allStrings(err).join(' ')).toContain(ACCOUNT);
  });
});
