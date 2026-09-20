import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { resetPasswordByDob, resetPasswordByRegistration } from '@/db/users';
import { passwordProblem } from '@/lib/password';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { clientIp } from '@/lib/session';
import { writeAudit } from '@/db/federation';

export const prerender = false;

const GENERIC = 'The details could not be verified. Check your email and date of birth, then try again.';

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  // Allow legitimate admin recovery retries while retaining an hourly abuse limit.
  // The versioned bucket also clears counters created by the previous 5-attempt limit.
  const rl = await rateLimit(request, 'password-reset-v2', 15, 3600);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);
  if (!isConfigured()) return json({ error: 'Password reset is not available on this deployment.' }, 503);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const dob = typeof body?.dob === 'string' ? body.dob.trim() : '';
  const registrationNumber = typeof body?.registrationNumber === 'string' ? body.registrationNumber.trim() : '';
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
  const confirm = typeof body?.confirm === 'string' ? body.confirm : '';

  if (!email || (!dob && !registrationNumber) || (dob && registrationNumber) || !newPassword || newPassword !== confirm) {
    return json({ error: 'Enter your email, one recovery identifier, and matching new passwords.' }, 400);
  }
  const problem = passwordProblem(newPassword);
  if (problem) return json({ error: problem }, 400);

  try {
    const verified = registrationNumber
      ? await resetPasswordByRegistration(db(), registrationNumber, email, newPassword)
      : await resetPasswordByDob(db(), email, dob, newPassword);
    if (!verified) return json({ error: GENERIC }, 401);
    try {
      await writeAudit(
        db(),
        { principal: { userId: null, label: 'password-recovery', bindings: [] }, ip: clientIp(request) },
        { entityType: 'user', entityId: email, action: 'password_reset', newValue: { via: registrationNumber ? 'registration_number' : 'date_of_birth' } }
      );
    } catch (auditError) {
      // Do not report a valid credential change as failed if an older production
      // database has not applied the password-reset audit migration yet.
      console.error('password reset audit failed after credential update', auditError);
    }
    return json({ ok: true, message: 'Password updated. You can now sign in.' }, 200);
  } catch (err) {
    console.error('password reset failed', err);
    return json({ error: 'Password reset could not be completed. Please try again later.' }, 500);
  }
};
