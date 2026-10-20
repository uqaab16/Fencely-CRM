import { timingSafeEqual } from 'node:crypto';
import { bridgeConfigured } from './wa-service.js';

export function bridgeAuthorized(req) {
  if (!bridgeConfigured()) return false;
  const expected = Buffer.from(`Bearer ${process.env.WA_BRIDGE_SECRET}`);
  const actual = Buffer.from(req.headers?.authorization || '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// The bridge is permitted to submit registration checks only, never contacts,
// stage changes, outreach jobs, or arbitrary SQL. Do not accept upstream text.
export function bridgeResult(number, input = {}) {
  const details = {
    available: 'Registration found at check time. This is not marketing consent.',
    not_found: 'Gateway did not find WhatsApp. Skip sending; recheck before marking unavailable.',
    check_failed: 'Gateway check failed. Registration is unknown; retry later.',
  };
  if (!Object.hasOwn(details, input.status)) {
    const e = new Error('Invalid check result'); e.statusCode = 400; throw e;
  }
  return { number, status: input.status, checked_at: new Date().toISOString(), detail: details[input.status], jid: '' };
}
