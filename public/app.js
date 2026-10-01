let META = { stages: [], niches: [], waStatuses: [] };
let current = [];
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const waClass = w => w === 'Advertises WhatsApp' ? 'wa-ok' : w === 'Mobile - unverified' ? 'wa-mid' : 'wa-no';

async function loadMeta() {
  META = await (await fetch('/api/meta')).json();
  for (const s of ['NSW','VIC','QLD','SA','WA','TAS','NT','ACT']) $('#f-state').innerHTML += `<option>${s}</option>`;
  META.niches.forEach(n => $('#f-niche').innerHTML += `<option>${esc(n)}</option>`);
  META.waStatuses.forEach(n => $('#f-wa').innerHTML += `<option>${esc(n)}</option>`);
  META.stages.forEach(n => $('#f-stage').innerHTML += `<option>${esc(n)}</option>`);
}
function filters() {
  const f = { q: $('#q').value, state: $('#f-state').value, city: $('#f-city').value, niche: $('#f-niche').value, whatsapp_status: $('#f-wa').value, stage: $('#f-stage').value };
  if ($('#f-email').checked) f.has_email = 1;
  if ($('#f-mobile').checked) f.has_mobile = 1;
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v));
}
async function refresh() {
  const s = await (await fetch('/api/stats')).json();
  $('#stats').innerHTML = [['Total contractors', s.total], ['WhatsApp advertised', s.whatsappAdvertised], ['Contacted', s.contacted], ['Replied', s.replied], ['Interested+', s.interested], ['Follow-ups due', s.followupsDueToday]].map(([k, v]) => `<div class="stat"><b>${v}</b>${k}</div>`).join('');
  const qs = new URLSearchParams(filters());
  current = await (await fetch('/api/contractors?' + qs)).json();
  renderTable(); renderKanban(); renderTasks();
}
function renderTable() {
  $('#rows').innerHTML = current.map(c => `<tr data-id="${c.id}"><td><b>${esc(c.business_name)}</b><br><small>${esc(c.contact_name || '')}</small></td><td>${esc(c.state)}<br>${esc(c.city)}${c.suburb ? ' · ' + esc(c.suburb) : ''}</td><td>${c.niches.map(n => `<span class="tag">${esc(n)}</span>`).join('')}</td><td>${esc(c.landline)}</td><td>${esc(c.mobile)}</td><td class="${waClass(c.whatsapp_status)}">${esc(c.whatsapp_number || '')}<br><small>${esc(c.whatsapp_status)}</small></td><td>${esc(c.email)}</td><td>${esc(c.stage)}</td><td class="score">${c.lead_score}</td><td>${esc(c.next_followup || '')}</td></tr>`).join('');
  document.querySelectorAll('#rows tr').forEach(tr => tr.onclick = () => openDrawer(tr.dataset.id));
}
function renderKanban() {
  $('#kanban').innerHTML = META.stages.map(st => `<div class="col"><h4>${esc(st)} (${current.filter(c => c.stage === st).length})</h4>${current.filter(c => c.stage === st).map(c => `<div class="card" data-id="${c.id}"><b>${esc(c.business_name)}</b><br><small>${esc(c.city)} ${esc(c.state)} • Score ${c.lead_score}</small><br>${c.niches.map(n => `<span class="tag">${esc(n)}</span>`).join('')}</div>`).join('')}</div>`).join('');
  document.querySelectorAll('.card').forEach(el => el.onclick = () => openDrawer(el.dataset.id));
}
async function renderTasks() {
  const due = await (await fetch('/api/tasks?due=today')).json();
  const all = await (await fetch('/api/tasks')).json();
  const li = t => `<li>${t.done ? '✅' : '⏳'} ${esc(t.title)} — ${esc(t.business_name || '')} ${t.due_date ? '(due ' + esc(t.due_date) + ')' : ''} ${t.done ? '' : `<button data-done="${t.id}">Mark done</button>`}</li>`;
  $('#dueList').innerHTML = due.map(li).join('') || '<li>None due 🎉</li>';
  $('#taskList').innerHTML = all.map(li).join('');
  document.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => { await fetch(`/api/tasks/${b.dataset.done}/done`, { method: 'POST' }); refresh(); });
}
async function openDrawer(id) {
  const c = await (await fetch('/api/contractors/' + id)).json();
  const d = $('#drawer');
  d.classList.remove('hidden');
  d.innerHTML = `<button onclick="document.querySelector('#drawer').classList.add('hidden')">✕ Close</button>
  <h2>${esc(c.business_name)}</h2>
  <p>${esc(c.city)}${c.suburb ? ', ' + esc(c.suburb) : ''} ${esc(c.state)} • Stage: <b>${esc(c.stage)}</b> • Lead score: <b>${c.lead_score}/100</b></p>
  <p>${c.niches.map(n => `<span class="tag">${esc(n)}</span>`).join('')}</p>
  <p>☎ Landline: ${esc(c.landline || '—')}<br>📱 Mobile: ${esc(c.mobile || '—')}<br>💬 WhatsApp: <span class="${waClass(c.whatsapp_status)}">${esc(c.whatsapp_number || '—')} (${esc(c.whatsapp_status)})</span><br>✉ ${esc(c.email || '—')}<br>🌐 ${esc(c.website || '—')}<br>Source: ${esc(c.source || '—')}</p>
  <p>Last contacted: ${esc(c.last_contacted || '—')} • Next follow-up: ${esc(c.next_followup || '—')} • Outcome: ${esc(c.outcome || '—')}</p>
  <p><b>Score reasons:</b> ${(c.score_reasons || []).join('; ') || '—'}</p>
  <p><b>Notes:</b> ${esc(c.notes || '')}</p>
  <button id="editBtn">Edit</button> <button id="draftBtn">✨ Draft outreach (Claude)</button> <button id="delBtn">Delete</button>
  <h3>Timeline</h3>
  <form id="noteForm"><input id="noteBody" placeholder="Add note/activity…" style="width:75%"><button>Add</button></form>
  ${(c.activities || []).map(a => `<div class="activity"><small>${esc(a.created_at)} • ${esc(a.type)}</small><br>${esc(a.body)}</div>`).join('')}
  <h3>Tasks</h3>${(c.tasks || []).map(t => `<div class="activity">${t.done ? '✅' : '⏳'} ${esc(t.title)} ${esc(t.due_date || '')}</div>`).join('')}`;
  $('#noteForm').onsubmit = async e => { e.preventDefault(); await fetch(`/api/contractors/${id}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: $('#noteBody').value }) }); openDrawer(id); refresh(); };
  $('#editBtn').onclick = () => openEdit(c);
  $('#delBtn').onclick = async () => { if (confirm('Delete this contractor?')) { await fetch('/api/contractors/' + id, { method: 'DELETE' }); d.classList.add('hidden'); refresh(); } };
  $('#draftBtn').onclick = async () => { const r = await (await fetch(`/api/contractors/${id}/draft`, { method: 'POST' })).json(); alert((r.enabled ? 'Claude draft:\n\n' : 'Local template (Claude off — set ANTHROPIC_API_KEY):\n\n') + (r.draft || r.message)); };
}
function openEdit(c = {}) {
  const niches = META.niches.map(n => `<label style="display:inline-block;margin-right:8px"><input type="checkbox" name="niche" value="${esc(n)}" ${c.niches?.includes(n) ? 'checked' : ''} style="width:auto"> ${esc(n)}</label>`).join('');
  $('#editForm').innerHTML = `<h3>${c.id ? 'Edit' : 'Add'} contractor</h3>
  ${[['business_name','Business name *'],['contact_name','Contact name'],['state','State (NSW/VIC/QLD…)'],['city','City'],['suburb','Suburb'],['landline','Landline'],['mobile','Mobile'],['whatsapp_number','WhatsApp number'],['email','Public email'],['website','Website'],['source','Source']].map(([k, l]) => `<label>${l}<input name="${k}" value="${esc(c[k] || '')}"></label>`).join('')}
  <label>WhatsApp status<select name="whatsapp_status">${META.waStatuses.map(w => `<option ${c.whatsapp_status === w ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select></label>
  <label>Stage<select name="stage">${META.stages.map(w => `<option ${c.stage === w ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select></label>
  <div>Niches:<br>${niches}</div>
  <label>Last contacted<input type="date" name="last_contacted" value="${esc(c.last_contacted || '')}"></label>
  <label>Next follow-up<input type="date" name="next_followup" value="${esc(c.next_followup || '')}"></label>
  <label>Outcome<input name="outcome" value="${esc(c.outcome || '')}"></label>
  <label>Notes<textarea name="notes">${esc(c.notes || '')}</textarea></label>
  <button>${c.id ? 'Save' : 'Create'}</button> <button type="button" onclick="document.querySelector('#editDlg').close()">Cancel</button>`;
  $('#editDlg').showModal();
  $('#editForm').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target); const obj = Object.fromEntries(fd);
    obj.niches = [...e.target.querySelectorAll('[name=niche]:checked')].map(x => x.value);
    const url = c.id ? '/api/contractors/' + c.id : '/api/contractors';
    const r = await fetch(url, { method: c.id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
    if (r.status === 409) { const d = await r.json(); if (confirm('Possible duplicate: ' + d.duplicates.map(x => x.business_name).join(', ') + '\nCreate anyway?')) { obj.force = true; await fetch(url, { method: c.id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }); } else return; }
    $('#editDlg').close(); refresh();
  };
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.remove('active')); b.classList.add('active');
  $('#tableView').classList.toggle('hidden', b.dataset.view !== 'table');
  $('#kanbanView').classList.toggle('hidden', b.dataset.view !== 'kanban');
  $('#tasksView').classList.toggle('hidden', b.dataset.view !== 'tasks');
});
['q','f-city'].forEach(id => $('#' + id).addEventListener('input', refresh));
['f-state','f-niche','f-wa','f-stage','f-email','f-mobile'].forEach(id => $('#' + id).addEventListener('change', refresh));
$('#addBtn').onclick = () => openEdit({});
$('#exportBtn').onclick = () => location.href = '/api/export.csv?' + new URLSearchParams(filters());
$('#importFile').onchange = async e => {
  const text = await e.target.files[0].text();
  const r = await (await fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv: text }) })).json();
  alert(`Import done: ${r.created} created, ${r.skipped} skipped (duplicates/invalid)${r.skippedNames?.length ? ': ' + r.skippedNames.join(', ') : ''}`);
  refresh();
};
$('#taskForm').onsubmit = async e => { e.preventDefault(); await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: $('#t-title').value, due_date: $('#t-due').value }) }); e.target.reset(); refresh(); };
loadMeta().then(refresh);
