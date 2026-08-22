// Upload an editorial image and get back the URL it is served from.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE FILE ARRIVES AS JSON AND NOT AS multipart/form-data
// ─────────────────────────────────────────────────────────────────────────────
//
// src/middleware.ts refuses any mutating request to /api/ that is not sent as
// application/json. That rule is the CSRF defence: a cross-site form can post
// multipart without a preflight, and JSON cannot be sent cross-site without one
// we never answer. Accepting multipart here would mean carving an exemption
// into that rule for the one route that takes a file — the shape an attacker
// would pick if they were choosing.
//
// So the bytes come base64 inside a JSON body. The cost is a third more bytes
// on the wire and the cap below; the benefit is that the middleware needs no
// exception and this route is protected by exactly the same rule as every
// other write.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT DECIDES WHETHER THE FILE IS ACCEPTED
// ─────────────────────────────────────────────────────────────────────────────
//
// Not the filename, and not the Content-Type the caller declared. validateUpload()
// in src/lib/uploads.ts sniffs the magic number, compares it against what was
// claimed, refuses anything carrying executable markup, and returns a stored
// filename it derived itself. This route never trusts a string the uploader
// chose for anything except a mismatch report.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { can } from '@/lib/rbac';
import { validateUpload, UploadError, PURPOSE_RULES } from '@/lib/uploads';
import { putUpload, blobConfigured } from '@/lib/blob-store';
import { isConfigured, db } from '@/db';
import { writeAudit } from '@/db/federation';

export const prerender = false;

/** Editorial imagery is public by classification — see src/lib/uploads.ts. */
const PURPOSE = 'media_photograph' as const;

/**
 * The transport cap, which is LOWER than the purpose's own limit.
 *
 * PURPOSE_RULES allows 15 MB for a media photograph. A serverless request body
 * is limited to about 4.5 MB and base64 adds a third, so anything over roughly
 * 3 MB cannot arrive here at all — it would be cut off by the platform, and the
 * caller would see a network error rather than a sentence. Stating the smaller
 * number here means the refusal explains itself.
 */
const MAX_DECODED_BYTES = 3 * 1024 * 1024;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Unauthorized' }, 401);

  // The same authority that edits the content the image will appear in. A state
  // or club credential is refused here by scope, exactly as it is on
  // /api/data/[key].
  if (!can(identity.principal, 'content:write', {})) {
    return json({ error: 'You do not have authority to upload federation media' }, 403);
  }

  if (!blobConfigured()) {
    return json(
      {
        error:
          'No media storage is configured on this deployment, so the file cannot be kept. ' +
          'Paste an image URL instead, or ask an operator to link a blob store.',
      },
      503
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  const filename = typeof body.filename === 'string' ? body.filename : '';
  const declaredType = typeof body.contentType === 'string' ? body.contentType : undefined;
  const b64 = typeof body.data === 'string' ? body.data : '';
  if (!filename || !b64) return json({ error: 'A filename and file data are required' }, 400);

  let bytes: Uint8Array;
  try {
    // `data:` URLs are accepted because that is what a FileReader produces; the
    // prefix is stripped rather than parsed, since nothing in it is trusted.
    const raw = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
    bytes = new Uint8Array(Buffer.from(raw, 'base64'));
  } catch {
    return json({ error: 'The file data could not be read' }, 400);
  }

  if (bytes.byteLength === 0) return json({ error: 'The file is empty' }, 400);
  if (bytes.byteLength > MAX_DECODED_BYTES) {
    return json(
      {
        error:
          `That image is ${(bytes.byteLength / 1048576).toFixed(1)} MB. The limit for an upload ` +
          `through the console is ${(MAX_DECODED_BYTES / 1048576).toFixed(0)} MB — resize it, or ` +
          `host it and paste the URL.`,
      },
      413
    );
  }

  let validated;
  try {
    validated = validateUpload({ bytes, filename, declaredType, purpose: PURPOSE });
  } catch (err) {
    if (err instanceof UploadError) return json({ error: err.message, code: err.code }, 400);
    console.error('upload: validation failed', err);
    return json({ error: 'The file could not be validated' }, 400);
  }

  let stored;
  try {
    stored = await putUpload({
      bytes,
      // Grouped by year so the store stays legible to a person opening it in
      // two years' time, and prefixed so editorial media is never confused with
      // anything a future purpose writes.
      pathname: `editorial/${new Date().getUTCFullYear()}/${validated.storedFilename}`,
      contentType: validated.contentType,
      purpose: PURPOSE,
    });
  } catch (err: any) {
    console.error('upload: storage write failed', err);
    return json({ error: 'The image could not be stored. Nothing was saved.' }, 502);
  }

  // Recorded because an image on a public federation page is a publication, and
  // the register should be able to say who put it there. The hash is kept so a
  // later swap of the stored file is detectable.
  if (isConfigured()) {
    try {
      await writeAudit(
        db(),
        { principal: identity.principal, ip: clientIp(request) },
        {
          entityType: 'media',
          entityId: stored.pathname,
          action: 'create',
          newValue: {
            url: stored.url,
            contentType: validated.contentType,
            sizeBytes: validated.sizeBytes,
            sha256: validated.sha256,
            displayFilename: validated.displayFilename,
            declaredTypeMismatch: validated.declaredTypeMismatch,
          },
        }
      );
    } catch (err) {
      // The file is stored. Failing the request now would tell the operator it
      // was not, and they would upload it again.
      console.error('upload: audit write failed', err);
    }
  }

  return json(
    {
      ok: true,
      url: stored.url,
      contentType: validated.contentType,
      sizeBytes: validated.sizeBytes,
      filename: validated.displayFilename,
      maxBytes: PURPOSE_RULES[PURPOSE].maxBytes,
    },
    200
  );
};
