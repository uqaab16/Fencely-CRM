// Fencely CRM — framework-free HTTP handler `(req, res)`.
//
// The SAME handler runs in both worlds:
//   - Local:  local-server.js wraps it in node:http (PORT, default 4173) and
//             serves public/ exactly like the original app did.
//   - Cloud:  Vercel invokes it via api/index.js (vercel.json rewrites /api/*
//             to /api). Static frontend assets are served by Vercel itself.
//
// Auth model (src/auth.js):
//   - Public:        GET /api/health, POST /api/auth/login
//   - JWT (Bearer):  every other /api/* route
//   - MCP_TOKEN:     POST /api/mcp        (separate static token, NOT the JWT)
//   - CRON_SECRET:   POST|GET /api/jobs/update
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import * as auth from './auth.js';
import { APP_NAME } from './config.js';
import { toCsv, parseCsv, CSV_COLUMNS } from './csv.js';
import { aiEnabled, explainScore, generateOutreachDraft, classifyNiches } from '../ai/claude.js';
import { gatewayConfigured, VERIFICATION_LABELS } from './whatsapp.js';

import { requestWhatsAppCheck, bridgeConfigured } from './wa-service.js';
import { bridgeAuthorized, bridgeResult } from './wa-bridge.js';
import { senderAuthorized } from './wa-sender-auth.js';
import { readWebhookBody, verifyWebhook, parseWebhook } from './wa-webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Serve the built React app (web/dist) when it exists; fall back to the
// legacy public/ UI for anyone still running the pre-React checkout.
const DIST = path.join(__dirname, '..', 'web', 'dist');
const PUBLIC = fs.existsSync(path.join(DIST, 'index.html')) ? DIST : path.join(__dirname, '..', 'public');

// One-time startup (connect DB, schema, seed samples, seed admin) — memoised,
// retried on the next request if it ever fails (e.g. transient DB outage).
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.init();
      await db.ensureSchema();
      await db.seedIfEmpty();
      await auth.seedAdminIfNeeded();
    })();
    readyPromise.catch(() => { readyPromise = null; });
  }
  return readyPromise;
}

function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'content-type': type });
  res.end(data);
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { raw }; }
}

// ---------------------------------------------------------------------------
// Remote MCP endpoint — JSON-RPC 2.0, same 8 tools as mcp/server.js (stdio),
// implemented directly against the async db layer.
// ---------------------------------------------------------------------------
const MCP_TOOLS = [
  { name: 'prepare_whatsapp_list', description: 'Start a read-only list builder. scope=all scans the whole CRM to completion; otherwise city is required. Reuses available/not_found checks younger than 7 days. Checks all phone labels sequentially and keeps scanning until up to target distinct available numbers are found or the city pool is exhausted. Excludes opt-outs, replies and prior attempts; does not require permission evidence to check registration. Never sends or saves campaign drafts. Poll get_whatsapp_preparation for results.', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['city','all'] }, city: { type: 'string' }, state: { type: 'string' }, target: { type: 'integer', minimum: 1, maximum: 20 } }, required: [] } },
  { name: 'get_whatsapp_preparation', description: 'Read progress and the verified available list. Ready means the requested count was found; exhausted may contain fewer. Registration is not marketing permission. Never invent extra leads.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_whatsapp_preparations', description: 'List city WhatsApp list-building jobs and their IDs. No sends.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_campaigns', description: 'List saved WhatsApp draft campaigns. Does not send messages.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_campaign', description: 'Read a campaign and its reviewed drafts.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'save_campaign_drafts', description: 'Only after the user explicitly says to add their reviewed messages to CRM: save 1–20 drafts together. Show all drafts and the sender signature/STOP text in chat for review first. Supply the user-confirmed sender name, business and contact details and each recipient permission basis/note. Never invent identity or consent. Never sends or starts a campaign. Supply id and revision to replace existing drafts.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, revision: { type: 'integer' }, name: { type: 'string' }, sender: { type: 'object', properties: { name: { type: 'string' }, business: { type: 'string' }, contact: { type: 'string' } } }, schedule: { type: 'object', properties: { timeZone: { type: 'string' }, startHour: { type: 'integer' }, startDate: { type: 'string', description: 'Earliest sending date, YYYY-MM-DD in the recipient time zone' }, dailyLimit: { type: 'integer' } }, required: ['timeZone'] }, drafts: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { contractor_id: { type: 'integer' }, message: { type: 'string' }, permission: { type: 'object', properties: { basis: { type: 'string', enum: ['test', 'express', 'inferred'] }, note: { type: 'string' } } } }, required: ['contractor_id', 'message'] } } }, required: ['name', 'schedule', 'drafts'] } },
  { name: 'check_whatsapp', description: 'Check one contractor number using the configured WA-AKG gateway and save the result. Sends the number to your gateway; does not send a message or record marketing consent.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'search_contractors', description: 'Search/list contractors with filters', inputSchema: { type: 'object', properties: { q: { type: 'string' }, state: { type: 'string' }, city: { type: 'string' }, niche: { type: 'string' }, whatsapp_status: { type: 'string' }, stage: { type: 'string' }, has_email: { type: 'boolean' }, has_mobile: { type: 'boolean' } } } },
  { name: 'get_contractor', description: 'Get one contractor with timeline + tasks', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'create_contractor', description: 'Create a contractor (de-dupe checked; set force:true to override)', inputSchema: { type: 'object', properties: { business_name: { type: 'string' }, state: { type: 'string' }, city: { type: 'string' }, suburb: { type: 'string' }, niches: { type: 'array', items: { type: 'string' } }, landline: { type: 'string' }, mobile: { type: 'string' }, whatsapp_number: { type: 'string' }, whatsapp_status: { type: 'string' }, email: { type: 'string' }, website: { type: 'string' }, source: { type: 'string' }, stage: { type: 'string' }, notes: { type: 'string' }, force: { type: 'boolean' } }, required: ['business_name'] } },
  { name: 'update_contractor', description: 'Update fields on a contractor (partial)', inputSchema: { type: 'object', properties: { id: { type: 'number' }, fields: { type: 'object' } }, required: ['id', 'fields'] } },
  { name: 'move_stage', description: 'Move a contractor to a pipeline stage', inputSchema: { type: 'object', properties: { id: { type: 'number' }, stage: { type: 'string', enum: db.STAGES } }, required: ['id', 'stage'] } },
  { name: 'add_note', description: 'Add a note/activity to a contractor timeline', inputSchema: { type: 'object', properties: { id: { type: 'number' }, body: { type: 'string' } }, required: ['id', 'body'] } },
  { name: 'list_followups', description: 'List open follow-up tasks (due=today for due/overdue only)', inputSchema: { type: 'object', properties: { due: { type: 'string', enum: ['all', 'today'] } } } },
  { name: 'create_task', description: 'Create a follow-up task', inputSchema: { type: 'object', properties: { contractor_id: { type: 'number' }, title: { type: 'string' }, due_date: { type: 'string' } }, required: ['title'] } },
];

async function callMcpTool(name, args = {}) {
  switch (name) {
    case 'prepare_whatsapp_list':
      if (!bridgeConfigured()) throw new Error('Private registration worker is not configured.');
      return db.createWhatsAppPreparation(args);
    case 'get_whatsapp_preparation': return db.getWhatsAppPreparation(args.id);
    case 'list_whatsapp_preparations': return db.listWhatsAppPreparations();
    case 'list_campaigns': return db.listCampaigns();
    case 'get_campaign': return db.getCampaign(args.id);
    case 'save_campaign_drafts': return db.saveCampaignDrafts(args);
    case 'check_whatsapp': {
      const c = await db.getContractor(args.id);
      if (!c) return { error: 'Not found' };
      return requestWhatsAppCheck(c);
    }
    case 'search_contractors': return db.listContractors(args);
    case 'get_contractor': return (await db.getContractor(args.id)) || { error: 'Not found' };
    case 'create_contractor': {
      const dupes = await db.findDuplicates(args);
      if (dupes.length && !args.force) return { error: 'Possible duplicate — re-run with force:true to create anyway', duplicates: dupes.map(d => ({ id: d.id, business_name: d.business_name })) };
      return db.createContractor(args);
    }
    case 'update_contractor': return (await db.updateContractor(args.id, args.fields || {})) || { error: 'Not found' };
    case 'move_stage': return (await db.updateContractor(args.id, { stage: args.stage })) || { error: 'Not found' };
    case 'add_note': return db.addNote(args.id, args.body);
    case 'list_followups': return db.listTasks({ dueToday: args.due === 'today' });
    case 'create_task': return db.createTask(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleRpcMessage(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  try {
    let result;
    if (method === 'initialize') {
      result = { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fencely-crm', version: '1.1.0' } };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: MCP_TOOLS };
    } else if (method === 'tools/call') {
      try {
        const out = await callMcpTool(params?.name, params?.arguments || {});
        result = { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        result = { content: [{ type: 'text', text: String(e?.message || e) }], isError: true };
      }
    } else if (typeof method === 'string' && method.startsWith('notifications/')) {
      return null; // notifications never get a response body
    } else {
      if (isNotification) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (e) {
    return isNotification ? null : { jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message || e) } };
  }
}

// ---------------------------------------------------------------------------
// Scheduled maintenance job (Vercel Cron → /api/jobs/update).
// SAFE + HONEST by design: recomputes scores, REPORTS duplicates (never
// auto-merges/deletes), checks website liveness for the 50 coldest records
// with a website, and only flags a site when the server itself answers with
// an HTTP error. Network errors / DNS failures / timeouts are skipped —
// they are NOT proof a business is gone. Nothing is ever filled in by guessing.
// New-lead discovery is intentionally NOT here: that stays a Claude/research
// workflow (see README).
// ---------------------------------------------------------------------------
async function checkWebsite(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) return { unreachable: false, skipped: true };
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const attempt = async (method) => {
    const res = await fetch(url, {
      method, redirect: 'follow',
      signal: AbortSignal.timeout(5000),
      headers: { 'user-agent': `${APP_NAME.replace(/\s+/g, '')}-UpdateCheck/1.0` },
    });
    return res.status;
  };
  try {
    let status = await attempt('HEAD');
    if (status === 405 || status === 501) status = await attempt('GET'); // some hosts reject HEAD
    if (status >= 400) return { unreachable: true, reason: `HTTP ${status}` };
    return { unreachable: false, status };
  } catch {
    return { unreachable: false, skipped: true };
  }
}

async function runUpdateJob() {
  const all = await db.listContractors();

  // 1) Recompute every lead score with the current rules; write only on change.
  let rescored = 0;
  for (const c of all) {
    const s = db.scoreLead(c);
    if (s.score !== c.lead_score || JSON.stringify(s.reasons) !== JSON.stringify(c.score_reasons || [])) {
      await db.updateLeadScore(c.id, s.score, s.reasons);
      rescored++;
    }
  }

  // 2) Duplicate sweep — report only, never auto-delete or merge.
  const dupesFound = db.findDuplicatePairs(all).length;

  // 3) Website liveness for the 50 coldest records (least recently updated).
  const candidates = all
    .filter(c => c.website)
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')) || a.id - b.id)
    .slice(0, 50);
  let checked = 0;
  let unreachableFlagged = 0;
  const CONCURRENCY = 10;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    await Promise.all(candidates.slice(i, i + CONCURRENCY).map(async (c) => {
      checked++;
      const verdict = await checkWebsite(c.website);
      if (verdict.unreachable && !(await db.hasActivitySince(c.id, 'website-check', 30))) {
        await db.addActivity(c.id, 'website-check', `Website check: ${c.website} appears unreachable (${verdict.reason}). Flagged by the scheduled update — please verify manually before changing anything.`);
        unreachableFlagged++;
      }
    }));
  }

  return { checked, unreachableFlagged, dupesFound, rescored };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    await ensureReady();

    // --- public ---
    if (p === '/api/health') return send(res, 200, { ok: true, app: 'fencely-crm', db: db.backendKind(), aiEnabled: aiEnabled(), time: new Date().toISOString() });

    if (p === '/api/auth/login' && req.method === 'POST') {
      if (!process.env.JWT_SECRET) return send(res, 503, { error: 'Login is not configured: JWT_SECRET is missing.' });
      if ((await db.countUsers()) === 0) return send(res, 503, { error: 'Login is not configured: no admin user exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD_HASH, then restart.' });
      const b = await readBody(req);
      const user = await auth.verifyCredentials(b.email, b.password);
      if (!user) return send(res, 401, { error: 'Invalid email or password' });
      const token = auth.signToken({ sub: user.email, email: user.email });
      return send(res, 200, { token, user: { email: user.email } });
    }

    // --- remote MCP (own static-token auth; NOT the JWT) ---
    if (p === '/api/mcp') {
      if (!auth.checkMcpToken(req)) return send(res, 401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      const payload = await readBody(req);
      if (Array.isArray(payload)) {
        const responses = [];
        for (const msg of payload) {
          const r = await handleRpcMessage(msg);
          if (r) responses.push(r);
        }
        if (!responses.length) { res.writeHead(202); return res.end(); }
        return send(res, 200, responses);
      }
      const r = await handleRpcMessage(payload);
      if (!r) { res.writeHead(202); return res.end(); }
      return send(res, 200, r);
    }

    // --- scheduled update job (cron-secret auth; GET accepted for Vercel Cron) ---
    if (p === '/api/jobs/update') {
      if (!auth.checkCronAuth(req)) return send(res, 401, { error: 'Unauthorized' });
      if (req.method !== 'POST' && req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      return send(res, 200, await runUpdateJob());
    }

    if (p === '/api/whatsapp/webhook') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      const raw = await readWebhookBody(req);
      verifyWebhook(raw, req.headers['x-webhook-signature']);
      const event = parseWebhook(raw);
      if (!event || event.test) return send(res, 200, { ok: true, ignored: !event, test: !!event?.test });
      return send(res, 200, await db.recordWhatsAppReply(event));
    }

    if (p.startsWith('/api/whatsapp/sender/')) {
      if (!senderAuthorized(req)) return send(res, 401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      if (p === '/api/whatsapp/sender/claim') return send(res, 200, { job: await db.claimDispatch() });
      const b = await readBody(req);
      if (p === '/api/whatsapp/sender/heartbeat') return send(res, 200, await db.recordSenderHeartbeat(b));
      if (typeof b.id !== 'string' || typeof b.token !== 'string') return send(res, 400, { error: 'Invalid dispatch receipt' });
      if (p === '/api/whatsapp/sender/authorize') return send(res, 200, await db.authorizeDispatch(b));
      if (p === '/api/whatsapp/sender/result') return send(res, 200, await db.finishDispatch(b));
      return send(res, 404, { error: 'Not found' });
    }

    // Dedicated, limited worker credential; never accepts a login/MCP token.
    if (p.startsWith('/api/whatsapp/bridge/')) {
      if (!bridgeAuthorized(req)) return send(res, 401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      if (p === '/api/whatsapp/bridge/claim') return send(res, 200, { job: (await db.claimWhatsAppCheck()) || await db.claimWhatsAppPreparation() });
      if (p === '/api/whatsapp/bridge/result') {
        const b = await readBody(req);
        if (typeof b.id !== 'string' || typeof b.token !== 'string' || typeof b.number !== 'string')
          return send(res, 400, { error: 'Invalid check result' });
        return send(res, 200, await (b.id.startsWith('prep:') ? db.finishWhatsAppPreparation : db.finishWhatsAppCheck)(b.id, b.token, bridgeResult(b.number, b)));
      }
      return send(res, 404, { error: 'Not found' });
    }

    // --- everything else under /api requires a login JWT ---
    if (p.startsWith('/api/')) {
      const user = auth.authUser(req);
      if (!user) return send(res, 401, { error: 'Unauthorized' });

      if (p === '/api/whatsapp/preparations' && req.method === 'GET') return send(res, 200, await db.listWhatsAppPreparations());
      if (p === '/api/whatsapp/preparations' && req.method === 'POST') {
        if (!bridgeConfigured()) return send(res, 503, { error: 'Private registration worker is not configured.' });
        return send(res, 200, await db.createWhatsAppPreparation(await readBody(req)));
      }
      const preparationMatch = p.match(/^\/api\/whatsapp\/preparations\/([a-f0-9-]+)$/);
      if (preparationMatch && req.method === 'GET') return send(res, 200, await db.getWhatsAppPreparation(preparationMatch[1]));
      if (p === '/api/campaigns/config' && req.method === 'GET') return send(res, 200, { mode: db.senderMode(), health: await db.getSenderHealth() });
      const campaignAction = p.match(/^\/api\/campaigns\/([a-f0-9-]+)\/(start|pause)$/);
      if (campaignAction && req.method === 'POST') {
        const b = await readBody(req);
        return send(res, 200, campaignAction[2] === 'start'
          ? await db.startCampaign(campaignAction[1], b.revision, b.consent_confirmed, user.email)
          : await db.pauseCampaign(campaignAction[1]));
      }
      if (p === '/api/campaigns' && req.method === 'GET') return send(res, 200, await db.listCampaigns());
      if (p === '/api/campaigns' && req.method === 'POST') return send(res, 200, await db.saveCampaignDrafts(await readBody(req)));
      const campaignMatch = p.match(/^\/api\/campaigns\/([a-f0-9-]+)$/);
      if (campaignMatch && req.method === 'GET') return send(res, 200, await db.getCampaign(campaignMatch[1]));
      if (p === '/api/auth/me' && req.method === 'GET') return send(res, 200, { email: user.email });
      if (p === '/api/whatsapp/config' && req.method === 'GET') return send(res, 200, { configured: bridgeConfigured() || gatewayConfigured(), mode: bridgeConfigured() ? 'private-bridge' : 'direct', statuses: VERIFICATION_LABELS });
      const waCheck = p.match(/^\/api\/contractors\/(\d+)\/whatsapp-check$/);
      if (waCheck && req.method === 'POST') {
        const c = await db.getContractor(waCheck[1]);
        if (!c) return send(res, 404, { error: 'Not found' });
        return send(res, 200, await requestWhatsAppCheck(c));
      }
      if (p === '/api/stats') return send(res, 200, await db.stats());
      if (p === '/api/meta') return send(res, 200, { appName: APP_NAME, stages: db.STAGES, niches: db.NICHES, waStatuses: db.WA_STATUSES, csvColumns: CSV_COLUMNS });

      if (p === '/api/contractors' && req.method === 'GET') {
        const f = Object.fromEntries(url.searchParams);
        if (f.has_email) f.has_email = true; if (f.has_mobile) f.has_mobile = true;
        return send(res, 200, await db.listContractors(f));
      }
      if (p === '/api/contractors' && req.method === 'POST') {
        const input = await readBody(req);
        if (!input.business_name) return send(res, 400, { error: 'business_name is required' });
        const dupes = await db.findDuplicates(input);
        if (dupes.length && !input.force) return send(res, 409, { error: 'Possible duplicate', duplicates: dupes.map(d => ({ id: d.id, business_name: d.business_name, email: d.email, mobile: d.mobile })) });
        return send(res, 201, await db.createContractor(input));
      }
      const m = p.match(/^\/api\/contractors\/(\d+)$/);
      if (m && req.method === 'GET') { const c = await db.getContractor(m[1]); return c ? send(res, 200, c) : send(res, 404, { error: 'Not found' }); }
      if (m && req.method === 'PUT') { const c = await db.updateContractor(m[1], await readBody(req)); return c ? send(res, 200, c) : send(res, 404, { error: 'Not found' }); }
      if (m && req.method === 'DELETE') return send(res, 200, { deleted: await db.deleteContractor(m[1]) });
      if (p === '/api/contractors' && req.method === 'DELETE') {
        const b = await readBody(req);
        return send(res, 200, { deleted: await db.bulkDeleteContractors(b.ids || []) });
      }
      if (p === '/api/contractors/stage' && req.method === 'PUT') {
        const b = await readBody(req);
        try {
          return send(res, 200, { updated: await db.bulkSetStage(b.ids || [], b.stage) });
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }
      const note = p.match(/^\/api\/contractors\/(\d+)\/notes$/);
      if (note && req.method === 'POST') { const b = await readBody(req); return send(res, 201, await db.addNote(note[1], b.body || '')); }
      const contact = p.match(/^\/api\/contractors\/(\d+)\/log-contact$/);
      if (contact && req.method === 'POST') {
        const b = await readBody(req);
        const c = await db.logContact(contact[1], { channel: b.channel || 'other', note: b.note || '', outcome: b.outcome || '' });
        return c ? send(res, 200, c) : send(res, 404, { error: 'Not found' });
      }
      const ai = p.match(/^\/api\/contractors\/(\d+)\/(draft|score|classify)$/);
      if (ai && req.method === 'POST') {
        const c = await db.getContractor(ai[1]); if (!c) return send(res, 404, { error: 'Not found' });
        if (ai[2] === 'draft') return send(res, 200, await generateOutreachDraft(c));
        if (ai[2] === 'score') return send(res, 200, await explainScore(c));
        return send(res, 200, await classifyNiches(c));
      }

      if (p === '/api/tasks' && req.method === 'GET') return send(res, 200, await db.listTasks({ dueToday: url.searchParams.get('due') === 'today' }));
      if (p === '/api/tasks' && req.method === 'POST') return send(res, 201, await db.createTask(await readBody(req)));
      const tm = p.match(/^\/api\/tasks\/(\d+)\/done$/);
      if (tm && req.method === 'POST') return send(res, 200, { done: await db.completeTask(tm[1]) });

      if (p === '/api/export.csv' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="fencely-crm-export.csv"' });
        return res.end(toCsv(await db.listContractors(Object.fromEntries(url.searchParams))));
      }
      if (p === '/api/import' && req.method === 'POST') {
        const b = await readBody(req);
        const items = b.csv ? parseCsv(b.csv) : (b.records || []);
        // Load the existing table once and dedupe against it (plus rows staged
        // in this same import) instead of re-scanning per row — same semantics.
        // Rows are then written with bulkCreateContractors: a few batched
        // pipeline calls total, so a 1,013-row CSV finishes well under the
        // 60s serverless limit (the old per-row loop timed out mid-import).
        const pool = await db.listContractors();
        const staged = [];
        let skipped = 0; const skippedNames = [];
        for (const item of items) {
          if (!item.business_name) { skipped++; continue; }
          const c = db.normalise(item);
          const dup = !b.force
            && (pool.some((r) => db.contractorsMatch(c, r)) || staged.some((r) => db.contractorsMatch(c, r)));
          if (dup) { skipped++; skippedNames.push(item.business_name); continue; }
          staged.push(c);
        }
        const created = await db.bulkCreateContractors(staged);
        return send(res, 200, { created, skipped, skippedNames });
      }
      if (p === '/api/template.csv') {
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="fencely-crm-template.csv"' });
        return res.end(CSV_COLUMNS.join(',') + '\n"Example Fencing Co","",NSW,Sydney,Surry Hills,"Colorbond;Timber","02 0000 0000","0400 000 000","0400 000 000","Advertises WhatsApp","hello@example.com","https://example.com","Google listing",New,"","","",""');
      }

      return send(res, 404, { error: 'Not found' });
    }

    // --- static frontend (local dev; on Vercel the platform serves the UI) ---
    const file = p === '/' ? 'index.html' : p.slice(1);
    const fp = path.join(PUBLIC, file);
    if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp)) return send(res, 404, 'Not found', 'text/plain');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'content-type': types[path.extname(fp)] || 'text/plain' });
    return res.end(fs.readFileSync(fp));
  } catch (e) {
    return send(res, e.statusCode || 500, { error: String(e?.message || e) });
  }
}
