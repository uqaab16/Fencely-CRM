export const CSV_COLUMNS = ['business_name','contact_name','state','city','suburb','niches','landline','mobile','whatsapp_number','whatsapp_status','email','website','source','stage','last_contacted','next_followup','outcome','notes'];

export function toCsv(rows) {
  const esc = v => {
    const s = Array.isArray(v) ? v.join(';') : String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...rows.map(r => CSV_COLUMNS.map(c => esc(r[c])).join(','))].join('\n');
}

export function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = r[idx] ?? ''; });
    if (typeof obj.niches === 'string') obj.niches = obj.niches.split(';').map(s => s.trim()).filter(Boolean);
    return obj;
  });
}
