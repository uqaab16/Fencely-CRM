# Fencely CRM — Amir's own advanced CRM (Option B)

An owned, runnable CRM codebase for **Fencely outreach to Australian fence contractors**. Built CRM-first; contractor research/list-building is a separate later step (not included here — the only records are clearly-labelled SAMPLE dummies).

> You own this code. It is **not** a Muse artifact. It runs locally or hosted (Vercel + Turso — see "Cloud deploy" below) with Node 22.5+, and connects to Claude in two directions (see below).

## Quick start

```bash
cd ~/workspace/fencely-crm
npm install
npm start          # http://localhost:4173 (local SQLite, seeded with SAMPLE dummies)
npm test           # 11 tests: scoring, CRUD/dedupe, tasks, CSV round-trip, log-contact, auth, config
```

Copy `.env.example` → `.env` if you want Claude AI features (optional — everything else works without a key).

## Features

- **Dashboard stats** — total, WhatsApp-advertised, contacted / replied / interested, follow-ups due
- **Contractors grid** — search + filters: `state`, `city`, niche, WhatsApp status, pipeline stage, has email / has mobile
- **Kanban pipeline** — New → Researched → Ready to Contact → Contacted → Follow-up Due → Replied → Interested → Trial/Demo → Customer, plus Do Not Contact
- **Add / edit / delete** records; niches are multi-select tags: Colorbond, Timber, Pool Fencing, Aluminium/Slat, Rural/Farm, Commercial/Security, Gates/Automation, Retaining, Other
- **Detail drawer + timeline** — notes + activity log (creations, stage changes, contacts), last contacted, next follow-up, outreach outcome
- **Log contact** — one action records a call / WhatsApp / email / SMS (`POST /api/contractors/:id/log-contact`): stamps `last_contacted`, writes a timeline entry, advances the stage (New/Researched/Ready to Contact → Contacted → Follow-up Due), and auto-creates a follow-up task due in `FOLLOWUP_DAYS` days (default 4) if none is open. Replies are handled by moving the stage to Replied/Interested as usual.
- **Tasks / follow-ups** — due-today queue, all-tasks list, mark done
- **Explainable lead scoring** (rule-based, stored per record with reasons): +25 Advertises WhatsApp, +15 mobile, +15 email, +10 website, +5 landline, up to +20 for Fencely-fit niches (Colorbond/Timber/Pool/Aluminium), +5 multi-niche
- **De-dupe** on create & import — matches on phone (normalised AU), email, or business name + city; API returns `409` with the duplicates unless `force:true`
- **CSV import/export** — see format below. Export is Excel-compatible: open the `.csv` in Excel/Sheets and Save As `.xlsx` if you need a workbook (no extra dependency required)
- **Seed data** — 4 SAMPLE/dummy records (example.invalid emails, 0000 numbers) so the UI isn't empty. Delete them before real use.

## Data model (async layer — local SQLite or hosted Turso)

The data layer (`src/db.js`) is fully async with two interchangeable backends: local `node:sqlite` file at `data/crm.sqlite` (override with `CRM_DB_PATH`, WAL mode) for local use, or Turso/libSQL over HTTP when `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are set (cloud mode — see "Cloud deploy"). Zero native dependencies either way.

- `contractors` — business_name, contact_name, state, city, suburb, niches (JSON), landline, mobile, whatsapp_number, whatsapp_status (`Advertises WhatsApp` / `WhatsApp - unverified` / `Landline only` / `Unknown` — only a publicly-advertised WhatsApp counts as verified; the older label `Mobile - unverified` is still accepted on import and auto-renamed), email (public only), website, source, stage, lead_score + score_reasons, last_contacted, next_followup, outcome, notes, timestamps
- `activities` — timeline entries per contractor (note / stage / created / contact / website-check)
- `tasks` — follow-ups, optionally linked to a contractor, due_date, done
- `users` — the single admin login (email + bcryptjs password hash), seeded on first boot from env

Only include contact details a business **publicly publishes**, with the `source` recorded per row. Never treat a plain mobile as a verified WhatsApp number.

## Claude integration

### 1. Claude operates the CRM — MCP server ✅ REAL (not a stub)

`mcp/server.js` uses the official `@modelcontextprotocol/sdk` (stdio transport) and operates on the **same data layer** as the web app. It was verified live: `listTools` + `search_contractors` + `list_followups` calls succeeded.

**Tools:**

| Tool | Purpose |
|---|---|
| `search_contractors` | List/filter (q, state, city, niche, whatsapp_status, stage, has_email, has_mobile) |
| `get_contractor` | One record + timeline + tasks |
| `create_contractor` | Create (de-dupe checked, `force` override) |
| `update_contractor` | Partial field update |
| `move_stage` | Move pipeline stage |
| `add_note` | Add timeline note |
| `list_followups` | Open tasks (`due: "today"` for due/overdue) |
| `create_task` | Create follow-up task |

**Connect Claude — Claude Code:**

```bash
claude mcp add fencely-crm -- node /home/hatch/workspace/fencely-crm/mcp/server.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "fencely-crm": {
      "command": "node",
      "args": ["/home/hatch/workspace/fencely-crm/mcp/server.js"]
    }
  }
}
```

**Claude.ai custom connector (remote MCP)** — when the CRM is deployed (see "Cloud deploy"), the same 8 tools are exposed over HTTP at `POST https://<your-deployment>/api/mcp` (JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`). Authenticate with the header `Authorization: Bearer <MCP_TOKEN>` — a long-lived static token from env, deliberately separate from the login JWT. Never expose this endpoint without `MCP_TOKEN` set (it fails closed).

**Security:** in your Claude connector/client settings, set write tools (`create_*`, `update_*`, `move_stage`) to **ask/confirm** — never auto-approve writes. The MCP server inherits your local file permissions; anyone who can run it can read/write the CRM.

### 2. CRM uses Claude — Anthropic API (outbound)

`ai/claude.js`, behind env flag:

```bash
ANTHROPIC_API_KEY=sk-ant-...   # env only — NEVER hardcode or commit
ANTHROPIC_MODEL=claude-sonnet-4-5
```

- Niche classification, outreach draft generation (per-contractor, personalised by niche/city), lead-score plain-English explanation
- **Graceful no-op:** with no key set, `/api/health` reports `aiEnabled:false`, drafts fall back to a local template, and scores stay rule-based. No data leaves your machine.

Example prompts once connected: *"Find Sydney Colorbond contractors, WhatsApp-advertised, not contacted"* • *"Move these to Contacted, follow-up in 4 days"* • *"Draft outreach for the top 10 scored leads in Brisbane."*

## Cloud deploy (Vercel + Turso)

The CRM is cloud-ready: the same `(req, res)` handler in `src/app.js` runs locally (`local-server.js`, `npm start`, port 4173) and on Vercel (`api/index.js`). Data lives in Turso so serverless functions stay stateless.

### 1. Create the database (Turso)

Sign up at turso.tech, create a database, and note its URL (`libsql://<db>-<user>.turso.io`) and an auth token. No schema step is needed — the app creates tables on first request.

### 2. Deploy to Vercel

Import this folder as a Vercel project (framework preset: "Other"). `vercel.json` already wires everything:

- rewrites: all `/api/*` → the single function in `api/index.js` (60s max duration)
- crons: `GET /api/jobs/update` weekly, Mondays 03:00 UTC (`0 3 * * 1`)

### 3. Set environment variables (Vercel → Settings → Environment Variables)

| Variable | Purpose |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://…turso.io` — switches the data layer to Turso |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `ADMIN_EMAIL` | Admin login email (seeded on first boot) |
| `ADMIN_PASSWORD_HASH` | **bcrypt hash** of the admin password — generate the hash from a password only you know (e.g. an online bcrypt generator); the plaintext password is never stored or sent anywhere |
| `JWT_SECRET` | Long random string — signs login tokens (7-day expiry) |
| `MCP_TOKEN` | Long random string — static token for the remote MCP endpoint (NOT the JWT) |
| `CRON_SECRET` | Long random string — Vercel Cron sends it automatically as `Authorization: Bearer <CRON_SECRET>` |
| `APP_NAME`, `NICHES_JSON`, `STAGES_JSON`, `FIT_NICHES_JSON` | Optional product config (see below) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional Claude AI features |
| `FOLLOWUP_DAYS` | Optional, default 4 — due-date offset for auto follow-up tasks |

### 4. Auth model

- **Login:** `POST /api/auth/login {email, password}` → JWT (HS256). Every `/api/*` route except `/api/health` and `/api/auth/login` requires `Authorization: Bearer <JWT>`. `GET /api/auth/me` returns the signed-in email.
- **Fail closed:** if no admin user exists and `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH` are unset, login returns `503` — the CRM never runs open.
- **Remote MCP (Claude.ai):** connect a custom connector to `https://<your-deployment>/api/mcp` with header `Authorization: Bearer <MCP_TOKEN>`. Same 8 tools as the local stdio server. Keep write tools on ask/confirm in Claude.
- **Job endpoint:** `POST` (or `GET`, as Vercel Cron sends) `/api/jobs/update`, guarded by `CRON_SECRET` (`x-cron-secret` header, `Authorization: Bearer`, or the Vercel cron marker header). Missing secret = `401`, always.

### 5. The scheduled auto-update job — what it does and doesn't do

Weekly (and on demand), `/api/jobs/update`:

1. **Recomputes every lead score** with the current rules and writes only changed rows.
2. **Duplicate sweep:** counts duplicate pairs (same de-dupe rules as import) and reports them — it never auto-merges or deletes.
3. **Website liveness:** checks the 50 coldest (least-recently-updated) records that have a website, via HEAD/GET with a 5s timeout. A site is flagged (timeline `website-check` entry, at most once per 30 days per record) **only** when the server itself answers HTTP ≥ 400. DNS failures, timeouts and other network errors are skipped, never flagged — they are not proof a business is gone. Nothing is ever filled in by guessing.

Returns `{ checked, unreachableFlagged, dupesFound, rescored }`. **Discovering brand-new contractors is deliberately NOT part of this job** — new-lead research stays a Claude/research workflow with human-verified public sources; this job is maintenance only.

### 6. Local development against the cloud DB

Point local dev at Turso by exporting `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` before `npm start` — or set `TURSO_HTTP_URL` to any libSQL-compatible HTTP endpoint (local `sqld`, a test mock) for testing. Without Turso vars, local dev uses the SQLite file exactly as before, and the stdio MCP server (`npm run mcp`) keeps working either way.

## Productisation notes

This CRM is built to be reusable/resellable later, not locked to one brand:

- **Configurable today (env, no code changes):** product name (`APP_NAME`, returned by `/api/meta` as `appName`), niche vocabulary (`NICHES_JSON`), pipeline stages (`STAGES_JSON`), and the scoring "fit niches" (`FIT_NICHES_JSON`) — all defaulting to the current values, with invalid JSON safely falling back to defaults. No code outside `src/config.js` defaults assumes a brand.
- **One honest caveat:** built-in stage logic (dashboard stats buckets, log-contact stage transitions, seed data) is written against the *default* stage names. Overriding stages is safe as vocabulary, but keep the default names for the stages that logic touches.
- **Not built yet (future step before selling as hosted SaaS):** multi-tenant workspaces (per-tenant data isolation), per-user accounts/roles, and billing. The data model is deliberately tenant-ready (no brand-specific fields), but no tenant columns exist yet — add them when multi-tenancy is actually built.

## Import / export format

Header (see `sample-template.csv`, also `GET /api/template.csv`):

```
business_name,contact_name,state,city,suburb,niches,landline,mobile,whatsapp_number,whatsapp_status,email,website,source,stage,last_contacted,next_followup,outcome,notes
```

Multiple niches are `;`-separated inside one cell. Import skips duplicates (name+city / phone / email) and reports created vs skipped.

## Project structure

```
fencely-crm/
  package.json          # start / dev / mcp / test scripts
  .env.example          # all env vars (placeholders only)
  vercel.json           # /api rewrite + weekly cron for /api/jobs/update
  local-server.js       # local dev bootstrap (node:http, PORT default 4173)
  api/index.js          # Vercel serverless entry → src/app.js handler
  src/
    app.js              # framework-free (req,res) handler: API + auth + MCP + job
    config.js           # APP_NAME / NICHES / STAGES / FIT_NICHES (env-overridable)
    db.js               # async data layer: Turso HTTP or local node:sqlite
    turso.js            # zero-dep Turso/libSQL HTTP client (/v2/pipeline)
    auth.js             # bcryptjs login, hand-rolled HS256 JWT, token guards
    csv.js              # CSV parse/serialise
  public/               # single-page UI (index.html, styles.css, app.js)
  mcp/server.js         # Claude MCP server, stdio (official SDK)
  ai/claude.js          # Anthropic API hooks (env-gated)
  tests/                # node --test suites (crm, auth, config)
  sample-template.csv
  data/crm.sqlite       # local mode only; created on first run
```

## Roadmap (v2)

- Multi-tenant workspaces + per-user accounts, then billing (see Productisation notes)
- OAuth for the remote MCP endpoint (static `MCP_TOKEN` works today)
- Gmail drafts integration (draft-only, human-approved sends — no bulk sending)
- WhatsApp **Business Platform** API (official, opt-in + approved templates only — **explicitly NOT** sending from a personal WhatsApp number/app, which stays manual one-by-one by the account owner)
- Scheduled follow-up digests and re-enrichment checks

## Limits & honesty notes

- No contractor research is bundled; importing real lists is your next step, and no list of "all Australian contractors" is ever 100% complete — record coverage/source per batch.
- WhatsApp status is only "verified" when a business publicly advertises it. A mobile number ≠ confirmed WhatsApp.
