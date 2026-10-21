import { timingSafeEqual } from 'node:crypto';
export function senderAuthorized(req) {
  const secret = process.env.WA_SENDER_SECRET || '';
  if (secret.length < 32) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(req.headers?.authorization || '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
