// Fencely CRM — data layer (FULLY ASYNC API).
//
// Backend selection:
//   - Turso / libSQL over HTTP (src/turso.js) when TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
//     are set — or when TURSO_HTTP_URL points at any libSQL-compatible HTTP endpoint
//     (local sqld / test mock). This is the cloud (Vercel) mode.
//   - Local node:sqlite file otherwise (CRM_DB_PATH or data/crm.sqlite), wrapped behind
//     the exact same async interface. This is the local-dev / stdio-MCP mode.
//
// Call `await init()` (or `await ensureSchema()`) once before handling requests;
// every public function also lazily awaits backend readiness, so callers can't
// race schema creation. Domain behaviour (scoring, de-dupe, stages) is unchanged
// from the original synchronous version.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTursoClient } from './turso.js';
import { STAGES, NICHES, FIT_NICHES } from './config.js';

// Vocabulary comes from src/config.js (env-overridable); re-exported here so
// existing imports (`db.STAGES`, `db.NICHES`) keep working.
export { STAGES, NICHES };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data', 'crm.sqlite');

// WhatsApp honesty rule: a plain mobile is NEVER verified WhatsApp. The legacy
// label "Mobile - unverified" was renamed to "WhatsApp - unverified"; the old
// value is still accepted on input (old CSV batches) and migrated on boot.
export const WA_STATUSES = ['Advertises WhatsApp','WhatsApp - unverified','Landline only','Unknown'];
const WA_STATUS_ALIASES = { 'Mobile - unverified': 'WhatsApp - unverified' };

export function backendKind() {
  return (process.env.TURSO_HTTP_URL || (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN))
    ? 'turso'
    : 'local-sqlite';
}

// ---------------------------------------------------------------------------
// Backends — both expose { kind, query(sql,args)->rows, run(sql,args)->{changes,
// lastInsertRowid}, batch(stmts), exec([sql]) }.
// ---------------------------------------------------------------------------
async function createLocalBackend() {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const local = new DatabaseSync(DB_PATH);
  local.exec('PRAGMA journal_mode = WAL;');
  const clean = (args) => (args || []).map(a =>
    a === undefined ? null : (typeof a === 'boolean' ? (a ? 1 : 0) : a));
  const query = async (sql, args = []) => local.prepare(sql).all(...clean(args));
  const run = async (sql, args = []) => {
    const info = local.prepare(sql).run(...clean(args));
    return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
  };
  return {
    kind: 'local-sqlite',
    query,
    run,
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(s.type === 'run' ? await run(s.sql, s.args) : { rows: await query(s.sql, s.args) });
      return out;
    },
    async exec(sqlStatements) { for (const s of sqlStatements) local.exec(s); },
  };
}

const SCHEMA = [
`CREATE TABLE IF NOT EXISTS contractors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  contact_name TEXT DEFAULT '',
  state TEXT DEFAULT '',
  city TEXT DEFAULT '',
  suburb TEXT DEFAULT '',
  niches TEXT DEFAULT '[]',
  landline TEXT DEFAULT '',
  mobile TEXT DEFAULT '',
  whatsapp_number TEXT DEFAULT '',
  whatsapp_status TEXT DEFAULT 'Unknown',
  email TEXT DEFAULT '',
  website TEXT DEFAULT '',
  source TEXT DEFAULT '',
  stage TEXT DEFAULT 'New',
  lead_score INTEGER DEFAULT 0,
  score_reasons TEXT DEFAULT '[]',
  last_contacted TEXT DEFAULT '',
  next_followup TEXT DEFAULT '',
  outcome TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`,
`CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  body TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
)`,
`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER REFERENCES contractors(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_date TEXT DEFAULT '',
  done INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
)`,
`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`,
`CREATE INDEX IF NOT EXISTS idx_activities_contractor ON activities(contractor_id)`,
`CREATE INDEX IF NOT EXISTS idx_tasks_contractor ON tasks(contractor_id)`,
];

async function createSchema(backend) {
  await backend.exec(SCHEMA);
  // One-time label rename for rows written by older versions / old CSV batches.
  await backend.run(`UPDATE contractors SET whatsapp_status='WhatsApp - unverified' WHERE whatsapp_status='Mobile - unverified'`);
}

let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const backend = backendKind() === 'turso' ? createTursoClient() : await createLocalBackend();
      await createSchema(backend);
      return backend;
    })();
    // Don't cache a rejected init (e.g. transient network failure) forever.
    readyPromise.catch(() => { readyPromise = null; });
  }
  return readyPromise;
}

/** Connect + create schema. Call once at startup; safe to call repeatedly. */
export async function init() { await ready(); }
/** Alias used by the HTTP layer: ensures backend + schema exist before requests. */
export async function ensureSchema() { await ready(); }

// --- tiny internal helpers ---
async function many(sql, args = []) { const b = await ready(); return b.query(sql, args); }
async function one(sql, args = []) { const rows = await many(sql, args); return rows[0] || null; }
async function run(sql, args = []) { const b = await ready(); return b.run(sql, args); }

// --- Lead scoring: rule-based + explainable (unchanged rules) ---
export function scoreLead(c) {
  let score = 0; const reasons = [];
  const add = (pts, why) => { score += pts; reasons.push(`+${pts} ${why}`); };
  const wa = c.whatsapp_status || 'Unknown';
  if (wa === 'Advertises WhatsApp') add(25, 'Advertises WhatsApp publicly');
  else if (c.whatsapp_number) add(15, 'WhatsApp number listed');
  if (c.mobile) add(15, 'Mobile number available');
  if (c.email) add(15, 'Public email available');
  if (c.website) add(10, 'Has website');
  if (c.landline) add(5, 'Landline available');
  const niches = parseNiches(c);
  const hit = niches.filter(n => FIT_NICHES.includes(n));
  if (hit.length) add(Math.min(20, hit.length * 7), `Visual-quote fit niche(s): ${hit.join(', ')}`);
  if (niches.length >= 3) add(5, 'Multiple niches listed');
  return { score: Math.min(100, score), reasons };
}

export function parseNiches(c) {
  if (Array.isArray(c?.niches)) return c.niches;
  try { const v = JSON.parse(c?.niches || '[]'); return Array.isArray(v) ? v : []; } catch { return String(c?.niches || '').split(';').map(s => s.trim()).filter(Boolean); }
}

function row(r) {
  if (!r) return null;
  return { ...r, niches: parseNiches(r), score_reasons: safeJson(r.score_reasons), done: undefined };
}
function safeJson(v) { try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch { return []; } }

export function normalise(input = {}) {
  const waRaw = String(input.whatsapp_status || '');
  return {
    business_name: String(input.business_name || '').trim(),
    contact_name: String(input.contact_name || ''),
    state: String(input.state || '').trim().toUpperCase(),
    city: String(input.city || ''),
    suburb: String(input.suburb || ''),
    niches: parseNiches(input),
    landline: String(input.landline || ''),
    mobile: String(input.mobile || ''),
    whatsapp_number: String(input.whatsapp_number || ''),
    whatsapp_status: WA_STATUSES.includes(waRaw) ? waRaw : (WA_STATUS_ALIASES[waRaw] || 'Unknown'),
    email: String(input.email || '').trim(),
    website: String(input.website || ''),
    source: String(input.source || ''),
    stage: STAGES.includes(input.stage) ? input.stage : 'New',
    last_contacted: String(input.last_contacted || ''),
    next_followup: String(input.next_followup || ''),
    outcome: String(input.outcome || ''),
    notes: String(input.notes || ''),
  };
}

const INSERT_SQL = `INSERT INTO contractors (business_name,contact_name,state,city,suburb,niches,landline,mobile,whatsapp_number,whatsapp_status,email,website,source,stage,lead_score,score_reasons,last_contacted,next_followup,outcome,notes)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const insertValues = (c, s) => [c.business_name, c.contact_name, c.state, c.city, c.suburb, JSON.stringify(c.niches), c.landline, c.mobile, c.whatsapp_number, c.whatsapp_status, c.email, c.website, c.source, c.stage, s.score, JSON.stringify(s.reasons), c.last_contacted, c.next_followup, c.outcome, c.notes];

export async function createContractor(input) {
  const c = normalise(input);
  const s = scoreLead(c);
  const info = await run(INSERT_SQL, insertValues(c, s));
  const id = info.lastInsertRowid;
  await addActivity(id, 'created', 'Record created');
  return getContractor(id);
}

/**
 * Fast bulk insert for CSV imports. All rows are normalised + scored in
 * memory, then written through the backend's batched pipeline (a few HTTP
 * round-trips total instead of 3 per row). This is what keeps a 1,013-row
 * import under Vercel's 60s function limit. Each row still gets its
 * 'created' timeline entry, same as createContractor.
 */
export async function bulkCreateContractors(inputs) {
  const b = await ready();
  const prepared = inputs.map((input) => {
    const c = normalise(input);
    return { args: insertValues(c, scoreLead(c)) };
  });
  const BATCH = 200;
  let created = 0;
  for (let i = 0; i < prepared.length; i += BATCH) {
    const chunk = prepared.slice(i, i + BATCH);
    const rs = await b.batch(chunk.map(({ args }) => ({ sql: INSERT_SQL, args, type: 'run' })));
    const ids = rs.map((r) => r.lastInsertRowid).filter((id) => Number(id) > 0);
    if (ids.length) {
      await b.batch(
        ids.map((id) => ({
          sql: 'INSERT INTO activities (contractor_id,type,body) VALUES (?,?,?)',
          args: [Number(id), 'created', 'Record created'],
          type: 'run',
        })),
      );
    }
    created += chunk.length;
  }
  return created;
}

/** Delete many contractors (+ their activities/tasks) in batched statements. */
export async function bulkDeleteContractors(ids) {
  const b = await ready();
  const clean = [...new Set((ids || []).map(Number).filter((n) => n > 0))];
  if (!clean.length) return 0;
  let deleted = 0;
  const BATCH = 200;
  for (let i = 0; i < clean.length; i += BATCH) {
    const chunk = clean.slice(i, i + BATCH);
    const ph = chunk.map(() => '?').join(',');
    const rs = await b.batch([
      { sql: `DELETE FROM activities WHERE contractor_id IN (${ph})`, args: chunk, type: 'run' },
      { sql: `DELETE FROM tasks WHERE contractor_id IN (${ph})`, args: chunk, type: 'run' },
      { sql: `DELETE FROM contractors WHERE id IN (${ph})`, args: chunk, type: 'run' },
    ]);
    deleted += rs[2].changes || 0;
  }
  return deleted;
}

/** Move many contractors to one stage in batched statements (no per-row timeline entries). */
export async function bulkSetStage(ids, stage) {
  if (!STAGES.includes(stage)) throw new Error('Invalid stage');
  const b = await ready();
  const clean = [...new Set((ids || []).map(Number).filter((n) => n > 0))];
  if (!clean.length) return 0;
  let updated = 0;
  const BATCH = 200;
  for (let i = 0; i < clean.length; i += BATCH) {
    const chunk = clean.slice(i, i + BATCH);
    const ph = chunk.map(() => '?').join(',');
    const r = await b.run(
      `UPDATE contractors SET stage=?, updated_at=datetime('now') WHERE id IN (${ph})`,
      [stage, ...chunk],
    );
    updated += r.changes || 0;
  }
  return updated;
}

export async function getContractor(id) {
  const b = await ready();
  const [cRes, aRes, tRes] = await b.batch([
    { sql: 'SELECT * FROM contractors WHERE id=?', args: [Number(id)] },
    { sql: 'SELECT * FROM activities WHERE contractor_id=? ORDER BY id DESC', args: [Number(id)] },
    { sql: 'SELECT * FROM tasks WHERE contractor_id=? ORDER BY done, due_date', args: [Number(id)] },
  ]);
  const r = cRes.rows[0];
  if (!r) return null;
  const out = row(r);
  out.activities = aRes.rows;
  out.tasks = tRes.rows.map(t => ({ ...t, done: !!t.done }));
  return out;
}

export async function listContractors(filters = {}) {
  let rows = (await many('SELECT * FROM contractors ORDER BY lead_score DESC, business_name')).map(row);
  const q = (filters.q || '').toLowerCase();
  if (q) rows = rows.filter(r => [r.business_name, r.city, r.suburb, r.email, r.mobile, r.landline].join(' ').toLowerCase().includes(q));
  if (filters.state) rows = rows.filter(r => r.state === String(filters.state).toUpperCase());
  if (filters.city) rows = rows.filter(r => (r.city || '').toLowerCase().includes(String(filters.city).toLowerCase()));
  if (filters.niche) rows = rows.filter(r => r.niches.includes(filters.niche));
  if (filters.whatsapp_status) rows = rows.filter(r => r.whatsapp_status === filters.whatsapp_status);
  if (filters.stage) rows = rows.filter(r => r.stage === filters.stage);
  if (filters.has_email) rows = rows.filter(r => !!r.email);
  if (filters.has_mobile) rows = rows.filter(r => !!(r.mobile || r.whatsapp_number));
  return rows;
}

export async function updateContractor(id, input) {
  const existing = await getContractor(id);
  if (!existing) return null;
  const c = normalise({ ...existing, ...input });
  const s = scoreLead(c);
  await run(`UPDATE contractors SET business_name=?,contact_name=?,state=?,city=?,suburb=?,niches=?,landline=?,mobile=?,whatsapp_number=?,whatsapp_status=?,email=?,website=?,source=?,stage=?,lead_score=?,score_reasons=?,last_contacted=?,next_followup=?,outcome=?,notes=?,updated_at=datetime('now') WHERE id=?`,
    [...insertValues(c, s), Number(id)]);
  if (input.stage && input.stage !== existing.stage) await addActivity(id, 'stage', `Stage: ${existing.stage} → ${input.stage}`);
  return getContractor(id);
}

export async function deleteContractor(id) {
  await run('DELETE FROM activities WHERE contractor_id=?', [Number(id)]);
  await run('DELETE FROM tasks WHERE contractor_id=?', [Number(id)]);
  const info = await run('DELETE FROM contractors WHERE id=?', [Number(id)]);
  return info.changes > 0;
}

// --- De-dupe: same rules as before (name+city / any normalised phone / email) ---
const normPhone = v => String(v || '').replace(/\D/g, '').replace(/^61/, '0');
export function contractorsMatch(a, b) {
  if (a.email && b.email && String(a.email).toLowerCase() === String(b.email).toLowerCase()) return true;
  const ap = [a.mobile, a.whatsapp_number, a.landline].map(normPhone).filter(Boolean);
  const bp = [b.mobile, b.whatsapp_number, b.landline].map(normPhone).filter(Boolean);
  if (ap.some(p => bp.includes(p))) return true;
  if (a.business_name && b.business_name
    && String(a.business_name).toLowerCase() === String(b.business_name).toLowerCase()
    && String(a.city || '').toLowerCase() === String(b.city || '').toLowerCase()) return true;
  return false;
}

export async function findDuplicates(input, excludeId = null, preloaded = null) {
  const c = normalise(input);
  const rows = preloaded || (await many('SELECT * FROM contractors')).map(row);
  return rows.filter(r => r.id !== Number(excludeId) && contractorsMatch(c, r));
}

/** All duplicate pairs within an already-loaded row set (used by the update job). */
export function findDuplicatePairs(rows) {
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (contractorsMatch(rows[i], rows[j])) pairs.push([rows[i].id, rows[j].id]);
    }
  }
  return pairs;
}

export async function addActivity(contractorId, type, body) {
  const info = await run('INSERT INTO activities (contractor_id,type,body) VALUES (?,?,?)', [Number(contractorId), type, body || '']);
  return one('SELECT * FROM activities WHERE id=?', [info.lastInsertRowid]);
}
export async function addNote(id, body) { return addActivity(id, 'note', body); }

export async function listTasks({ dueToday = false } = {}) {
  let rows = await many(`SELECT t.*, c.business_name FROM tasks t LEFT JOIN contractors c ON c.id=t.contractor_id ORDER BY t.done, t.due_date`);
  if (dueToday) { const today = new Date().toISOString().slice(0, 10); rows = rows.filter(t => !t.done && t.due_date && t.due_date <= today); }
  return rows.map(t => ({ ...t, done: !!t.done }));
}
export async function createTask({ contractor_id, title, due_date }) {
  const info = await run('INSERT INTO tasks (contractor_id,title,due_date) VALUES (?,?,?)', [contractor_id ? Number(contractor_id) : null, title, due_date || '']);
  const t = await one('SELECT * FROM tasks WHERE id=?', [info.lastInsertRowid]);
  return t ? { ...t, done: !!t.done } : t;
}
export async function completeTask(id) { await run('UPDATE tasks SET done=1 WHERE id=?', [Number(id)]); return true; }

export async function stats() {
  const all = await listContractors();
  const today = new Date().toISOString().slice(0, 10);
  const byStage = {}; for (const s of STAGES) byStage[s] = 0;
  for (const r of all) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
  return {
    total: all.length, byStage,
    followupsDueToday: all.filter(r => r.next_followup && r.next_followup <= today && !['Customer','Do Not Contact'].includes(r.stage)).length + (await listTasks({ dueToday: true })).length,
    contacted: all.filter(r => ['Contacted','Follow-up Due','Replied','Interested','Trial/Demo','Customer'].includes(r.stage)).length,
    replied: all.filter(r => ['Replied','Interested','Trial/Demo','Customer'].includes(r.stage)).length,
    interested: all.filter(r => ['Interested','Trial/Demo','Customer'].includes(r.stage)).length,
    whatsappAdvertised: all.filter(r => r.whatsapp_status === 'Advertises WhatsApp').length,
  };
}

// ---------------------------------------------------------------------------
// Activity tracking — "who did I contact, who needs follow-up?"
// ---------------------------------------------------------------------------
export const CONTACT_CHANNELS = {
  call: 'Call made',
  whatsapp: 'WhatsApp message sent',
  email: 'Email sent',
  sms: 'SMS sent',
  other: 'Contact logged',
};

function followupDays() {
  const n = Number.parseInt(process.env.FOLLOWUP_DAYS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 4;
}

/**
 * Record an outbound contact (call / WhatsApp / email / SMS / other).
 * - stamps last_contacted = today (YYYY-MM-DD)
 * - adds a timeline activity of type "contact"
 * - stage: New/Researched/Ready to Contact → Contacted; Contacted → Follow-up Due
 *   (later stages are left untouched — a reply is just a stage move to Replied etc.)
 * - auto-creates ONE open follow-up task ("Follow up with <business_name>", due in
 *   FOLLOWUP_DAYS days, default 4) only when no open task exists for the contractor
 * Returns the updated contractor (same shape as getContractor), or null if missing.
 */
export async function logContact(id, { channel = 'other', note = '', outcome = '' } = {}) {
  const existing = await getContractor(id);
  if (!existing) return null;
  const key = CONTACT_CHANNELS[channel] ? channel : 'other';
  const today = new Date().toISOString().slice(0, 10);

  let stage = existing.stage;
  if (['New', 'Researched', 'Ready to Contact'].includes(stage)) stage = 'Contacted';
  else if (stage === 'Contacted') stage = 'Follow-up Due';

  const patch = { last_contacted: today, stage };
  if (outcome) patch.outcome = String(outcome);
  await updateContractor(id, patch);

  let bodyText = CONTACT_CHANNELS[key];
  const bits = [];
  if (outcome) bits.push(`outcome: ${outcome}`);
  if (note) bits.push(String(note));
  if (bits.length) bodyText += ` — ${bits.join(' — ')}`;
  await addActivity(id, 'contact', bodyText);

  const hasOpenTask = (existing.tasks || []).some(t => !t.done);
  if (!hasOpenTask) {
    const due = new Date(Date.now() + followupDays() * 86400000).toISOString().slice(0, 10);
    await createTask({ contractor_id: Number(id), title: `Follow up with ${existing.business_name}`, due_date: due });
  }
  return getContractor(id);
}

// --- Helpers for the scheduled update job ---
/** Overwrite score fields only (deliberately does not touch updated_at). */
export async function updateLeadScore(id, score, reasons) {
  await run('UPDATE contractors SET lead_score=?, score_reasons=? WHERE id=?', [score, JSON.stringify(reasons), Number(id)]);
}
export async function hasActivitySince(contractorId, type, withinDays) {
  const cutoff = new Date(Date.now() - withinDays * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const found = await one('SELECT id FROM activities WHERE contractor_id=? AND type=? AND created_at>=? ORDER BY id DESC LIMIT 1', [Number(contractorId), type, cutoff]);
  return !!found;
}

// --- Users (single-user auth; see src/auth.js) ---
export async function countUsers() {
  const r = await one('SELECT COUNT(*) AS n FROM users');
  return Number(r?.n || 0);
}
export async function getUserByEmail(email) {
  return one('SELECT * FROM users WHERE email=?', [String(email || '').trim().toLowerCase()]);
}
export async function createUser(email, passwordHash) {
  const normalised = String(email || '').trim().toLowerCase();
  const info = await run('INSERT INTO users (email,password_hash) VALUES (?,?)', [normalised, passwordHash]);
  return { id: info.lastInsertRowid, email: normalised };
}

// --- Seed dummy data (clearly labelled SAMPLE; content unchanged) ---
// Opt-in only: set SEED_SAMPLE_DATA=1 to seed a fresh empty database (handy
// for UI demos / local dev). Never auto-seeds in production — dummy rows in
// a real database silently pollute counts and exports.
export async function seedIfEmpty() {
  if (process.env.SEED_SAMPLE_DATA !== '1') return 0;
  const r = await one('SELECT COUNT(*) AS n FROM contractors');
  if (Number(r?.n || 0) > 0) return 0;
  const samples = [
    { business_name: 'SAMPLE Sydney Colorbond Fencing (Dummy)', state: 'NSW', city: 'Sydney', suburb: 'Parramatta', niches: ['Colorbond','Gates/Automation'], landline: '02 0000 0001', mobile: '0400 000 001', whatsapp_number: '0400 000 001', whatsapp_status: 'Advertises WhatsApp', email: 'sample1@example.invalid', website: 'https://example.invalid/sample1', source: 'SAMPLE seed data — not a real business', stage: 'Ready to Contact', notes: 'SAMPLE/dummy record for UI demo. Delete before real use.' },
    { business_name: 'SAMPLE Brisbane Pool Fencing Co (Dummy)', state: 'QLD', city: 'Brisbane', suburb: 'Paddington', niches: ['Pool Fencing','Aluminium/Slat'], mobile: '0400 000 002', whatsapp_status: 'Mobile - unverified', email: 'sample2@example.invalid', website: 'https://example.invalid/sample2', source: 'SAMPLE seed data — not a real business', stage: 'New', notes: 'SAMPLE/dummy record for UI demo.' },
    { business_name: 'SAMPLE Melbourne Timber Fences (Dummy)', state: 'VIC', city: 'Melbourne', suburb: 'Brunswick', niches: ['Timber','Retaining'], landline: '03 0000 0003', whatsapp_status: 'Landline only', source: 'SAMPLE seed data — not a real business', stage: 'Contacted', last_contacted: new Date().toISOString().slice(0,10), next_followup: new Date().toISOString().slice(0,10), notes: 'SAMPLE/dummy record for UI demo.' },
    { business_name: 'SAMPLE Perth Rural Fencing (Dummy)', state: 'WA', city: 'Perth', suburb: 'Midland', niches: ['Rural/Farm','Commercial/Security'], mobile: '0400 000 004', whatsapp_status: 'Mobile - unverified', source: 'SAMPLE seed data — not a real business', stage: 'Interested', notes: 'SAMPLE/dummy record for UI demo.' },
  ];
  for (const s of samples) await createContractor(s);
  const first = (await listContractors())[0];
  if (first) await createTask({ contractor_id: first.id, title: 'SAMPLE follow-up task (dummy)', due_date: new Date().toISOString().slice(0,10) });
  return samples.length;
}
