import { useEffect, useRef, useState } from 'react';

export function scoreTier(score) {
  if (score >= 70) return 'high';
  if (score >= 45) return 'mid';
  return 'low';
}

// Color-coded lead-score badge. When `reasons` are supplied, clicking the
// badge opens a small popover explaining the score. The popover uses fixed
// positioning (anchored to the button) so it is never clipped by the
// scrollable table/kanban containers.
export default function ScoreBadge({ score, reasons, size = 'md' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const tier = scoreTier(score ?? 0);
  const hasReasons = Array.isArray(reasons) && reasons.length > 0;

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (
        (!btnRef.current || !btnRef.current.contains(e.target)) &&
        (!popRef.current || !popRef.current.contains(e.target))
      ) {
        setOpen(false);
      }
    };
    const dismiss = () => setOpen(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [open ]);

  function toggle(e) {
    e.stopPropagation();
    if (!hasReasons) return;
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const width = 250;
      setPos({
        top: r.bottom + 6,
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      });
    }
    setOpen((o) => !o);
  }

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={`score-badge tier-${tier} size-${size}`}
        title={hasReasons ? 'Click to see why this score' : `Lead score ${score}/100`}
        onClick={toggle}
      >
        {score ?? 0}
      </button>
      {open && hasReasons && (
        <span
          className="score-pop"
          ref={popRef}
          style={{ top: pos.top, left: pos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="score-pop-title">Score {score}/100 — why</span>
          {reasons.map((r, i) => (
            <span className="score-pop-item" key={i}>
              • {r}
            </span>
          ))}
        </span>
      )}
    </>
  );
}
