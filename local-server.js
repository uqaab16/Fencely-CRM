// Local dev bootstrap — serves src/app.js over node:http.
// Cloud deploys don't use this file: Vercel invokes api/index.js (same handler).
// Honours PORT (default 4173). Run with: npm start
import http from 'node:http';
import handler from './src/app.js';
import * as db from './src/db.js';
import { APP_NAME } from './src/config.js';
import { aiEnabled } from './ai/claude.js';

const PORT = Number(process.env.PORT || 4173);

http.createServer(handler).listen(PORT, () => {
  const kind = db.backendKind();
  const where = kind === 'turso' ? 'Turso (remote)' : `DB: ${db.DB_PATH}`;
  console.log(`${APP_NAME} running at http://localhost:${PORT} (backend: ${kind}, ${where}, AI: ${aiEnabled() ? 'on' : 'off'})`);
});
