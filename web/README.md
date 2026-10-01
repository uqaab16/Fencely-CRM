# Fencely CRM — React frontend (`web/`)

A polished React (Vite) single-page app for the Fencely CRM. It talks to the
**same backend API** as the old vanilla UI in `../public/` (which is untouched
and still works). The backend lives in `../src/` — this folder is frontend only.

## Features

- **Branding from the backend**: the app name shown in the login screen, app
  bar and browser tab comes from `GET /api/meta` → `appName` (fallback
  "Fencely CRM") — nothing brand-specific is hardcoded in the UI, so the CRM
  can be resold/rebranded by changing the backend config. Niches, stages and
  WhatsApp statuses are likewise fully driven by `/api/meta`.
- **Login** (email + password → `POST /api/auth/login`, JWT stored in
  `localStorage` as `fencely_jwt`, sent as `Authorization: Bearer …` on every
  API call; any 401 clears the session and bounces back to login; Logout).
- **App bar**: Fencely CRM branding, Claude AI status dot (from `GET /api/health`,
  shows backend version when reported), Table / Pipeline / Follow-ups tabs
  (Follow-ups shows a due-count badge), logged-in email, Logout.
- **Dashboard stats** from `GET /api/stats`: total, contacted, replied,
  interested+, WhatsApp advertised, follow-ups due today + a per-stage count
  summary (clicking a stage opens it in Pipeline).
- **Contractors table**: **live filters** — search (debounced ~300ms),
  state/city/niche/WhatsApp-status/stage selects and "Has email" / "Has mobile"
  checkboxes all re-fetch `GET /api/contractors` on change with no Apply
  button, with a results count ("1,013 contractors"), active-filter chips and
  a Reset button. Niche chips, colour-coded WhatsApp status, inline **stage
  dropdown** (one-click pipeline move), per-row **quick-log buttons**
  (📞 💬 ✉️) next to each contact, colour-coded **lead-score badge** (click to
  see the score reasons). Row click opens the detail drawer.
- **Pipeline Kanban**: one column per stage (from `GET /api/meta`), HTML5
  drag-and-drop between columns plus ← / → step buttons, score badges, and
  compact one-tap contact logging (📞 / 💬 / ✉️).
- **Detail drawer**: full record, score + reasons + "Explain score",
  last contacted / next follow-up / open follow-up task, **quick-log buttons**
  (📞 Called, 💬 WhatsApp, ✉️ Emailed → `POST /api/contractors/:id/log-contact`,
  which bumps last-contacted and auto-creates the follow-up), one-tap
  **Replied** / **Interested** stage buttons, Edit, Delete (with confirm),
  "✨ Draft outreach (Claude)" with AI on/off note and copy-to-clipboard,
  notes + timeline, per-contractor tasks with create + mark-done.
- **Follow-ups view**: "X due today / overdue" summary (from
  `GET /api/stats`), due/overdue queue, all tasks, mark-done, quick-add.
- **Add/Edit contractor** modal with niches checkboxes; a backend 409 shows the
  possible duplicates and offers "Create anyway" (force).
- **CSV**: Import (file read client-side → `POST /api/import`), Export and the
  CSV template downloaded via authenticated fetch→blob (a plain link cannot
  carry the JWT).
- Loading states, empty states, toasts, mobile-responsive layout.

## Develop

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

Run the backend separately from the repo root (`npm start`, port 4173).
`vite.config.js` proxies `/api` → `http://localhost:4173` in both `dev` and
`preview`, so no CORS or URL juggling is needed locally.

## Build

```bash
npm run build      # outputs static files to web/dist/
npm run preview    # optional: serve dist/ locally on :4174 (also proxied)
```

## Deploy note (for the parent deploy guide)

Deploy `web/dist/` as a **static site**. The app calls relative `/api/*`
paths, so the host must rewrite `/api/*` to the CRM backend (e.g. a Vercel
`rewrites` entry or Netlify `_redirects` rule pointing at the backend origin).
Routing inside the app is state-based (no client-side URL routes), so no
SPA history fallback is required — serving `index.html` at `/` is enough.
No secrets or tokens live in the bundle; the JWT only exists in the visitor's
`localStorage` after login.
