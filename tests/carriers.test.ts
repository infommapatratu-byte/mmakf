// Couriers, and the link this codebase refuses to invent.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THERE IS AN INTERFACE FOR SOMETHING WITH ONE IMPLEMENTATION
// ═════════════════════════════════════════════════════════════════════════════
//
// The brief: "Do not hard-code one courier. Create a provider interface so
// courier integrations can be added later." The temptation it guards against is
// not a bad architect — it is a template literal. The one place that needs a
// tracking link writes `https://indiapost…${number}` inline, and the codebase
// has acquired a courier without anybody deciding to, which the next courier
// then has to be special-cased around.
//
// So src/lib/carriers mirrors src/lib/payments and src/lib/payouts, and the
// manual adapter is not a stub: a seller at a post-office counter is how every
// parcel on this marketplace is sent today.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE PROPERTY THAT MATTERS MOST
// ═════════════════════════════════════════════════════════════════════════════
//
// A TRACKING URL IS NEVER INVENTED. A guessed link is strictly worse than none:
// the buyer follows it, meets a 404 at a courier's website, and concludes the
// parcel is lost. Most of the assertions below are that null is returned.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  activeCarrier, carrierById, availableCarriers, carrierStatusReport,
  trackingUrlFor, knownCarriers, manualCarrier,
  CARRIER_INTEGRATION_NOT_SET, isCarrierError, CarrierError,
} from '../src/lib/carriers';

describe('the registry always yields a way to send a parcel', () => {
  it('resolves a provider with no configuration at all', () => {
    // Unlike the payments registry, there is no "no provider" state: the manual
    // adapter's implementation is a person, so a marketplace is never left
    // unable to ship.
    const active = activeCarrier();
    expect(active).toBeTruthy();
    expect(active.isConfigured()).toBe(true);
    expect(availableCarriers().length).toBeGreaterThan(0);
  });

  it('finds a provider by id and returns null for one that does not exist', () => {
    expect(carrierById('manual')).toBe(manualCarrier);
    expect(carrierById('a-courier-nobody-wrote')).toBeNull();
  });

  it('reports that booking is MANUAL rather than implying an integration', () => {
    // §70. A payout queue that looks like it is running itself is a payout
    // queue nobody works, and the same is true of a dispatch queue.
    const report = carrierStatusReport();
    expect(report.automatic).toBe(false);
    expect(report.id).toBe('manual');
    expect(report.summary).toBe(CARRIER_INTEGRATION_NOT_SET);
    expect(report.summary.length).toBeGreaterThan(60);
  });

  it('says it cannot book, rather than leaving a surface to find out', () => {
    expect(manualCarrier.canBook).toBe(false);
    expect(manualCarrier.book).toBeUndefined();
  });
});

describe('trackingUrl — known couriers only, and nothing else', () => {
  it('builds a link for a courier whose public tracking page is known', () => {
    const url = trackingUrlFor('EK123456789IN', 'India Post');
    expect(url).toBeTruthy();
    expect(url).toContain('indiapost.gov.in');
    expect(url).toContain('EK123456789IN');
  });

  it('matches the courier name however a seller typed it', () => {
    // The field is free text. "India Post", "india post", "INDIAPOST" and
    // "Speed Post (India Post)" are one courier to everybody except a string
    // comparison.
    const variants = ['India Post', 'india post', 'INDIAPOST', 'India-Post', 'Speed Post (India Post)'];
    for (const name of variants) {
      expect(trackingUrlFor('EK123456789IN', name), name).toBeTruthy();
    }
  });

  it('RETURNS NULL for a courier it does not know — it does not guess', () => {
    // The assertion the whole file exists for.
    expect(trackingUrlFor('ABC123456', 'Ramgarh Local Couriers')).toBeNull();
    expect(trackingUrlFor('ABC123456', 'Some Courier Ltd')).toBeNull();
  });

  it('returns null when no courier was named at all', () => {
    expect(trackingUrlFor('ABC123456', null)).toBeNull();
    expect(trackingUrlFor('ABC123456', '')).toBeNull();
  });

  it('returns null for something that is not a consignment number', () => {
    // Refused before a URL is built from it, so a paste accident or an
    // injection attempt never reaches encodeURIComponent as the only defence.
    expect(trackingUrlFor('', 'India Post')).toBeNull();
    expect(trackingUrlFor('ab', 'India Post')).toBeNull();
    expect(trackingUrlFor('has spaces in it', 'India Post')).toBeNull();
    expect(trackingUrlFor('../../etc/passwd', 'India Post')).toBeNull();
    expect(trackingUrlFor('EK1234<script>', 'India Post')).toBeNull();
    expect(trackingUrlFor('x'.repeat(60), 'India Post')).toBeNull();
  });

  it('never emits a search engine or an aggregator as a fallback', () => {
    // The other shape of "invented": a link that technically resolves and puts
    // the federation's name behind a page it does not control.
    for (const courier of ['Unknown Courier', 'Local Transport', '']) {
      const url = trackingUrlFor('EK123456789IN', courier);
      expect(url === null || !/google|bing|track(ing)?101|aftership/i.test(url)).toBe(true);
    }
  });

  it('lists the couriers it can link, so a seller knows when to paste their own', () => {
    const known = knownCarriers();
    expect(known.length).toBeGreaterThan(0);
    expect(known).toContain('India Post');
    // Every listed courier really does produce a link.
    for (const name of known) {
      expect(trackingUrlFor('EK123456789IN', name), name).toBeTruthy();
    }
  });
});

describe('CarrierError is identified by shape, as elsewhere in this codebase', () => {
  it('recognises its own and refuses everything else', () => {
    expect(isCarrierError(new CarrierError('nope', 'A refusal.'))).toBe(true);
    expect(isCarrierError(new Error('ordinary'))).toBe(false);
    expect(isCarrierError(null)).toBe(false);
    expect(isCarrierError({ code: 'x' })).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('REACHABILITY — the interface is used, not merely written', () => {
// ═════════════════════════════════════════════════════════════════════════════

  // A provider interface nothing calls is the exact defect this repository
  // keeps finding: complete, correct, and unreachable from the application.

  const read = (p: string) => readFileSync(p, 'utf8');

  it('dispatch derives a tracking link through the adapter', () => {
    const src = read('src/db/seller-orders.ts');
    expect(src).toContain("from '@/lib/carriers'");
    expect(src).toContain('trackingUrlFor');
  });

  it('the seller’s own URL is preferred over the derived one', () => {
    // A seller may hold a link this deployment does not know about, and theirs
    // is the better answer whenever they gave one.
    const src = read('src/db/seller-orders.ts');
    expect(src).toMatch(/input\.trackingUrl\?\.trim\(\)\s*\n?\s*\|\|/);
  });

  it('the buyer’s order page renders the link where one exists and the number where none does', () => {
    const src = read('src/pages/my/orders.astro');
    expect(src).toContain('sh.trackingUrl');
    expect(src).toContain('sh.trackingNumber');
  });

  it('the dispatch form names which couriers can be linked', () => {
    const src = read('src/pages/portal/seller/orders.astro');
    expect(src).toContain('knownCarriers');
  });
});
