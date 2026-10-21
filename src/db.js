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
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTursoClient } from './turso.js';
import { normaliseSender, campaignMessage, assertCampaignContent } from './campaign-content.js';
import { campaignSlotAt, validateCampaignSchedule } from './campaign-schedule.js';
import { STAGES, NICHES, FIT_NICHES } from './config.js';
import { contractorWhatsAppNumber, VERIFICATION_LABELS } from './whatsapp.js';

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
`CREATE TABLE IF NOT EXISTS whatsapp_preparations (
 id TEXT PRIMARY KEY, city TEXT NOT NULL, region TEXT NOT NULL, target INTEGER NOT NULL,
 candidates TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'checking', token TEXT DEFAULT '',
 lease_until INTEGER DEFAULT 0, created_at TEXT NOT NULL
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_preparation_active_area ON whatsapp_preparations(city,region) WHERE status='checking'`,
`CREATE TABLE IF NOT EXISTS whatsapp_preparation_items (
 id TEXT PRIMARY KEY, preparation_id TEXT NOT NULL, contractor_id INTEGER NOT NULL,
 number TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, token TEXT DEFAULT '',
 checked_at TEXT DEFAULT '', detail TEXT DEFAULT '', UNIQUE(preparation_id,contractor_id)
)`,
`CREATE TABLE IF NOT EXISTS whatsapp_sender_health (
 id INTEGER PRIMARY KEY CHECK(id=1), reported_at INTEGER NOT NULL,
 gateway TEXT NOT NULL, pending INTEGER NOT NULL, error TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS whatsapp_campaign_approvals (
 id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, revision INTEGER NOT NULL,
 approved_by TEXT NOT NULL, approved_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS whatsapp_dispatch (
 id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, contractor_id INTEGER NOT NULL,
 number TEXT NOT NULL, message TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
 token TEXT DEFAULT '', lease_until INTEGER DEFAULT 0, attempt_at INTEGER DEFAULT 0,
 slot_key TEXT DEFAULT '', message_id TEXT DEFAULT '', detail TEXT DEFAULT '',
 confirmed_at TEXT DEFAULT '', UNIQUE(campaign_id,contractor_id)
)`,
`CREATE TABLE IF NOT EXISTS whatsapp_sender_guard (
 id INTEGER PRIMARY KEY CHECK(id=1), token TEXT DEFAULT '', lease_until INTEGER DEFAULT 0,
 last_attempt INTEGER DEFAULT 0
)`,
`INSERT INTO whatsapp_sender_guard(id) VALUES(1) ON CONFLICT DO NOTHING`,
`CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule TEXT NOT NULL,
  drafts TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL
)`,
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
`CREATE TABLE IF NOT EXISTS whatsapp_checks (
  contractor_id INTEGER PRIMARY KEY REFERENCES contractors(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  detail TEXT NOT NULL,
  jid TEXT DEFAULT ''
)`,
`CREATE TABLE IF NOT EXISTS whatsapp_check_jobs (
  id TEXT PRIMARY KEY,
  contractor_id INTEGER NOT NULL UNIQUE REFERENCES contractors(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  token TEXT DEFAULT '',
  lease_until INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS whatsapp_suppressions (
  number TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS whatsapp_inbox (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  number TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id,message_id)
)`,
`CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_number ON whatsapp_inbox(number)`,
`CREATE TABLE IF NOT EXISTS whatsapp_inbox_targets (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  PRIMARY KEY(session_id,message_id,contractor_id)
)`,
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
  const verification = r.wa_check_status && r.wa_check_number === (contractorWhatsAppNumber(r) || '')
    ? { status: r.wa_check_status, number: r.wa_check_number, checked_at: r.wa_checked_at, detail: r.wa_check_detail }
    : { status: 'not_checked', number: contractorWhatsAppNumber(r) || '', checked_at: '', detail: '' };
  return { ...r, whatsapp_verification: verification, niches: parseNiches(r), score_reasons: safeJson(r.score_reasons), done: undefined };
}

const CONTRACTOR_SELECT = `SELECT c.*, w.status AS wa_check_status, w.number AS wa_check_number,
  w.checked_at AS wa_checked_at, w.detail AS wa_check_detail FROM contractors c
  LEFT JOIN whatsapp_checks w ON w.contractor_id=c.id`;

export async function saveWhatsAppCheck(id, result) {
  if (!(result.status in VERIFICATION_LABELS) || result.status === 'not_checked') throw new Error('Invalid verification status');
  const current = await getContractor(id);
  if (!current || (contractorWhatsAppNumber(current) || '') !== result.number) {
    const error = new Error('Contractor number changed during the check. Please retry.');
    error.statusCode = 409;
    throw error;
  }
  await run(`INSERT INTO whatsapp_checks (contractor_id,number,status,checked_at,detail,jid) VALUES (?,?,?,?,?,?)
    ON CONFLICT(contractor_id) DO UPDATE SET number=excluded.number,status=excluded.status,
    checked_at=excluded.checked_at,detail=excluded.detail,jid=excluded.jid`,
    [Number(id), result.number, result.status, result.checked_at, result.detail, result.jid || '']);
  await addActivity(id, 'whatsapp-check', `${VERIFICATION_LABELS[result.status]}: ${result.number || 'No valid number'}. ${result.detail}`);
  return getContractor(id);
}

// Atomic SQL leases work across separate Vercel function instances. Only
// registration reads are retried; this queue cannot send WhatsApp messages.
export async function queueWhatsAppCheck(c) {
  const number = contractorWhatsAppNumber(c);
  if (!number) throw new Error('Invalid number');
  await run(`INSERT INTO whatsapp_check_jobs (id,contractor_id,number,created_at) VALUES (?,?,?,?)
    ON CONFLICT(contractor_id) DO UPDATE SET id=excluded.id,number=excluded.number,
    state='queued',token='',lease_until=0,created_at=excluded.created_at
    WHERE whatsapp_check_jobs.state='done' OR whatsapp_check_jobs.number<>excluded.number`,
    [randomUUID(), c.id, number, Date.now()]);
}

export async function claimWhatsAppCheck(now = Date.now()) {
  const jobs = await many(`UPDATE whatsapp_check_jobs SET state='running',token=?,lease_until=?
    WHERE id=(SELECT id FROM whatsapp_check_jobs WHERE state='queued'
      OR (state IN ('running','completing') AND lease_until<?) ORDER BY created_at LIMIT 1)
    RETURNING id,contractor_id,number,token`, [randomUUID(), now + 120000, now]);
  return jobs[0] || null;
}

export async function finishWhatsAppCheck(id, token, result) {
  const job = await one('SELECT * FROM whatsapp_check_jobs WHERE id=?', [id]);
  const conflict = () => { const e = new Error('Check lease expired or superseded'); e.statusCode = 409; return e; };
  if (!job || !token || job.token !== token) throw conflict();
  if (job.state === 'done') return { ok: true }; // retry after a lost HTTP response
  const claimed = await run(`UPDATE whatsapp_check_jobs SET state='completing'
    WHERE id=? AND token=? AND state='running' AND lease_until>=?`, [id, token, Date.now()]);
  if (!claimed.changes) throw conflict();
  try {
    if (result.number !== job.number) throw conflict();
    await saveWhatsAppCheck(job.contractor_id, result);
    await run("UPDATE whatsapp_check_jobs SET state='done' WHERE id=? AND token=?", [id, token]);
    return { ok: true };
  } catch (e) {
    await run("UPDATE whatsapp_check_jobs SET state='queued',token='',lease_until=0 WHERE id=? AND token=?", [id, token]);
    throw e;
  }
}


export async function getWhatsAppOutreachState(number) {
  const state = await one(`SELECT
    EXISTS(SELECT 1 FROM whatsapp_suppressions WHERE number=?) AS suppressed,
    EXISTS(SELECT 1 FROM whatsapp_inbox WHERE number=?) AS followup_paused`, [number || '', number || '']);
  return { suppressed: !!state.suppressed, followup_paused: !!state.followup_paused };
}

export async function recordWhatsAppReply(event) {
  const { session_id, message_id, number, text, kind, received_at } = event;
  // Suppression is number-wide and durable, including STOP from unknown leads.
  // Persist it first. Every subsequent stage UPDATE consults this table in SQL,
  // so concurrent/late ordinary replies can never undo an opt-out.
  if (kind === 'stop') await run(`INSERT INTO whatsapp_suppressions (number,reason,created_at)
    VALUES (?,'WhatsApp opt-out',?) ON CONFLICT(number) DO NOTHING`, [number, received_at]);
  const matches = (await many('SELECT id,whatsapp_number,mobile,landline FROM contractors'))
    .filter(c => contractorWhatsAppNumber(c) === number);
  if (!matches.length && kind !== 'stop') return { ok: true, ignored: true };
  await run(`INSERT INTO whatsapp_inbox (session_id,message_id,number,text,kind,received_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,message_id) DO NOTHING`,
    [session_id, message_id, number, text, kind, received_at]);
  const stored = await one('SELECT * FROM whatsapp_inbox WHERE session_id=? AND message_id=?', [session_id, message_id]);
  if (stored.number !== number || stored.text !== text || stored.kind !== kind) {
    const e = new Error('Conflicting message ID'); e.statusCode = 409; throw e;
  }
  if (stored.processed) return { ok: true, duplicate: true };
  for (const c of matches) {
    // Each operation is idempotent. The inbox acts as a durable receipt; retries
    // resume incomplete work instead of duplicating the timeline or undoing STOP.
    await run(`INSERT INTO whatsapp_inbox_targets (session_id,message_id,contractor_id)
      SELECT ?,?,id FROM contractors WHERE id=? ON CONFLICT DO NOTHING`, [session_id, message_id, c.id]);
    await run(`UPDATE contractors SET stage=CASE
      WHEN stage='Do Not Contact' OR EXISTS(SELECT 1 FROM whatsapp_suppressions WHERE number=?) THEN 'Do Not Contact'
      WHEN ?='interested' AND stage NOT IN ('Trial/Demo','Customer') THEN 'Interested'
      WHEN stage IN ('New','Researched','Ready to Contact','Contacted','Follow-up Due') THEN 'Replied'
      ELSE stage END,next_followup='',updated_at=datetime('now') WHERE id=?`, [number, kind, c.id]);
    await run(`UPDATE tasks SET done=1 WHERE contractor_id=? AND done=0
      AND title LIKE 'Follow up with %'`, [c.id]);
  }
  await run('UPDATE whatsapp_inbox SET processed=1 WHERE session_id=? AND message_id=?', [session_id, message_id]);
  return { ok: true, matched: matches.length };
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
      { sql: `DELETE FROM whatsapp_inbox_targets WHERE contractor_id IN (${ph})`, args: chunk, type: 'run' },
      { sql: `DELETE FROM whatsapp_check_jobs WHERE contractor_id IN (${ph})`, args: chunk, type: 'run' },
      { sql: `DELETE FROM whatsapp_checks WHERE contractor_id IN (${ph})`, args: chunk, type: 'run' },
      { sql: `DELETE FROM activities WHERE contractor_id IN (${ph})`, args: chunk, type: 'run' },
      { sql: `DELETE FROM tasks WHERE contractor_id IN (${ph})`, args: chunk, type: 'run' },
      { sql: `DELETE FROM contractors WHERE id IN (${ph})`, args: chunk, type: 'run' },
    ]);
    deleted += rs[5].changes || 0;
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
  const [cRes, aRes, tRes, inboxRes, dispatchRes] = await b.batch([
    { sql: `${CONTRACTOR_SELECT} WHERE c.id=?`, args: [Number(id)] },
    { sql: 'SELECT * FROM activities WHERE contractor_id=? ORDER BY id DESC', args: [Number(id)] },
    { sql: 'SELECT * FROM tasks WHERE contractor_id=? ORDER BY done, due_date', args: [Number(id)] },
    { sql: `SELECT i.* FROM whatsapp_inbox i JOIN whatsapp_inbox_targets t
      ON i.session_id=t.session_id AND i.message_id=t.message_id WHERE t.contractor_id=? ORDER BY i.received_at DESC`, args: [Number(id)] },
    { sql: "SELECT * FROM whatsapp_dispatch WHERE contractor_id=? AND state='sent' ORDER BY confirmed_at DESC", args: [Number(id)] },
  ]);
  const r = cRes.rows[0];
  if (!r) return null;
  const out = row(r);
  out.activities = [...aRes.rows, ...dispatchRes.rows.map(d => ({
    id: `dispatch:${d.id}`, contractor_id: Number(id), type: 'whatsapp-sent',
    body: d.message, created_at: d.confirmed_at,
  })), ...inboxRes.rows.map(i => ({
    id: `wa:${i.session_id}:${i.message_id}`, contractor_id: Number(id),
    type: i.kind === 'stop' ? 'whatsapp-opt-out' : i.kind === 'interested' ? 'whatsapp-interested' : 'whatsapp-reply',
    body: i.text || '[Non-text WhatsApp reply]', created_at: i.received_at,
  }))].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  out.whatsapp_outreach = await getWhatsAppOutreachState(contractorWhatsAppNumber(r));
  out.tasks = tRes.rows.map(t => ({ ...t, done: !!t.done }));
  return out;
}

export async function listContractors(filters = {}) {
  let rows = (await many(`${CONTRACTOR_SELECT} ORDER BY c.lead_score DESC, c.business_name`)).map(row);
  const q = (filters.q || '').toLowerCase();
  if (q) rows = rows.filter(r => [r.business_name, r.city, r.suburb, r.email, r.mobile, r.landline].join(' ').toLowerCase().includes(q));
  if (filters.state) rows = rows.filter(r => r.state === String(filters.state).toUpperCase());
  if (filters.city) rows = rows.filter(r => (r.city || '').toLowerCase().includes(String(filters.city).toLowerCase()));
  if (filters.niche) rows = rows.filter(r => r.niches.includes(filters.niche));
  if (filters.whatsapp_status) rows = rows.filter(r => r.whatsapp_status === filters.whatsapp_status);
  if (filters.whatsapp_verification) rows = rows.filter(r => r.whatsapp_verification.status === filters.whatsapp_verification);
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
  await run('DELETE FROM whatsapp_inbox_targets WHERE contractor_id=?', [Number(id)]);
  await run('DELETE FROM whatsapp_check_jobs WHERE contractor_id=?', [Number(id)]);
  await run('DELETE FROM whatsapp_checks WHERE contractor_id=?', [Number(id)]);
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


// A campaign is saved atomically as one revision. MCP can save drafts, never start sends.
function campaignError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
export async function getCampaign(id) {
  const row = await one('SELECT * FROM whatsapp_campaigns WHERE id=?', [String(id)]);
  if (!row) throw campaignError('Campaign not found.', 404);
  const drafts = JSON.parse(row.drafts);
  return { ...row, schedule: JSON.parse(row.schedule), sender: drafts[0]?.sender || { name: '', business: 'Fencely', contact: '' }, drafts,
    deliveries: await many('SELECT id,contractor_id,state,detail,message_id,confirmed_at FROM whatsapp_dispatch WHERE campaign_id=? ORDER BY id', [String(id)]) };
}
export async function listCampaigns() {
  return (await many('SELECT id,name,state,revision,created_at FROM whatsapp_campaigns ORDER BY created_at DESC'));
}
export async function saveCampaignDrafts(input) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) throw campaignError('Campaign name must be 1–120 characters.');
  let schedule;
  try { schedule = validateCampaignSchedule(input.schedule); }
  catch (e) { throw campaignError(e.message); }
  if (!Array.isArray(input.drafts) || !input.drafts.length || input.drafts.length > 20)
    throw campaignError('Save between 1 and 20 reviewed drafts.');
  let sender;
  try { sender = normaliseSender(input.sender); } catch (e) { throw campaignError(e.message); }
  const ids = new Set(), numbers = new Set(), drafts = [];
  for (const draft of input.drafts) {
    if (!Number.isSafeInteger(draft.contractor_id) || draft.contractor_id < 1 || ids.has(draft.contractor_id))
      throw campaignError('Each draft must have a different valid contractor ID.');
    if (typeof draft.message !== 'string' || !draft.message.trim() || draft.message.length > 4000)
      throw campaignError('Each message must be 1–4000 characters.');
    const c = await getContractor(draft.contractor_id);
    if (!c) throw campaignError('A selected contractor no longer exists.');
    const number = contractorWhatsAppNumber(c);
    if (!number || numbers.has(number)) throw campaignError('Missing, invalid or duplicate recipient number.');
    const outreach = await getWhatsAppOutreachState(number);
    if (c.stage === 'Do Not Contact' || outreach.suppressed || outreach.followup_paused)
      throw campaignError('A selected recipient opted out or has already replied. Remove them from this campaign.');
    const permission = draft.permission || {};
    if ((permission.basis && !['test','express','inferred'].includes(permission.basis)) ||
      (permission.note !== undefined && (typeof permission.note !== 'string' || permission.note.length > 1000)))
      throw campaignError('Invalid recipient permission record.');
    ids.add(c.id); numbers.add(number);
    drafts.push({ contractor_id: c.id, business_name: c.business_name, number,
      message: draft.message.trim(), status: 'draft', sender,
      permission: { basis: permission.basis || '', note: (permission.note || '').trim(), recorded_at: new Date().toISOString() } });
  }
  if (input.id) {
    if (!Number.isSafeInteger(input.revision)) throw campaignError('Reload the campaign before editing.', 409);
    const result = await run(`UPDATE whatsapp_campaigns SET name=?,schedule=?,drafts=?,revision=revision+1
      WHERE id=? AND revision=? AND state='draft'`,
      [name, JSON.stringify(schedule), JSON.stringify(drafts), String(input.id), input.revision]);
    if (!result.changes) throw campaignError('Campaign changed. Reload before saving.', 409);
    return getCampaign(input.id);
  }
  const id = randomUUID();
  await run('INSERT INTO whatsapp_campaigns(id,name,schedule,drafts,created_at) VALUES(?,?,?,?,?)',
    [id, name, JSON.stringify(schedule), JSON.stringify(drafts), new Date().toISOString()]);
  return getCampaign(id);
}


// Dispatch capabilities are separate from the read-only registration bridge.
export function senderMode() {
  return ['test', 'live'].includes(process.env.WA_SEND_MODE) &&
    (process.env.WA_SENDER_SECRET || '').length >= 32 ? process.env.WA_SEND_MODE : 'disabled';
}
function allowedSendNumber(number) {
  return senderMode() === 'live' || (senderMode() === 'test' &&
    (process.env.WA_SENDER_TEST_NUMBERS || '').split(',').map(n => n.trim().replace(/^\+/, '')).includes(number));
}
export async function startCampaign(id, revision, consentConfirmed, approvedBy = 'CRM user') {
  if (senderMode() === 'disabled') throw campaignError('Sender setup is not enabled yet.', 503);
  if (consentConfirmed !== true) throw campaignError('Confirm recipient permission before starting.');
  const c = await getCampaign(id);
  if (c.revision !== revision) throw campaignError('Campaign changed. Reload before starting.', 409);
  if (!['draft', 'paused', 'starting'].includes(c.state)) throw campaignError('Campaign is already running or complete.', 409);
  // Revalidate recipients and immutable snapshots. A new batch is needed after a phone change.
  for (const d of c.drafts) {
    const lead = await getContractor(d.contractor_id);
    if (!lead || contractorWhatsAppNumber(lead) !== d.number) throw campaignError('Recipient changed or was deleted.');
    if (!allowedSendNumber(d.number)) throw campaignError('Test mode permits only your configured test numbers.');
    try { assertCampaignContent(d, senderMode()); } catch (e) { throw campaignError(e.message); }
  }
  const started = await run("UPDATE whatsapp_campaigns SET state='starting' WHERE id=? AND revision=? AND state IN ('draft','paused')", [id, revision]);
  if (!started.changes && c.state !== 'starting') throw campaignError('Campaign changed. Reload before starting.', 409);
  await run('INSERT INTO whatsapp_campaign_approvals(id,campaign_id,revision,approved_by,approved_at) VALUES(?,?,?,?,?)',
    [randomUUID(), id, revision, approvedBy, new Date().toISOString()]);
  for (const d of c.drafts) {
    await run(`INSERT INTO whatsapp_dispatch(id,campaign_id,contractor_id,number,message)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM whatsapp_campaigns WHERE id=? AND revision=? AND state='starting')
      ON CONFLICT(campaign_id,contractor_id) DO NOTHING`,
      [`${id}:${d.contractor_id}`, id, d.contractor_id, d.number, campaignMessage(d), id, revision]);
  }
  await run("UPDATE whatsapp_campaigns SET state='running' WHERE id=? AND revision=? AND state='starting'", [id, revision]);
  return getCampaign(id);
}
export async function pauseCampaign(id) {
  await run("UPDATE whatsapp_campaigns SET state='paused' WHERE id=? AND state IN ('starting','running')", [id]);
  return getCampaign(id);
}
async function dispatchEligible(job) {
  const lead = await getContractor(job.contractor_id);
  if (!lead || contractorWhatsAppNumber(lead) !== job.number) return 'Recipient changed or deleted';
  const flags = await getWhatsAppOutreachState(job.number);
  if (lead.stage === 'Do Not Contact' || flags.suppressed || flags.followup_paused) return 'Recipient opted out or replied';
  if (!allowedSendNumber(job.number)) return 'Recipient is outside test allowlist';
  const campaign = await getCampaign(job.campaign_id);
  const draft = campaign.drafts.find(d => d.contractor_id === job.contractor_id);
  try {
    if (!draft || assertCampaignContent(draft, senderMode()) !== job.message) return 'Message needs a new reviewed draft with sender and permission details';
  } catch { return 'Message needs sender identity and recipient permission details'; }
  const previous = await one("SELECT id FROM whatsapp_dispatch WHERE number=? AND id<>? AND state IN ('sending','sent','uncertain') LIMIT 1", [job.number, job.id]);
  return previous ? 'Number already attempted in another campaign' : '';
}
export async function claimDispatch(now = Date.now()) {
  if (senderMode() === 'disabled') return null;
  const health = await getSenderHealth(now);
  if (!health.ready) return null;
  // No new work while a gateway attempt awaits its durable receipt.
  if (await one("SELECT id FROM whatsapp_dispatch WHERE state='sending' LIMIT 1")) return null;
  const token = randomUUID();
  const lock = await run(`UPDATE whatsapp_sender_guard SET token=?,lease_until=?
    WHERE id=1 AND lease_until<=? AND last_attempt<=?`, [token, now + 120000, now, now - 2160000]);
  if (!lock.changes) return null;
  // Only checking leases can expire. A send with an unknown outcome is NEVER requeued.
  await run("UPDATE whatsapp_dispatch SET state='queued',token='',lease_until=0 WHERE state='checking' AND lease_until<=?", [now]);
  const campaigns = await many("SELECT * FROM whatsapp_campaigns WHERE state='running' ORDER BY created_at,id");
  for (const c of campaigns) {
    const slot = campaignSlotAt(now, JSON.parse(c.schedule));
    if (!slot) continue;
    const used = await one('SELECT COUNT(*) AS n FROM whatsapp_dispatch WHERE campaign_id=? AND slot_key=? AND attempt_at>0', [c.id, slot.key]);
    if (used.n) continue;
    const jobs = await many("SELECT * FROM whatsapp_dispatch WHERE campaign_id=? AND state='queued' ORDER BY id", [c.id]);
    for (const job of jobs) {
      const reason = await dispatchEligible(job);
      if (reason) {
        await run("UPDATE whatsapp_dispatch SET state='skipped',detail=? WHERE id=? AND state='queued'", [reason, job.id]);
        continue;
      }
      const claimed = await run(`UPDATE whatsapp_dispatch SET state='checking',token=?,lease_until=?
        WHERE id=? AND state='queued' AND EXISTS(SELECT 1 FROM whatsapp_campaigns WHERE id=? AND state='running')
        AND EXISTS(SELECT 1 FROM whatsapp_sender_guard WHERE id=1 AND token=? AND lease_until>?)`,
        [token, now + 120000, job.id, c.id, token, now]);
      if (claimed.changes) return { id: job.id, token, number: job.number };
    }
    await run(`UPDATE whatsapp_campaigns SET state='complete' WHERE id=? AND state='running'
      AND NOT EXISTS(SELECT 1 FROM whatsapp_dispatch WHERE campaign_id=? AND state IN ('queued','checking','sending'))`, [c.id, c.id]);
  }
  await run('UPDATE whatsapp_sender_guard SET lease_until=0 WHERE id=1 AND token=?', [token]);
  return null;
}
export async function authorizeDispatch(input, now = Date.now()) {
  const job = await one("SELECT * FROM whatsapp_dispatch WHERE id=? AND token=? AND state='checking' AND lease_until>?", [input.id, input.token, now]);
  if (!job) throw campaignError('Dispatch lease expired or already consumed.', 409);
  const snapshot = await getContractor(job.contractor_id);
  const c = await getCampaign(job.campaign_id);
  const slot = campaignSlotAt(now, c.schedule);
  let reason = await dispatchEligible(job);
  if (!(await getSenderHealth(now)).ready) reason = 'Sender or WhatsApp health is not ready';
  if (c.state !== 'running' || !slot) reason = 'Campaign paused or outside its window';
  if (!['available','not_found','check_failed'].includes(input.registration)) throw campaignError('Invalid registration result.');
  if (!reason) await saveWhatsAppCheck(job.contractor_id, { number: job.number, status: input.registration,
    checked_at: new Date(now).toISOString(), detail: input.registration === 'available' ? 'Registration found immediately before scheduled send.' : 'Pre-send check did not confirm registration. No message sent.', jid: '' });
  if (input.registration !== 'available') reason = 'Registration not confirmed; no message sent';
  if (reason) {
    await run("UPDATE whatsapp_dispatch SET state='skipped',detail=? WHERE id=? AND token=? AND state='checking'", [reason, job.id, job.token]);
    await run('UPDATE whatsapp_sender_guard SET lease_until=0 WHERE id=1 AND token=?', [job.token]);
    return { send: false, reason };
  }
  // Serialize every permit globally, with a 36-minute gap and a rolling 24-hour cap.
  // Reservations consume capacity even if the following request is interrupted.
  const permit = await run(`UPDATE whatsapp_sender_guard SET last_attempt=?,lease_until=?
    WHERE id=1 AND token=? AND lease_until>? AND last_attempt<=?
    AND (SELECT COUNT(*) FROM whatsapp_dispatch WHERE attempt_at>?)<20
    AND NOT EXISTS(SELECT 1 FROM whatsapp_dispatch WHERE campaign_id=? AND slot_key=? AND attempt_at>0)`,
    [now, now + 120000, job.token, now, now - 2160000, now - 86400000, job.campaign_id, slot.key]);
  if (!permit.changes) throw campaignError('Send capacity unavailable.', 409);
  const result = await run(`UPDATE whatsapp_dispatch SET state='sending',attempt_at=?,slot_key=?
    WHERE id=? AND token=? AND state='checking'
    AND EXISTS(SELECT 1 FROM whatsapp_campaigns WHERE id=? AND state='running')
    AND NOT EXISTS(SELECT 1 FROM whatsapp_suppressions WHERE number=?)
    AND NOT EXISTS(SELECT 1 FROM whatsapp_inbox WHERE number=?)
    AND EXISTS(SELECT 1 FROM contractors WHERE id=? AND whatsapp_number=? AND mobile=? AND landline=? AND stage<>'Do Not Contact')`,
    [now, slot.key, job.id, job.token, job.campaign_id, job.number, job.number,
      job.contractor_id, snapshot.whatsapp_number, snapshot.mobile, snapshot.landline]);
  if (!result.changes) throw campaignError('Send cancelled by campaign or recipient change.', 409);
  return { send: true, id: job.id, token: job.token, number: job.number, message: job.message, expires_at: now + 10000 };
}
export async function finishDispatch(input, now = Date.now()) {
  const job = await one('SELECT * FROM whatsapp_dispatch WHERE id=? AND token=?', [input.id, input.token]);
  if (!job) throw campaignError('Unknown dispatch receipt.', 409);
  if (!['sent','uncertain'].includes(input.status)) throw campaignError('Invalid dispatch outcome.');
  if (input.status === 'sent' && (typeof input.message_id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.message_id)))
    throw campaignError('Gateway message ID required.');
  if (input.status === 'uncertain' && !job.attempt_at && ['checking','skipped'].includes(job.state)) {
    await run("UPDATE whatsapp_dispatch SET state='skipped',detail='No send permit consumed' WHERE id=? AND token=? AND attempt_at=0", [job.id, job.token]);
    await run('UPDATE whatsapp_sender_guard SET lease_until=0 WHERE id=1 AND token=?', [job.token]);
    return { ok: true, not_sent: true };
  }
  if (['sent','uncertain'].includes(job.state)) {
    if (job.state !== input.status || (job.state === 'sent' && job.message_id !== input.message_id))
      throw campaignError('Conflicting dispatch outcome.', 409);
  } else {
    if (job.state !== 'sending') throw campaignError('Dispatch was never authorized.', 409);
    await run(`UPDATE whatsapp_dispatch SET state=?,message_id=?,confirmed_at=?,detail=? WHERE id=? AND token=? AND state='sending'`,
      [input.status, input.status === 'sent' ? input.message_id : '', new Date(now).toISOString(),
        input.status === 'sent' ? 'Gateway accepted; delivery/read not confirmed' : 'Outcome unknown. Do not resend automatically.', job.id, job.token]);
  }
  const stored = await one('SELECT state,message_id FROM whatsapp_dispatch WHERE id=?', [job.id]);
  if (stored.state !== input.status || (stored.state === 'sent' && stored.message_id !== input.message_id))
    throw campaignError('Conflicting dispatch outcome.', 409);
  if (input.status === 'sent') {
    // Idempotent reconciliation; never undo a reply/STOP arriving during the send.
    await run(`UPDATE contractors SET last_contacted=CASE WHEN last_contacted>? THEN last_contacted ELSE ? END,
      stage=CASE WHEN stage='Do Not Contact' OR EXISTS(SELECT 1 FROM whatsapp_suppressions WHERE number=?) THEN 'Do Not Contact'
      WHEN EXISTS(SELECT 1 FROM whatsapp_inbox WHERE number=?) THEN stage
      WHEN stage IN ('New','Researched','Ready to Contact') THEN 'Contacted' ELSE stage END,
      updated_at=datetime('now') WHERE id=?`,
      [job.confirmed_at ? job.confirmed_at.slice(0,10) : new Date(now).toISOString().slice(0,10),
        job.confirmed_at ? job.confirmed_at.slice(0,10) : new Date(now).toISOString().slice(0,10), job.number, job.number, job.contractor_id]);
  } else await pauseCampaign(job.campaign_id);
  await run(`UPDATE whatsapp_campaigns SET state='complete' WHERE id=? AND state='running'
    AND NOT EXISTS(SELECT 1 FROM whatsapp_dispatch WHERE campaign_id=? AND state IN ('queued','checking','sending'))`, [job.campaign_id, job.campaign_id]);
  await run('UPDATE whatsapp_sender_guard SET lease_until=0 WHERE id=1 AND token=?', [job.token]);
  return { ok: true };
}


export async function recordSenderHeartbeat(input, now = Date.now()) {
  if (!['connected','disconnected','unknown'].includes(input.gateway) || typeof input.pending !== 'boolean' ||
      !['none','crm_error','worker_error'].includes(input.error || 'none')) throw campaignError('Invalid sender heartbeat.');
  await run(`INSERT INTO whatsapp_sender_health(id,reported_at,gateway,pending,error) VALUES(1,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET reported_at=excluded.reported_at,gateway=excluded.gateway,pending=excluded.pending,error=excluded.error`,
    [now, input.gateway, input.pending, input.error || 'none']);
  return { ok: true };
}
export async function getSenderHealth(now = Date.now()) {
  const row = await one('SELECT * FROM whatsapp_sender_health WHERE id=1');
  const fresh = !!row && now - row.reported_at <= 180000 && row.reported_at <= now + 10000;
  const pending = await one("SELECT MIN(attempt_at) AS oldest FROM whatsapp_dispatch WHERE state='sending'");
  const alerts = [];
  if (!row) alerts.push('Sender has not reported status. Install or update the VPS worker.');
  else if (!fresh) alerts.push('Sender has not reported for more than 3 minutes. Check the VPS service or connection.');
  if (fresh && row.gateway !== 'connected') alerts.push(row.gateway === 'disconnected' ? 'WhatsApp session is disconnected. Check the gateway.' : 'WhatsApp connection could not be verified.');
  if (fresh && row.error !== 'none') alerts.push('The sender reported a processing error. Check its VPS logs.');
  if (row?.pending || pending?.oldest) alerts.push('A send receipt is pending. Do not resend; the worker will retry the CRM acknowledgement.');
  return { reported_at: row?.reported_at || null, gateway: fresh ? row.gateway : 'unknown', fresh,
    ready: fresh && row.gateway === 'connected' && row.error === 'none' && !row.pending,
    alerts, awaiting_receipt: !!pending?.oldest };
}


// Read-only WhatsApp list building. This queue never authorizes outbound messages.
async function preparationExcludedNumbers() {
  const rows = await many(`SELECT number FROM whatsapp_suppressions UNION SELECT number FROM whatsapp_inbox
    UNION SELECT number FROM whatsapp_dispatch WHERE state IN ('sending','sent','uncertain')`);
  return new Set(rows.map(r => r.number));
}
export async function createWhatsAppPreparation(input = {}) {
  const all = input.scope === 'all';
  const city = all ? '*' : typeof input.city === 'string' ? input.city.trim().toLowerCase() : '';
  const region = all ? '' : typeof input.state === 'string' ? input.state.trim().toUpperCase() : '';
  const target = all ? 2147483647 : input.target ?? 20;
  if (!city || city.length > 100 || (region && !/^[A-Z]{2,3}$/.test(region)) ||
      !Number.isInteger(target) || target < 1 || (!all && target > 20)) throw campaignError('Choose a city and a target between 1 and 20.');
  const existing = await one("SELECT id FROM whatsapp_preparations WHERE city=? AND region=? AND status='checking'", [city, region]);
  if (existing) return getWhatsAppPreparation(existing.id);
  // Deliberately no phone-type, WhatsApp-status, has-mobile or registration filters.
  const candidates = await many(`SELECT id FROM contractors WHERE (?='*' OR instr(lower(city),?)>0)
    AND (?='' OR upper(state)=? OR state='') ORDER BY id`, [city, city, region, region]);
  const id = randomUUID();
  await run(`INSERT INTO whatsapp_preparations(id,city,region,target,candidates,created_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`, [id, city, region, target, JSON.stringify(candidates.map(c => c.id)), new Date().toISOString()]);
  const actual = await one("SELECT id FROM whatsapp_preparations WHERE city=? AND region=? AND status='checking'", [city, region]);
  return getWhatsAppPreparation(actual?.id || id);
}
export async function listWhatsAppPreparations() {
  return many('SELECT id,city,region,target,status,created_at FROM whatsapp_preparations ORDER BY created_at DESC');
}
export async function getWhatsAppPreparation(id) {
  const prep = await one('SELECT * FROM whatsapp_preparations WHERE id=?', [String(id)]);
  if (!prep) throw campaignError('Preparation not found.', 404);
  const excluded = await preparationExcludedNumbers();
  const items = await many(`SELECT i.*,c.business_name,c.city,c.state,c.mobile,c.whatsapp_number,c.landline,c.stage
    FROM whatsapp_preparation_items i LEFT JOIN contractors c ON c.id=i.contractor_id WHERE preparation_id=? ORDER BY i.rowid`, [prep.id]);
  for (const item of items) {
    if (item.status === 'available' && (!item.business_name || contractorWhatsAppNumber(item) !== item.number || item.stage === 'Do Not Contact' || excluded.has(item.number))) {
      await run("UPDATE whatsapp_preparation_items SET status='stale',detail='Number changed, lead removed, replied, opted out or previously attempted' WHERE id=? AND status='available'", [item.id]);
      item.status = 'stale';
    }
  }
  const available = items.filter(i => i.status === 'available');
  const candidates = JSON.parse(prep.candidates);
  // A completed list invalidated later is reported as short; request a fresh list if necessary.
  const status = prep.city !== '*' && available.length >= prep.target ? 'ready' : items.length >= candidates.length && !items.some(i => ['checking','completing'].includes(i.status)) ? 'exhausted' : prep.status === 'ready' ? 'needs_refresh' : 'checking';
  if (status !== prep.status && status !== 'needs_refresh') await run('UPDATE whatsapp_preparations SET status=? WHERE id=?', [status, prep.id]);
  return { id: prep.id, scope: prep.city === '*' ? 'all' : 'city', city: prep.city, state: prep.region, target: prep.target, status,
    total_candidates: candidates.length, processed: items.filter(i => !['checking','completing'].includes(i.status)).length,
    available_count: available.length, available: available.map(i => ({ contractor_id: i.contractor_id,
      business_name: i.business_name, city: i.city, state: i.state, number: i.number, checked_at: i.checked_at })),
    results: items.map(i => ({ contractor_id: i.contractor_id, business_name: i.business_name || 'Deleted lead',
      city: i.city, state: i.state, number: i.number, status: i.status, detail: i.detail })), created_at: prep.created_at };
}
export async function claimWhatsAppPreparation(now = Date.now()) {
  const token = randomUUID();
  const rows = await many(`UPDATE whatsapp_preparations SET token=?,lease_until=?
    WHERE id=(SELECT id FROM whatsapp_preparations WHERE status='checking' AND lease_until<=? ORDER BY created_at,id LIMIT 1)
    RETURNING *`, [token, now + 120000, now]);
  const prep = rows[0];
  if (!prep) return null;
  const summary = await getWhatsAppPreparation(prep.id);
  if (summary.status !== 'checking') {
    await run('UPDATE whatsapp_preparations SET lease_until=0 WHERE id=? AND token=?', [prep.id, token]);
    return null;
  }
  const candidates = JSON.parse(prep.candidates);
  const excluded = await preparationExcludedNumbers();
  const priorItems = await many('SELECT * FROM whatsapp_preparation_items WHERE preparation_id=?', [prep.id]);
  const byId = new Map(priorItems.map(item => [item.id, item]));
  let work = 0, availableCount = summary.available_count;
  for (const id of candidates) {
    const itemId = `prep:${prep.id}:${id}`;
    const previous = byId.get(itemId);
    if (previous && !['checking','completing'].includes(previous.status)) continue;
    // Bound a poll so many invalid/excluded records cannot exhaust a Vercel invocation.
    if (++work > 10) break;
    const lead = await getContractor(id);
    const number = lead ? contractorWhatsAppNumber(lead) : null;
    let status = 'checking', detail = '', checkedAt = '';
    const cached = lead?.whatsapp_verification;
    const age = now - Date.parse(cached?.checked_at || '');
    if (!lead) { status = 'skipped'; detail = 'Lead deleted'; }
    else if (!number) { status = 'invalid'; detail = 'Missing or invalid primary phone number'; }
    else if (lead.stage === 'Do Not Contact' || excluded.has(number)) { status = 'skipped'; detail = 'Opted out, replied or previously attempted'; }
    else if (priorItems.some(i => i.number === number && i.id !== itemId)) { status = 'duplicate'; detail = 'Duplicate recipient number'; }
    else if (cached?.number === number && ['available','not_found'].includes(cached.status) && age >= 0 && age < 7 * 86400000) {
      status = cached.status; detail = 'Reused registration check from the last 7 days'; checkedAt = cached.checked_at;
    }
    await run(`INSERT INTO whatsapp_preparation_items(id,preparation_id,contractor_id,number,status,token,detail)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET number=excluded.number,status=excluded.status,token=excluded.token,detail=excluded.detail`,
      [itemId, prep.id, id, number || '', status, token, detail]);
    if (checkedAt) await run('UPDATE whatsapp_preparation_items SET checked_at=? WHERE id=? AND token=?', [checkedAt, itemId, token]);
    priorItems.push({ id: itemId, number });
    if (status === 'available' && ++availableCount >= prep.target && prep.city !== '*') break;
    if (status === 'invalid') await saveWhatsAppCheck(id, { number: '', status: 'invalid', checked_at: new Date(now).toISOString(), detail, jid: '' });
    if (status === 'checking') return { id: itemId, contractor_id: id, number, token };
  }
  await getWhatsAppPreparation(prep.id);
  await run('UPDATE whatsapp_preparations SET lease_until=0 WHERE id=? AND token=?', [prep.id, token]);
  return null;
}
export async function finishWhatsAppPreparation(id, token, result) {
  const item = await one('SELECT * FROM whatsapp_preparation_items WHERE id=? AND token=?', [id, token]);
  if (!item || item.number !== result.number) throw campaignError('Preparation lease changed.', 409);
  if (!['checking','completing'].includes(item.status)) return { ok: true };
  const lock = await run(`UPDATE whatsapp_preparation_items SET status='completing' WHERE id=? AND token=? AND status='checking'
    AND EXISTS(SELECT 1 FROM whatsapp_preparations WHERE id=? AND token=? AND lease_until>=?)`,
    [id, token, item.preparation_id, token, Date.now()]);
  if (!lock.changes) throw campaignError('Preparation lease expired.', 409);
  const current = await getContractor(item.contractor_id);
  let status = result.status, detail = result.detail;
  if (!current || contractorWhatsAppNumber(current) !== item.number) { status = 'stale'; detail = 'Lead or number changed during check'; }
  else {
    await saveWhatsAppCheck(item.contractor_id, result);
    if (current.stage === 'Do Not Contact' || (await preparationExcludedNumbers()).has(item.number)) { status = 'skipped'; detail = 'Recipient no longer eligible'; }
  }
  await run("UPDATE whatsapp_preparation_items SET status=?,checked_at=?,detail=? WHERE id=? AND token=? AND status='completing'", [status, result.checked_at, detail, id, token]);
  await getWhatsAppPreparation(item.preparation_id);
  await run('UPDATE whatsapp_preparations SET lease_until=0 WHERE id=? AND token=?', [item.preparation_id, token]);
  return { ok: true };
}
