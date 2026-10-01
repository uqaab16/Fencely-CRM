import { useRef } from 'react';

const AU_STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-AU') : '0');

// Sticky live filter bar. Every control is bound to the single controlled
// `filters` object in App; changing any of them re-fetches the contractor
// list immediately (text inputs are debounced ~300ms in App) — no Apply
// button. Active controls are tinted, active filters appear as removable
// chips, and the bar shows a live results count + Reset button.
export default function Filters({
  filters,
  setFilters,
  meta,
  resultCount,
  totalCount,
  activeCount,
  onReset,
  onAdd,
  onExport,
  onImport,
  onTemplate,
  busy,
}) {
  const fileRef = useRef(null);
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  function pickFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-importing the same file
    if (file) onImport(file);
  }

  const chips = [
    filters.q && { key: 'q', label: `Search: “${filters.q}”`, clear: () => set('q', '') },
    filters.state && { key: 'state', label: `State: ${filters.state}`, clear: () => set('state', '') },
    filters.city && { key: 'city', label: `City: ${filters.city}`, clear: () => set('city', '') },
    filters.niche && { key: 'niche', label: `Niche: ${filters.niche}`, clear: () => set('niche', '') },
    filters.whatsapp_status && {
      key: 'whatsapp_status',
      label: `WhatsApp: ${filters.whatsapp_status}`,
      clear: () => set('whatsapp_status', ''),
    },
    filters.stage && { key: 'stage', label: `Stage: ${filters.stage}`, clear: () => set('stage', '') },
    filters.has_email && { key: 'has_email', label: 'Has email', clear: () => set('has_email', false) },
    filters.has_mobile && { key: 'has_mobile', label: 'Has mobile', clear: () => set('has_mobile', false) },
  ].filter(Boolean);

  return (
    <section className="filters">
      <input
        className={`f-search${filters.q ? ' is-active' : ''}`}
        placeholder="Search business, city, email, phone…"
        value={filters.q}
        onChange={(e) => set('q', e.target.value)}
      />
      <select
        className={filters.state ? 'is-active' : ''}
        value={filters.state}
        onChange={(e) => set('state', e.target.value)}
      >
        <option value="">All states</option>
        {AU_STATES.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <input
        className={`f-city${filters.city ? ' is-active' : ''}`}
        placeholder="City filter"
        value={filters.city}
        onChange={(e) => set('city', e.target.value)}
      />
      <select
        className={filters.niche ? 'is-active' : ''}
        value={filters.niche}
        onChange={(e) => set('niche', e.target.value)}
      >
        <option value="">All niches</option>
        {(meta.niches || []).map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <select
        className={filters.whatsapp_status ? 'is-active' : ''}
        value={filters.whatsapp_status}
        onChange={(e) => set('whatsapp_status', e.target.value)}
      >
        <option value="">WhatsApp: any</option>
        {(meta.waStatuses || []).map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <select
        className={filters.stage ? 'is-active' : ''}
        value={filters.stage}
        onChange={(e) => set('stage', e.target.value)}
      >
        <option value="">Stage: any</option>
        {(meta.stages || []).map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <label className={`check${filters.has_email ? ' is-active-check' : ''}`}>
        <input type="checkbox" checked={filters.has_email} onChange={(e) => set('has_email', e.target.checked)} />
        Has email
      </label>
      <label className={`check${filters.has_mobile ? ' is-active-check' : ''}`}>
        <input type="checkbox" checked={filters.has_mobile} onChange={(e) => set('has_mobile', e.target.checked)} />
        Has mobile
      </label>

      <span className="filters-spacer" />

      <button className="btn btn-primary" onClick={onAdd}>+ Add contractor</button>
      <button className="btn" onClick={onExport} disabled={busy}>Export CSV</button>
      <button className="btn" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>
        Import CSV
      </button>
      <input ref={fileRef} type="file" accept=".csv" hidden onChange={pickFile} />
      <button className="btn btn-ghost" onClick={onTemplate} disabled={busy}>CSV template</button>

      <div className="filter-status">
        <span className="result-count" aria-live="polite">
          <b>{fmt(resultCount)}</b> contractor{resultCount === 1 ? '' : 's'}
          {activeCount > 0 && typeof totalCount === 'number' && (
            <span className="muted"> — filtered from {fmt(totalCount)}</span>
          )}
          {busy && <span className="muted"> • updating…</span>}
        </span>
        {chips.length > 0 && (
          <span className="filter-chips">
            {chips.map((chip) => (
              <button key={chip.key} className="chip" onClick={chip.clear} title="Remove this filter">
                {chip.label} <span className="chip-x">✕</span>
              </button>
            ))}
          </span>
        )}
        <button className="btn btn-small reset-btn" onClick={onReset} disabled={activeCount === 0}>
          Reset filters
        </button>
      </div>
    </section>
  );
}
