// A form must never be blocked by a required field the user cannot see.
//
// THE OUTAGE THIS PINS. Commit 3f72b58 (2026-09-20) added `required` to the
// email box of the "Reset password with date of birth" section — which sits,
// collapsed inside a <details>, INSIDE the sign-in <form> on /my and /admin.
// Collapsed, the box is empty and hidden; the browser's own constraint
// validation then refuses to submit the sign-in form, and because the invalid
// control is not focusable it cannot even show a message. Chrome logs only
// "An invalid form control with name='' is not focusable". The sign-in script
// never ran, no request reached the server, and nobody could sign in — on any
// account — for seven weeks. Every unit test stayed green, because no test
// submitted the form in a browser.
//
// The rule enforced here: inside a <form>, no control in a CLOSED <details> may
// carry `required`. (An `open` details is visible, so it is allowed.) A section
// with its own workflow validates in its own handler, as the reset section does.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.astro')) out.push(p);
  }
  return out;
}

/** Each <form>…</form> block's text, with the line it starts on. */
function forms(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = /<form\b[\s\S]*?<\/form>/gi;
  for (const m of src.matchAll(re)) {
    out.push({ line: src.slice(0, m.index!).split('\n').length, text: m[0] });
  }
  return out;
}

/** Required controls inside a closed <details> within one form block. */
function hiddenRequired(formText: string): string[] {
  const found: string[] = [];
  for (const d of formText.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/gi)) {
    if (/\bopen\b/.test(d[1])) continue;
    for (const c of d[2].matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
      if (/\srequired(\s|=|\/|>)/i.test(c[0])) found.push(c[0].replace(/\s+/g, ' ').slice(0, 140));
    }
  }
  return found;
}

describe('no form is blocked by a required field the user cannot see', () => {
  const files = [...walk('src/pages'), ...walk('src/components'), ...walk('src/layouts')];

  it('the scanner sees the bug it exists for', () => {
    const broken = '<form id="x"><input name="email" required /><details><summary>Reset</summary><input id="r" type="email" required /></details></form>';
    expect(hiddenRequired(forms(broken)[0].text)).toHaveLength(1);
    const open = '<form><details open><input required /></details></form>';
    expect(hiddenRequired(forms(open)[0].text)).toHaveLength(0);
  });

  it('every form in the site can be submitted', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const form of forms(src)) {
        for (const c of hiddenRequired(form.text)) offenders.push(`${f}:${form.line} ${c}`);
      }
    }
    expect(offenders, 'a required control hidden in a closed <details> blocks its whole form').toEqual([]);
  });

  it('the two sign-in forms specifically keep their own fields required and the reset fields optional', () => {
    for (const [file, formId, resetId] of [
      ['src/pages/my/index.astro', 'signInForm', 'member-reset-email'],
      ['src/pages/admin/index.astro', 'loginForm', 'reset-email'],
    ]) {
      const src = readFileSync(file, 'utf8');
      const form = forms(src).find((f) => f.text.includes(`id="${formId}"`));
      expect(form, `${file} has its sign-in form`).toBeTruthy();
      const reset = form!.text.match(new RegExp(`<input[^>]*id="${resetId}"[^>]*>`))?.[0] ?? '';
      expect(reset, `${file}: the reset email field exists`).not.toBe('');
      expect(reset, `${file}: the hidden reset field must not be required`).not.toMatch(/\srequired/);
      expect(form!.text, `${file}: the password is still required`).toMatch(/type="password"[^>]*name="password"[^>]*required|name="password"[^>]*required/);
    }
  });
});
