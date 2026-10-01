// Outbound Anthropic (Claude) API hooks — OFF unless ANTHROPIC_API_KEY is set.
// Keys are read from the environment ONLY. Never hardcode a key here.
// Product name + niche vocabulary come from src/config.js (env-overridable).
import { APP_NAME, NICHES } from '../src/config.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

export function aiEnabled() { return !!process.env.ANTHROPIC_API_KEY; }

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function disabled(feature) {
  return { enabled: false, feature, message: 'AI is disabled: set ANTHROPIC_API_KEY in .env to enable Claude-powered features. No data was sent anywhere.' };
}

export async function classifyNiches(contractor) {
  if (!aiEnabled()) return disabled('classifyNiches');
  const text = await callClaude(`From this fence contractor info, return ONLY a JSON array of niches from [${NICHES.join(', ')}].\nBusiness: ${contractor.business_name}\nWebsite: ${contractor.website || ''}\nNotes: ${contractor.notes || ''}`);
  return { enabled: true, niches: text };
}

export async function explainScore(contractor) {
  // Rule-based explanation is always available locally; Claude only rephrases if enabled.
  const local = { score: contractor.lead_score, reasons: contractor.score_reasons || [] };
  if (!aiEnabled()) return { enabled: false, ...local, message: 'Local rule-based score (Claude rephrase disabled — no ANTHROPIC_API_KEY).' };
  const text = await callClaude(`Explain this ${APP_NAME} lead score in 2 friendly sentences for the business owner. Score: ${local.score}/100. Reasons: ${local.reasons.join('; ')}`);
  return { enabled: true, ...local, explanation: text };
}

export async function generateOutreachDraft(contractor) {
  if (!aiEnabled()) {
    return { ...disabled('generateOutreachDraft'), draft: `Hi ${contractor.business_name} team — I built ${APP_NAME}, a fence visualiser + instant quoting tool for Aussie fence contractors. Contractors use it to measure a property on a map, pick a fence style for a real-time quote, and draw the fence on the client's own yard photo. Would a quick look be useful? Happy to send a short demo link. (Local template — enable ANTHROPIC_API_KEY for Claude-personalised drafts.)` };
  }
  const text = await callClaude(`Write a short, warm, non-spammy first outreach message (max 90 words, no hype, one clear CTA) from Amir, founder of ${APP_NAME} — a fence visualiser and real-time quoting tool for Australian fence contractors (map measurements, style-based instant quotes, drawing a fence on the client's yard photo).\nContractor: ${contractor.business_name}, ${contractor.city} ${contractor.state}, niches: ${(contractor.niches || []).join(', ')}. Personalise the opening to their niche/city. Do not claim a prior relationship.`);
  return { enabled: true, draft: text };
}
