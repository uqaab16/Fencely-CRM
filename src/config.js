// Product configuration — branding + vocabulary, overridable via env so the
// CRM can be rebranded/resold later without code changes. All defaults are the
// current Fencely-flavoured values; nothing else in the codebase hardcodes them.
//
//   APP_NAME        (default "Fencely CRM")   — returned by /api/meta as appName
//   NICHES_JSON     (default fence niches)    — JSON array of niche names
//   STAGES_JSON     (default pipeline)        — JSON array of stage names
//   FIT_NICHES_JSON (default scoring "fit" niches)
//
// Invalid/empty JSON falls back to the defaults with a warning — a typo in
// config must never break the CRM. Note: stage-dependent logic (stats buckets,
// log-contact transitions) is written against the DEFAULT stage names;
// overriding stages is a vocabulary change, so keep those names if you rely on
// the built-in transitions.

export const DEFAULT_NICHES = ['Colorbond','Timber','Pool Fencing','Aluminium/Slat','Rural/Farm','Commercial/Security','Gates/Automation','Retaining','Other'];
export const DEFAULT_STAGES = ['New','Researched','Ready to Contact','Contacted','Follow-up Due','Replied','Interested','Trial/Demo','Customer','Do Not Contact'];
export const DEFAULT_FIT_NICHES = ['Colorbond','Timber','Pool Fencing','Aluminium/Slat'];

export function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return [...fallback];
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && v.trim())) {
      return value.map(v => v.trim());
    }
    throw new Error('expected a non-empty JSON array of strings');
  } catch (e) {
    console.warn(`[config] ${name} is invalid (${e.message}); falling back to defaults.`);
    return [...fallback];
  }
}

export const APP_NAME = (process.env.APP_NAME || '').trim() || 'Fencely CRM';
export const NICHES = parseJsonEnv('NICHES_JSON', DEFAULT_NICHES);
export const STAGES = parseJsonEnv('STAGES_JSON', DEFAULT_STAGES);
export const FIT_NICHES = parseJsonEnv('FIT_NICHES_JSON', DEFAULT_FIT_NICHES);
