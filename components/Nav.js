'use client';
import { TABS } from '@/lib/constants';
import { useStore } from '@/store/useStore';

export default function Nav() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const hasData = useStore((s) => !!(s.evalRows || s.fatRows));
  return (
    <nav className="ml-auto flex gap-1 overflow-x-auto">
      {TABS.map((t) => {
        const dis = t.gated && !hasData;
        return (
          <button
            key={t.id}
            className={'tab-btn' + (tab === t.id ? ' active' : '')}
            disabled={dis}
            title={t.tip}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
