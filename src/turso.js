// Async client for the Turso / libSQL HTTP API — zero dependencies (global fetch).
//
// Endpoint: POST <base>/v2/pipeline with batched "execute" requests. Values are
// sent as typed args ({type:"integer"|"text"|"float"|"blob"|"null", value}).
//
// Base URL resolution:
//   1. TURSO_HTTP_URL      — explicit HTTP base URL. Use this to point the client
//                            at any libSQL-compatible HTTP endpoint, e.g. a local
//                            `sqld` server or a test mock implementing /v2/pipeline.
//   2. TURSO_DATABASE_URL  — the usual Turso URL; a leading "libsql://" scheme is
//                            rewritten to "https://".
// Auth: "Authorization: Bearer <TURSO_AUTH_TOKEN>" is sent when a token is set.
// Secret values are never logged here.

export function tursoBaseUrl() {
  const raw = process.env.TURSO_HTTP_URL || process.env.TURSO_DATABASE_URL || '';
  if (!raw) return '';
  return raw.replace(/^libsql:\/\//i, 'https://').replace(/\/+$/, '');
}

export function encodeValue(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (v instanceof Uint8Array) return { type: 'blob', value: Buffer.from(v).toString('base64') };
  return { type: 'text', value: String(v) };
}

export function decodeValue(v) {
  if (!v || v.type === 'null' || v.value === null || v.value === undefined) return null;
  switch (v.type) {
    case 'integer': return Number(v.value);
    case 'float': return Number(v.value);
    case 'text': return v.value;
    default: return v.value;
  }
}

// Statements are [{ sql, args }] for query/run, or { sql, args, type:'run' } inside batch().
// Returns one result per statement: { rows: [ {col: value} ], changes, lastInsertRowid }.
export function createTursoClient() {
  const base = tursoBaseUrl();
  if (!base) throw new Error('Turso client requested but neither TURSO_HTTP_URL nor TURSO_DATABASE_URL is set');
  const token = process.env.TURSO_AUTH_TOKEN || '';

  async function pipeline(statements) {
    let res;
    try {
      res = await fetch(`${base}/v2/pipeline`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          baton: null,
          requests: statements.map(s => ({
            type: 'execute',
            stmt: { sql: s.sql, args: (s.args || []).map(encodeValue) },
          })),
        }),
      });
    } catch (e) {
      throw new Error(`Turso request failed: ${e.message || e}`);
    }
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const results = data.results || [];
    return statements.map((_, i) => {
      const r = results[i];
      if (!r || r.type === 'error') {
        throw new Error(`Turso statement error: ${r?.error?.message || 'unknown error'}`);
      }
      const result = r.response?.result || {};
      const cols = (result.cols || []).map(c => c.name);
      const rows = (result.rows || []).map(rowArr => {
        const o = {};
        rowArr.forEach((val, idx) => { o[cols[idx]] = decodeValue(val); });
        return o;
      });
      return {
        rows,
        changes: result.affected_row_count ?? 0,
        lastInsertRowid: result.last_insert_rowid != null ? Number(result.last_insert_rowid) : null,
      };
    });
  }

  return {
    kind: 'turso',
    async query(sql, args = []) {
      const [r] = await pipeline([{ sql, args }]);
      return r.rows;
    },
    async run(sql, args = []) {
      const [r] = await pipeline([{ sql, args }]);
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    async batch(statements) {
      const rs = await pipeline(statements);
      return statements.map((s, i) => s.type === 'run'
        ? { changes: rs[i].changes, lastInsertRowid: rs[i].lastInsertRowid }
        : { rows: rs[i].rows });
    },
    async exec(sqlStatements) {
      if (sqlStatements.length) await pipeline(sqlStatements.map(sql => ({ sql })));
    },
  };
}
