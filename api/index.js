// Vercel serverless entry point. vercel.json rewrites every /api/* request
// here; the actual framework-free (req, res) handler lives in src/app.js and
// is shared with local dev (local-server.js).
import handler from '../src/app.js';

export default handler;
