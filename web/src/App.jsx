import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  downloadAuthed,
  getToken,
  savedEmail,
  emailFromToken,
  clearSession,
  setUnauthorizedHandler,
} from './api';
import Login from './components/Login';
import StatsStrip from './components/StatsStrip';
import Filters from './components/Filters';
import ContractorsTable from './components/ContractorsTable';
import Kanban from './components/Kanban';
import Drawer from './components/Drawer';
import ContractorForm from './components/ContractorForm';
import TasksView from './components/TasksView';
import Toasts from './components/Toasts';

const EMPTY_FILTERS = {
  q: '',
  state: '',
  city: '',
  niche: '',
  whatsapp_status: '',
  stage: '',
  has_email: false,
  has_mobile: false,
};

export default function App() {
  const [auth, setAuth] = useState(() => {
    const token = getToken();
    return token ? { token, email: savedEmail() || emailFromToken(token) } : null;
  });
  const [health, setHealth] = useState(null);
  const [appName, setAppName] = useState('Fencely CRM'); // from /api/meta → appName
  const [meta, setMeta] = useState({ stages: [], niches: [], waStatuses: [] });
  const [stats, setStats] = useState(null);
  const [contractors, setContractors] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [booting, setBooting] = useState(Boolean(auth));
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [view, setView] = useState('table'); // table | kanban | tasks
  const [selectedId, setSelectedId] = useState(null);
  const [formState, setFormState] = useState(null); // { contractor } | null
  const [tasksKey, setTasksKey] = useState(0);
  const [drawerTick, setDrawerTick] = useState(0);
  const [toasts, setToasts] = useState([]);
  const toastSeq = useRef(0);
  // Bulk selection for the table (checkbox column). Cleared whenever the
  // visible list changes or a bulk action runs.
  const [selected, setSelected] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const toast = useCallback((kind, message) => {
    const id = ++toastSeq.current;
    setToasts((ts) => [...ts, { id, kind, message }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4500);
  }, []);
  const dismissToast = useCallback((id) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const logout = useCallback(() => {
    clearSession();
    setAuth(null);
    setSelectedId(null);
    setStats(null);
    setContractors([]);
  }, []);

  // Any 401 from the API layer ends the session and bounces to login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuth(null);
      setSelectedId(null);
      toast('error', 'Your session has expired. Please log in again.');
    });
    return () => setUnauthorizedHandler(null);
  }, [toast]);

  // Product branding comes from the backend (GET /api/meta → appName) so the
  // CRM stays sellable/reusable, not hardcoded to one brand. Loaded before
  // login too so the login screen carries the right name. Falls back to
  // "Fencely CRM" when the backend doesn't provide one.
  useEffect(() => {
    let cancelled = false;
    api
      .meta()
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
        if (m.appName) setAppName(m.appName);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.title = appName;
  }, [appName]);

  const loadStats = useCallback(async () => {
    try {
      setStats(await api.stats());
    } catch (err) {
      if (err.status !== 401) toast('error', err.message);
    }
  }, [toast]);

  // --- Live filters -------------------------------------------------------
  // `filters` is the single controlled state object bound to the controls.
  // Text inputs (search, city) are debounced ~300ms; selects and checkboxes
  // take effect immediately. Any change re-fetches GET /api/contractors with
  // the right query params — no Apply button anywhere.
  const [debouncedText, setDebouncedText] = useState({ q: '', city: '' });
  useEffect(() => {
    const t = setTimeout(() => setDebouncedText({ q: filters.q, city: filters.city }), 300);
    return () => clearTimeout(t);
  }, [filters.q, filters.city]);

  const effectiveFilters = useMemo(
    () => ({ ...filters, q: debouncedText.q, city: debouncedText.city }),
    [filters, debouncedText],
  );
  const filtersKey = JSON.stringify(effectiveFilters);
  const listSeq = useRef(0);

  const loadContractors = useCallback(async () => {
    const seq = ++listSeq.current;
    setLoadingList(true);
    try {
      const f = effectiveFilters;
      const params = {
        q: f.q,
        state: f.state,
        city: f.city,
        niche: f.niche,
        whatsapp_status: f.whatsapp_status,
        stage: f.stage,
        has_email: f.has_email ? 1 : '',
        has_mobile: f.has_mobile ? 1 : '',
      };
      const rows = await api.contractors(params);
      if (seq === listSeq.current) {
        setContractors(rows);
        // Prune the bulk selection to rows still visible (honest count in the bar).
        setSelected((sel) => sel.filter((id) => rows.some((r) => r.id === id)));
      }
    } catch (err) {
      if (err.status !== 401) toast('error', err.message);
    } finally {
      if (seq === listSeq.current) setLoadingList(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, toast]);

  const activeFilterCount = useMemo(
    () =>
      [filters.q, filters.state, filters.city, filters.niche, filters.whatsapp_status, filters.stage].filter(Boolean)
        .length +
      (filters.has_email ? 1 : 0) +
      (filters.has_mobile ? 1 : 0),
    [filters],
  );

  const resetFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setDebouncedText({ q: '', city: '' }); // clear now, don't wait for the debounce
  }, []);

  // --- Bulk actions ------------------------------------------------------
  const toggleSelect = useCallback((id) => {
    setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));
  }, []);
  const toggleSelectAll = useCallback(
    (checked) => {
      setSelected((sel) => {
        if (!checked) return sel.filter((id) => !contractors.some((c) => c.id === id));
        const visible = contractors.map((c) => c.id);
        return [...new Set([...sel, ...visible])];
      });
    },
    [contractors],
  );
  const clearSelection = useCallback(() => setSelected([]), []);

  async function handleBulkDelete() {
    if (!selected.length) return;
    if (!window.confirm(`Delete ${selected.length} selected contractor${selected.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      const r = await api.bulkDelete(selected);
      toast('success', `Deleted ${r.deleted} contractor${r.deleted === 1 ? '' : 's'}.`);
      clearSelection();
      handleMutated();
    } catch (err) {
      toast('error', err.message || 'Bulk delete failed.');
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkStage(stage) {
    if (!selected.length || !stage) return;
    setBulkBusy(true);
    try {
      const r = await api.bulkSetStage(selected, stage);
      toast('success', `Moved ${r.updated} contractor${r.updated === 1 ? '' : 's'} → ${stage}.`);
      clearSelection();
      handleMutated();
    } catch (err) {
      toast('error', err.message || 'Bulk stage change failed.');
    } finally {
      setBulkBusy(false);
    }
  }

  // Something changed (stage move, note, task, log-contact, import…):
  // refresh the stats strip + grid + follow-ups view.
  const handleMutated = useCallback(() => {
    loadStats();
    loadContractors();
    setTasksKey((k) => k + 1);
  }, [loadStats, loadContractors]);

  // Bootstrap once authenticated: health (AI status/version), meta, stats, list.
  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    (async () => {
      setBooting(true);
      try {
        const [h, m] = await Promise.all([api.health().catch(() => null), api.meta()]);
        if (cancelled) return;
        setHealth(h);
        setMeta(m);
        if (m.appName) setAppName(m.appName);
        await loadStats();
      } catch (err) {
        if (!cancelled && err.status !== 401) toast('error', err.message);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth]);

  // Re-fetch whenever the effective filters change (selects/checkboxes
  // instantly, text after its debounce) — this is the live-update effect.
  useEffect(() => {
    if (!auth || booting) return;
    loadContractors();
  }, [auth, booting, loadContractors]);

  const moveStage = useCallback(
    async (contractor, stage) => {
      if (!contractor || contractor.stage === stage) return;
      try {
        await api.updateContractor(contractor.id, { stage });
        toast('success', `${contractor.business_name} → ${stage}`);
        handleMutated();
      } catch (err) {
        toast('error', err.message);
      }
    },
    [handleMutated, toast],
  );

  // One-tap contact logging (drawer + Kanban cards). Re-throws so the caller
  // can clear its busy state; Kanban passes this down and Drawer uses its own
  // local copy of the same flow.
  const logContact = useCallback(
    async (contractor, channel) => {
      try {
        const r = await api.logContact(contractor.id, channel);
        toast('success', (r && r.message) || 'Logged — follow-up set in 4 days');
        handleMutated();
        return r;
      } catch (err) {
        toast('error', err.message);
        throw err;
      }
    },
    [handleMutated, toast],
  );

  const exportParams = useMemo(() => {
    const f = effectiveFilters;
    const p = {
      q: f.q,
      state: f.state,
      city: f.city,
      niche: f.niche,
      whatsapp_status: f.whatsapp_status,
      stage: f.stage,
      has_email: f.has_email ? 1 : '',
      has_mobile: f.has_mobile ? 1 : '',
    };
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '' && v != null)),
    ).toString();
    return qs ? `?${qs}` : '';
  }, [effectiveFilters]);

  async function handleExport() {
    try {
      await downloadAuthed(`/api/export.csv${exportParams}`, 'fencely-crm-export.csv');
      toast('success', 'CSV export downloaded.');
    } catch (err) {
      toast('error', err.message);
    }
  }

  async function handleTemplate() {
    try {
      await downloadAuthed('/api/template.csv', 'fencely-crm-template.csv');
    } catch (err) {
      toast('error', err.message);
    }
  }

  async function handleImport(file) {
    try {
      const text = await file.text();
      const r = await api.importCsv(text);
      const extra = r.skippedNames && r.skippedNames.length ? ` Skipped: ${r.skippedNames.slice(0, 8).join(', ')}${r.skippedNames.length > 8 ? '…' : ''}` : '';
      toast('success', `Import done: ${r.created} created, ${r.skipped} skipped (duplicates/invalid).${extra}`);
      resetFilters(); // show the full list after an import — no leftover filters
      clearSelection();
      handleMutated();
    } catch (err) {
      toast('error', err.message || 'Import failed.');
    }
  }

  function openStageInPipeline(stage) {
    setFilters((f) => ({ ...f, stage }));
    setView('kanban');
  }

  if (!auth) {
    return (
      <>
        <Login onLogin={(a) => setAuth(a)} toast={toast} appName={appName} />
        <Toasts toasts={toasts} dismiss={dismissToast} />
      </>
    );
  }

  const aiOn = Boolean(health && health.aiEnabled);

  return (
    <div className="app">
      <header className="appbar">
        <div className="brand">
          <span className="brand-logo">🧱</span>
          <span className="brand-name">{appName}</span>
          <span className="brand-sub">Contractor outreach • Australia</span>
        </div>
        <nav className="tabs">
          {[
            ['table', 'Table'],
            ['kanban', 'Pipeline'],
            ['tasks', 'Follow-ups'],
          ].map(([v, label]) => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
              {label}
              {v === 'tasks' && stats && stats.followupsDueToday > 0 && (
                <span className="tab-badge">{stats.followupsDueToday}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="appbar-right">
          <span
            className={`ai-dot${aiOn ? ' on' : ''}`}
            title={
              health
                ? `Claude AI: ${aiOn ? 'on' : 'off'}${health.version ? ` • backend v${health.version}` : ''}`
                : 'Checking backend…'
            }
          />
          <span className="ai-label">
            AI: {health ? (aiOn ? 'on' : 'off') : '…'}
            {health?.version ? <span className="muted"> v{health.version}</span> : null}
          </span>
          <span className="user-email" title={auth.email}>{auth.email}</span>
          <button className="btn btn-small" onClick={logout}>Logout</button>
        </div>
      </header>

      <StatsStrip stats={stats} onStageClick={openStageInPipeline} />

      <Filters
        filters={filters}
        setFilters={setFilters}
        meta={meta}
        resultCount={contractors.length}
        totalCount={stats?.total}
        activeCount={activeFilterCount}
        onReset={resetFilters}
        onAdd={() => setFormState({ contractor: null })}
        onExport={handleExport}
        onImport={handleImport}
        onTemplate={handleTemplate}
        busy={loadingList}
      />

      <main className="main">
        {selected.length > 0 && view === 'table' && (
          <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
            <b>{selected.length}</b>&nbsp;selected
            <select
              className="stage-select"
              defaultValue=""
              disabled={bulkBusy}
              onChange={(e) => { if (e.target.value) { handleBulkStage(e.target.value); e.target.value = ''; } }}
              aria-label="Move selected to stage"
            >
              <option value="" disabled>Move to stage…</option>
              {(meta.stages || []).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button className="btn btn-danger btn-small" disabled={bulkBusy} onClick={handleBulkDelete}>
              Delete selected
            </button>
            <button className="btn btn-ghost btn-small" disabled={bulkBusy} onClick={clearSelection}>
              Clear
            </button>
          </div>
        )}
        {view === 'table' && (
          <ContractorsTable
            contractors={contractors}
            meta={meta}
            loading={loadingList}
            total={stats?.total ?? 0}
            selected={selected}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            onOpen={setSelectedId}
            onMoveStage={moveStage}
            onLogContact={logContact}
          />
        )}
        {view === 'kanban' && (
          <Kanban
            contractors={contractors}
            meta={meta}
            onOpen={setSelectedId}
            onMoveStage={moveStage}
            onLogContact={logContact}
          />
        )}
        {view === 'tasks' && (
          <TasksView
            refreshKey={tasksKey}
            onOpenContractor={(id) => {
              setSelectedId(id);
              setView('table');
            }}
            toast={toast}
            onMutated={() => {
              loadStats();
              loadContractors();
            }}
            dueTodayCount={stats?.followupsDueToday}
          />
        )}
      </main>

      {selectedId != null && (
        <Drawer
          id={selectedId}
          meta={meta}
          refreshTick={drawerTick}
          onClose={() => setSelectedId(null)}
          onEdit={(c) => setFormState({ contractor: c })}
          onDeleted={handleMutated}
          onMutated={handleMutated}
          toast={toast}
        />
      )}

      {formState && (
        <ContractorForm
          contractor={formState.contractor}
          meta={meta}
          onClose={() => setFormState(null)}
          onSaved={() => {
            setFormState(null);
            handleMutated();
            setDrawerTick((t) => t + 1); // refresh the drawer if it's open underneath
          }}
          toast={toast}
        />
      )}

      <Toasts toasts={toasts} dismiss={dismissToast} />
    </div>
  );
}
