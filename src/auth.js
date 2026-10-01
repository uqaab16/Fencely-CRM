// Single-user auth for the Fencely CRM — no OAuth, no extra services.
//
// Model:
//   - The one admin user lives in the `users` table (email + bcryptjs hash).
//     On first boot, if the table is empty, the user is seeded from env
//     ADMIN_EMAIL + ADMIN_PASSWORD_HASH (Amir generates the hash from a
//     password only he knows — the plaintext password is never stored or sent).
//   - Login returns a stateless JWT (HS256, hand-rolled with node:crypto —
//     no jsonwebtoken dependency), 7-day expiry, signed with JWT_SECRET.
//     Stateless = safe on Vercel's serverless functions.
//   - The remote MCP endpoint uses a SEPARATE long-lived static token
//     (MCP_TOKEN env), never the JWT.
//   - The cron job uses CRON_SECRET env (see checkCronAuth).
//
// Secrets are read from env ONLY and never logged — logs carry booleans at most.
// Auth FAILS CLOSED: no seeded user / no JWT_SECRET => login is unavailable.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as db from './db.js';

const TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7 days

// ---------------------------------------------------------------------------
// JWT (HS256)
// ---------------------------------------------------------------------------
const b64urlJson = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function signToken(payload, secret = process.env.JWT_SECRET) {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson({ ...payload, iat: now, exp: now + TOKEN_TTL_SECONDS })}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token, secret = process.env.JWT_SECRET) {
  if (!secret || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Admin user seeding + credential check
// ---------------------------------------------------------------------------
export async function seedAdminIfNeeded() {
  const count = await db.countUsers();
  if (count > 0) return { seeded: false, usersExist: true, configured: true };
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const hash = process.env.ADMIN_PASSWORD_HASH || '';
  if (!email || !hash) {
    console.warn('[auth] users table is empty and ADMIN_EMAIL / ADMIN_PASSWORD_HASH are not both set — login is DISABLED (fail closed) until both are provided.');
    return { seeded: false, usersExist: false, configured: false };
  }
  await db.createUser(email, hash);
  console.log('[auth] Admin user seeded from env (ADMIN_EMAIL set: true, ADMIN_PASSWORD_HASH set: true).');
  return { seeded: true, usersExist: true, configured: true };
}

export async function verifyCredentials(email, password) {
  if (!email || !password) return null;
  const user = await db.getUserByEmail(email);
  if (!user) return null;
  try {
    const ok = await bcrypt.compare(String(password), user.password_hash);
    return ok ? { id: user.id, email: user.email } : null;
  } catch {
    return null; // malformed stored hash => treat as a failed login, never crash
  }
}

// ---------------------------------------------------------------------------
// Request guards (headers only — works for node:http and Vercel req objects)
// ---------------------------------------------------------------------------
function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || '');
  return m ? m[1].trim() : null;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Returns { email } for a valid JWT, else null. */
export function authUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const payload = verifyToken(token);
  return payload ? { email: payload.email || payload.sub } : null;
}

/** Remote MCP endpoint: static long-lived MCP_TOKEN (NOT the login JWT). */
export function checkMcpToken(req) {
  const expected = process.env.MCP_TOKEN || '';
  if (!expected) return false; // fail closed
  const token = bearer(req);
  if (token && safeEqual(token, expected)) return true;
  // Fallback: token in the URL query (?token=...), for MCP clients that
  // cannot set custom headers (e.g. claude.ai custom connectors).
  // Treat such URLs as secret — they grant full MCP access.
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    const qt = u.searchParams.get('token') || u.searchParams.get('access_token');
    if (qt && safeEqual(qt, expected)) return true;
  } catch { /* ignore malformed URL */ }
  return false;
}

/**
 * Cron job guard. CRON_SECRET must be configured (fail closed otherwise).
 * Accepts any of:
 *   - header  x-cron-secret: <CRON_SECRET>
 *   - header  Authorization: Bearer <CRON_SECRET>   (what Vercel Cron sends)
 *   - header  x-vercel-cron                          (Vercel Cron marker)
 */
export function checkCronAuth(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return false; // fail closed
  const headers = req.headers || {};
  if (headers['x-cron-secret'] && safeEqual(headers['x-cron-secret'], secret)) return true;
  const token = bearer(req);
  if (token && safeEqual(token, secret)) return true;
  if (headers['x-vercel-cron']) return true;
  return false;
}
