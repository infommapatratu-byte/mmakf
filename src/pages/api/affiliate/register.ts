import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { submitApplication, ApplicationError } from '@/db/applications';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';

export const prerender = false;

const FEE_CODES: Record<string, string> = {
  individual: 'AFF-INDIVIDUAL',
  club: 'AFF-CLUB',
  district: 'AFF-DISTRICT',
  state: 'AFF-STATE',
  school: 'MEM-INSTITUTION',
  corporate: 'MEM-INSTITUTION',
  international: 'AFF-INTERNATIONAL',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'affiliate-register', 5, 3600);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);
  if (!isConfigured()) return json({ error: 'Affiliate registration is not available on this deployment.' }, 503);
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const level = typeof body?.level === 'string' ? body.level : '';
  if (!Object.prototype.hasOwnProperty.call(FEE_CODES, level)) return json({ error: 'Choose a supported affiliate level.' }, 400);
  const payload = {
    institutionName: String(body.name || '').trim(),
    audience: level === 'individual' || level === 'club' || level === 'district' || level === 'state' ? 'organisation' : level,
    addressLine: String(body.address || '').trim(),
    city: String(body.city || '').trim(),
    stateName: String(body.state || '').trim(),
    contactName: String(body.contactName || '').trim(),
    contactEmail: String(body.email || '').trim().toLowerCase(),
    contactPhone: String(body.phone || '').trim(),
    requirements: `Affiliate level: ${level}. Registration submitted for federation review.`,
  };
  if (!payload.institutionName || !payload.contactEmail || !payload.contactName) return json({ error: 'Name, contact name, and email are required.' }, 400);
  try {
    const result = await submitApplication(db(), { payload });
    return json({ ok: true, ref: result.ref, applicationId: result.applicationId, feeCode: FEE_CODES[level], message: 'Application received. MMAKF will review it before payment and approval.' });
  } catch (err) {
    if (err instanceof ApplicationError) return json({ error: err.message }, 400);
    console.error('affiliate registration failed', err);
    return json({ error: 'Registration could not be completed.' }, 500);
  }
};
