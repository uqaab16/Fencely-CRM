import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

const todayStr = () => new Date().toISOString().slice(0, 10);

function TaskRow({ task, onDone, onOpenContractor }) {
  const overdue = !task.done && task.due_date && task.due_date < todayStr();
  return (
    <li className={`task-row${task.done ? ' task-done' : ''}${overdue ? ' task-overdue' : ''}`}>
      <span className="task-ic">{task.done ? '✅' : overdue ? '🔴' : '⏳'}</span>
      <span className="task-main">
        {task.title}
        {task.business_name && (
          <>
            {' — '}
            {task.contractor_id && onOpenContractor ? (
              <button className="link-btn" onClick={() => onOpenContractor(task.contractor_id)}>
                {task.business_name}
              </button>
            ) : (
              task.business_name
            )}
          </>
        )}
        {task.due_date && (
          <span className="task-due"> (due {task.due_date}{overdue ? ' — overdue' : ''})</span>
        )}
      </span>
      {!task.done && (
        <button className="btn btn-small" onClick={() => onDone(task)}>
          Mark done
        </button>
      )}
    </li>
  );
}

// Follow-ups view: due-today/overdue queue + every task + quick-add form.
// `dueTodayCount` comes from GET /api/stats (followupsDueToday) so the header
// summary matches the dashboard strip.
export default function TasksView({ refreshKey, onOpenContractor, toast, onMutated, dueTodayCount }) {
  const [due, setDue] = useState([]);
  const [all, setAll] = useState([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, a] = await Promise.all([api.tasks(true), api.tasks(false)]);
      setDue(d);
      setAll(a);
    } catch (err) {
      toast('error', err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function markDone(task) {
    try {
      await api.doneTask(task.id);
      toast('success', `Done: ${task.title}`);
      load();
      onMutated && onMutated();
    } catch (err) {
      toast('error', err.message);
    }
  }

  async function addTask(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setAdding(true);
    try {
      await api.createTask({ title: title.trim(), due_date: dueDate || '' });
      setTitle('');
      setDueDate('');
      toast('success', 'Task added.');
      load();
    } catch (err) {
      toast('error', err.message);
    } finally {
      setAdding(false);
    }
  }

  if (loading && !all.length) {
    return (
      <div className="panel empty">
        <div className="spinner" /> Loading tasks…
      </div>
    );
  }

  return (
    <div className="panel tasks-panel">
      <div className="followup-summary">
        <span className="followup-count">{dueTodayCount ?? due.length}</span>
        <span>due today / overdue — work through these first.</span>
      </div>
      <h3>Follow-ups due today / overdue</h3>
      {due.length === 0 ? (
        <p className="empty-sub">None due 🎉</p>
      ) : (
        <ul className="task-list">
          {due.map((t) => (
            <TaskRow key={t.id} task={t} onDone={markDone} onOpenContractor={onOpenContractor} />
          ))}
        </ul>
      )}

      <h3>All tasks</h3>
      {all.length === 0 ? (
        <p className="empty-sub">No tasks yet — add your first follow-up below.</p>
      ) : (
        <ul className="task-list">
          {all.map((t) => (
            <TaskRow key={t.id} task={t} onDone={markDone} onOpenContractor={onOpenContractor} />
          ))}
        </ul>
      )}

      <form className="task-form" onSubmit={addTask}>
        <input placeholder="New task title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        <button className="btn btn-primary" disabled={adding}>
          {adding ? 'Adding…' : 'Add task'}
        </button>
      </form>
    </div>
  );
}
