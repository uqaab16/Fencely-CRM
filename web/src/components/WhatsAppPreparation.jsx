import { useEffect, useState } from 'react';
import { api } from '../api';
const LABELS = { available: 'WhatsApp available', not_found: 'Not found — unconfirmed', check_failed: 'Check failed — unknown', invalid: 'Invalid/missing number', skipped: 'Excluded', duplicate: 'Duplicate number', stale: 'Changed — excluded', checking: 'Checking', completing: 'Saving check' };
export default function WhatsAppPreparation({ toast }) {
  const [city, setCity] = useState('Sydney'), [state, setState] = useState('NSW');
  const [rows, setRows] = useState([]), [job, setJob] = useState(null), [busy, setBusy] = useState(false);
  async function list() { try { setRows(await api.preparations()); } catch (e) { toast('error', e.message); } }
  async function open(id) { try { setJob(await api.preparation(id)); } catch (e) { toast('error', e.message); } }
  useEffect(() => { list(); }, []);
  useEffect(() => {
    if (!job || job.status !== 'checking') return;
    const timer = setInterval(() => open(job.id), 10000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  async function prepare() {
    setBusy(true);
    try { setJob(await api.prepareWhatsAppList({ city, state, target: 20 })); await list(); }
    catch (e) { toast('error', e.message); }
    finally { setBusy(false); }
  }
  return <section style={{ border: '1px solid #d5ded8', padding: 16, margin: '16px 0' }}>
    <h3>Find 20 WhatsApp-available contacts</h3>
    <p>Checks contacts in order, regardless of landline/mobile/WhatsApp labels. Continues through the city until 20 distinct available numbers are found or contacts run out. No messages are sent.</p>
    <label>City <input value={city} maxLength={100} onChange={e => setCity(e.target.value)} /></label>{' '}
    <label>State <input value={state} maxLength={3} onChange={e => setState(e.target.value.toUpperCase())} /></label>{' '}
    <button className="btn" disabled={busy || !city.trim()} onClick={prepare}>Prepare verified list</button>{' '}
    <button className="btn" onClick={list}>Refresh lists</button>
    {rows.map(r => <p key={r.id}><button className="btn" onClick={() => open(r.id)}>{r.city} / {r.region} · {r.created_at.slice(0,10)}</button></p>)}
    {job && <div role="status" aria-live="polite">
      <p>{job.available_count}/{job.target} available · {job.processed}/{job.total_candidates} contacts processed · {job.status}</p>
      <button className="btn" onClick={() => open(job.id)}>Reload list status</button>
      {job.status === 'exhausted' && <p>City contacts exhausted. Only {job.available_count} available numbers found.</p>}
      {job.status === 'needs_refresh' && <p>A previously ready contact changed or is no longer eligible. Prepare a new list.</p>}
      <p>List ID for Claude: {job.id}. Ask Claude to read it using get_whatsapp_preparation. Permission checks remain separate before campaign Start.</p>
      <details><summary>Check results</summary><table style={{ width: '100%', marginTop: 12 }}><thead><tr><th>Lead</th><th>Number</th><th>Result</th></tr></thead><tbody>
        {job.results.map(r => <tr key={r.contractor_id}><td>{r.business_name}</td><td>{r.number ? '+' + r.number : 'Missing/invalid'}</td><td>{LABELS[r.status] || r.status}</td></tr>)}
      </tbody></table></details>
    </div>}
  </section>;
}
