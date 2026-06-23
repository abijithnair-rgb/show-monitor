'use client';
// Shared UI for experiment CONSTRAINTS — additional conditions to MAINTAIN while
// chasing the main target (warning-only; they never change the verdict).
//   ConstraintEditor → the "＋ Add constraint" rows used in pickup / add forms.
//   ConstraintChips  → evaluated met/breached chips shown alongside an experiment.
import { CONSTRAINT_METRICS } from '@/lib/ownership';

// rows: [{ metric, op, value }]; onChange(nextRows).
export function ConstraintEditor({ rows, onChange }) {
  const list = rows || [];
  const set = (i, patch) => onChange(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => onChange([...list, { metric: 'supply', op: 'gte', value: '' }]);
  const remove = (i) => onChange(list.filter((_, j) => j !== i));
  const sel = 'border border-slate-300 rounded-md px-2 py-1 text-sm';
  return (
    <div className="flex flex-col gap-2">
      {list.map((r, i) => (
        <div key={i} className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-400">keep</span>
          <select className={sel} value={r.metric} onChange={(e) => set(i, { metric: e.target.value })}>
            {CONSTRAINT_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <select className={sel} value={r.op} onChange={(e) => set(i, { op: e.target.value })}>
            <option value="gte">≥</option>
            <option value="lte">≤</option>
          </select>
          <input type="number" min="0" className={sel + ' w-20'} value={r.value}
            onChange={(e) => set(i, { value: e.target.value })} placeholder="N" />
          <button type="button" className="text-slate-400 hover:text-red-600 text-sm" onClick={() => remove(i)}>✕</button>
        </div>
      ))}
      <button type="button" className="text-xs text-blue-600 hover:underline self-start" onClick={add}>
        ＋ Add constraint
      </button>
    </div>
  );
}

// evaluated: [{ c, value, met, label }] from evalConstraints / evalGroupConstraints.
export function ConstraintChips({ evaluated, prefix = 'Constraint' }) {
  if (!evaluated || !evaluated.length) return null;
  return (
    <div className="flex gap-1 flex-wrap mt-1">
      {evaluated.map((e, i) => (
        <span key={i} className={'chip ' + (e.met ? 'chip-green' : 'chip-red')}
          title={`${prefix}: ${e.label} — current ${e.value == null ? '—' : e.value}`}>
          {e.label} · {e.value == null ? '—' : e.value} {e.met ? '✓' : '✗'}
        </span>
      ))}
    </div>
  );
}
