import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

const AU_STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

const TEXT_FIELDS = [
  ['business_name', 'Business name *'],
  ['contact_name', 'Contact name'],
  ['city', 'City'],
  ['suburb', 'Suburb'],
  ['landline', 'Landline'],
  ['mobile', 'Mobile'],
  ['whatsapp_number', 'WhatsApp number'],
  ['email', 'Public email'],
  ['website', 'Website'],
  ['source', 'Source'],
];

// Shared Add/Edit contractor form (modal). `contractor` empty {} = create.
// A 409 from the backend shows the possible duplicates and offers a
// "Create anyway" (force) resubmit on create.
export default function ContractorForm({ contractor, meta, onClose, onSaved, toast }) {
  const isEdit = Boolean(contractor && contractor.id);
  const [form, setForm] = useState({});
  const [dupes, setDupes] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm({
      business_name: contractor?.business_name || '',
      contact_name: contractor?.contact_name || '',
      state: contractor?.state || '',
      city: contractor?.city || '',
      suburb: contractor?.suburb || '',
      landline: contractor?.landline || '',
      mobile: contractor?.mobile || '',
      whatsapp_number: contractor?.whatsapp_number || '',
      whatsapp_status: contractor?.whatsapp_status || 'Unknown',
      email: contractor?.email || '',
      website: contractor?.website || '',
      source: contractor?.source || '',
      stage: contractor?.stage || 'New',
      niches: contractor?.niches || [],
      last_contacted: contractor?.last_contacted || '',
      next_followup: contractor?.next_followup || '',
      outcome: contractor?.outcome || '',
      notes: contractor?.notes || '',
    });
    setDupes(null);
  }, [contractor]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleNiche = (n, checked) =>
    setForm((f) => ({ ...f, niches: checked ? [...f.niches, n] : f.niches.filter((x) => x !== n) }));

  async function submit(force = false) {
    setBusy(true);
    try {
      const payload = { ...form, ...(force ? { force: true } : {}) };
      if (isEdit) {
        await api.updateContractor(contractor.id, payload);
        toast('success', `${form.business_name} updated.`);
      } else {
        await api.createContractor(payload);
        toast('success', `${form.business_name} added to the CRM.`);
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data.duplicates) {
        setDupes(err.data.duplicates);
      } else {
        toast('error', err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{isEdit ? 'Edit contractor' : 'Add contractor'}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(false);
          }}
        >
          <div className="form-grid">
            {TEXT_FIELDS.map(([k, label]) => (
              <label className="field" key={k}>
                <span>{label}</span>
                <input
                  value={form[k] || ''}
                  onChange={(e) => set(k, e.target.value)}
                  required={k === 'business_name'}
                />
              </label>
            ))}

            <label className="field">
              <span>State (NSW/VIC/QLD…)</span>
              <input
                list="au-states"
                value={form.state || ''}
                onChange={(e) => set('state', e.target.value.toUpperCase())}
                placeholder="NSW"
              />
              <datalist id="au-states">
                {AU_STATES.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </label>

            <label className="field">
              <span>WhatsApp status</span>
              <select value={form.whatsapp_status} onChange={(e) => set('whatsapp_status', e.target.value)}>
                {(meta.waStatuses || []).map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Stage</span>
              <select value={form.stage} onChange={(e) => set('stage', e.target.value)}>
                {(meta.stages || []).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Last contacted</span>
              <input type="date" value={form.last_contacted || ''} onChange={(e) => set('last_contacted', e.target.value)} />
            </label>
            <label className="field">
              <span>Next follow-up</span>
              <input type="date" value={form.next_followup || ''} onChange={(e) => set('next_followup', e.target.value)} />
            </label>
            <label className="field">
              <span>Outcome</span>
              <input value={form.outcome || ''} onChange={(e) => set('outcome', e.target.value)} />
            </label>
          </div>

          <div className="field">
            <span>Niches</span>
            <div className="niche-checks">
              {(meta.niches || []).map((n) => (
                <label className="check" key={n}>
                  <input
                    type="checkbox"
                    checked={(form.niches || []).includes(n)}
                    onChange={(e) => toggleNiche(n, e.target.checked)}
                  />
                  {n}
                </label>
              ))}
            </div>
          </div>

          <label className="field">
            <span>Notes</span>
            <textarea rows={3} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} />
          </label>

          {dupes && (
            <div className="dupe-box" role="alert">
              <b>Possible duplicate</b> — this looks like{' '}
              {dupes.map((d) => d.business_name).join(', ')}. Check the list for an existing record first.
              <div className="dupe-actions">
                <button type="button" className="btn btn-danger" onClick={() => submit(true)} disabled={busy}>
                  Create anyway
                </button>
                <button type="button" className="btn" onClick={() => setDupes(null)}>
                  Go back and check
                </button>
              </div>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add contractor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
