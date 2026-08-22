// Object storage for editorial media.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A SEAM HERE AT ALL
// ─────────────────────────────────────────────────────────────────────────────
//
// The rest of this repository is deliberately provider-neutral: the database is
// a connection string, the CA is a PEM, the editorial store is two REST
// variables. Nothing anywhere imports a vendor SDK to do its core work, so that
// moving host is a change of configuration rather than a change of code.
//
// This module breaks that rule once, on purpose, and confines the breakage to
// one file. `@vercel/blob` is the seam: everything above it — the API route,
// the console, `src/lib/uploads.ts` — speaks only in bytes in and a URL out.
// Replacing the provider means rewriting this file and nothing else.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS STORE IS PUBLIC, AND THAT IS A CONSTRAINT, NOT A DETAIL
// ─────────────────────────────────────────────────────────────────────────────
//
// The store is created with public access because a browser has to fetch a
// club photograph directly from it; a signed URL for every <img> would be a
// redirect per image on every page load. Public means ANYONE WITH THE URL CAN
// READ IT, and the URLs carry a random suffix rather than being guessable.
//
// So only material classified 'public' may be written here. src/lib/uploads.ts
// classifies every purpose, and putUpload() refuses anything else — a medical
// document, a safeguarding file or a seller's PAN card must never reach this
// store, and the refusal is here rather than in a comment asking callers to be
// careful.

import { PURPOSE_RULES, type UploadPurpose } from './uploads';

/** The public hostname blobs are served from. Referenced by the CSP. */
export const BLOB_PUBLIC_HOST_SUFFIX = '.public.blob.vercel-storage.com';

export interface StoredObject {
  url: string;
  pathname: string;
  contentType: string;
  size: number;
}

/**
 * Is object storage configured for this runtime?
 *
 * The token is injected by the platform when a store is linked to the project.
 * Absent it, this module does nothing and says so — §70: a surface that cannot
 * store a file must report that, not accept one and lose it.
 */
export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** True when this hostname is one we serve blobs from. */
export function isBlobUrl(url: string): boolean {
  try {
    return new URL(url).host.endsWith(BLOB_PUBLIC_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * Store bytes and return the URL they are served from.
 *
 * `purpose` is not decoration: it is checked against PURPOSE_RULES and refused
 * unless the classification is 'public'. Callers pass the purpose they already
 * validated the bytes under, so one value governs both what may be uploaded and
 * where it may be kept.
 */
export async function putUpload(input: {
  bytes: Uint8Array;
  pathname: string;
  contentType: string;
  purpose: UploadPurpose;
}): Promise<StoredObject> {
  const rule = PURPOSE_RULES[input.purpose];
  if (!rule) throw new Error(`Unknown upload purpose: ${input.purpose}`);
  if (rule.classification !== 'public') {
    throw new Error(
      `Refusing to write '${input.purpose}' to the public media store: it is classified ` +
      `'${rule.classification}'. Public storage is readable by anyone holding the URL.`
    );
  }
  if (!blobConfigured()) {
    throw new Error('No object storage is configured (BLOB_READ_WRITE_TOKEN is not set).');
  }

  // Imported here rather than at module scope so that a runtime with no storage
  // configured — a test, a local dev server — does not pay for the dependency
  // just to call blobConfigured().
  const { put } = await import('@vercel/blob');

  const result = await put(input.pathname, Buffer.from(input.bytes), {
    access: 'public',
    contentType: input.contentType,
    // A RANDOM SUFFIX, KEPT ON. Two people uploading 'logo.png' must not
    // collide, and a predictable path in a public store is a directory anyone
    // can walk by guessing.
    addRandomSuffix: true,
    // Editorial media is replaced by uploading a new file and repointing the
    // field, never by overwriting a path something already renders.
    allowOverwrite: false,
  });

  return {
    url: result.url,
    pathname: result.pathname,
    contentType: input.contentType,
    size: input.bytes.byteLength,
  };
}
