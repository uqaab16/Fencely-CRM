// API layer for the Fencely CRM React frontend.
//
// Every call goes to the same backend the old vanilla UI used (/api/*).
// A JWT obtained from POST /api/auth/login is stored in localStorage under
// "fencely_jwt" and sent as `Authorization: Bearer <token>` on every request.
// Any 401 clears the session and notifies the app (route guard → login).

const TOKEN_KEY = 'fencely_jwt';
const EMAIL_KEY = 'fencely_user_email';

let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function saveSession(token, email) {
  localStorage.setItem(TOKEN_KEY, token);
  if (email) localStorage.setItem(EMAIL_KEY, email);
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
}
export function savedEmail() {
  return localStorage.getItem(EMAIL_KEY) || '';
}

// Best-effort decode of the email claim from a JWT (display purposes only —
// the backend always re-verifies the signature).
export function emailFromToken(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(part));
    return payload.email || payload.sub || '';
  } catch {
    return '';
  }
}

export class ApiError extends Error {
  constructor(status, data) {
    super((data && (data.error || data.message)) || `Request failed (${status})`);
    this.status = status;
    this.data = data || {};
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearSession();
    if (unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(401, { error: 'Your session has expired. Please log in again.' });
  }
  return res;
}

async function json(path, opts) {
  const res = await request(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  health: () => json('/api/health'),
  meta: () => json('/api/meta'),
  stats: () => json('/api/stats'),

  // Login is a raw fetch (no token yet, and a 401 here means "bad credentials",
  // not "session expired"). Tolerant about the exact response envelope:
  // accepts { token } / { jwt } / { accessToken }, optionally with user.email.
  login: async (email, password) => {
    let res;
    try {
      res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      throw new ApiError(0, { error: 'Could not reach the server. Check your connection and try again.' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(
        res.status,
        res.status === 401 || res.status === 400
          ? { error: data.error || data.message || 'Incorrect email or password.' }
          : data,
      );
    }
    const token = data.token || data.jwt || data.accessToken;
    if (!token) throw new ApiError(200, { error: 'Login succeeded but the server did not return a token.' });
    const userEmail = (data.user && data.user.email) || data.email || emailFromToken(token) || email;
    return { token, email: userEmail };
  },

  contractors: (params = {}) => {
    const clean = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false),
    );
    const qs = new URLSearchParams(clean).toString();
    return json('/api/contractors' + (qs ? `?${qs}` : ''));
  },
  contractor: (id) => json(`/api/contractors/${id}`),
  createContractor: (obj) => json('/api/contractors', { method: 'POST', body: obj }),
  updateContractor: (id, obj) => json(`/api/contractors/${id}`, { method: 'PUT', body: obj }),
  deleteContractor: (id) => json(`/api/contractors/${id}`, { method: 'DELETE' }),
  bulkDelete: (ids) => json('/api/contractors', { method: 'DELETE', body: { ids } }),
  bulkSetStage: (ids, stage) => json('/api/contractors/stage', { method: 'PUT', body: { ids, stage } }),
  addNote: (id, body) => json(`/api/contractors/${id}/notes`, { method: 'POST', body: { body } }),
  // One-tap record of contact made outside the CRM (call / WhatsApp / email).
  // The server bumps last_contacted and auto-creates the follow-up task.
  logContact: (id, channel) => json(`/api/contractors/${id}/log-contact`, { method: 'POST', body: { channel } }),
  draft: (id) => json(`/api/contractors/${id}/draft`, { method: 'POST' }),
  score: (id) => json(`/api/contractors/${id}/score`, { method: 'POST' }),

  tasks: (dueToday = false) => json('/api/tasks' + (dueToday ? '?due=today' : '')),
  createTask: (obj) => json('/api/tasks', { method: 'POST', body: obj }),
  doneTask: (id) => json(`/api/tasks/${id}/done`, { method: 'POST' }),

  importCsv: (csv) => json('/api/import', { method: 'POST', body: { csv } }),
};

// Authenticated file download (export / template). A plain <a href> cannot
// carry the Authorization header, so fetch → blob → synthetic anchor click.
export async function downloadAuthed(path, fallbackName) {
  const res = await request(path);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const match = cd.match(/filename="?([^";]+)"?/);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match ? match[1] : fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
