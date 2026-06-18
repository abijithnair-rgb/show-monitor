'use client';
import { useEffect } from 'react';
import { useStore } from '@/store/useStore';
import Nav from '@/components/Nav';
import Tooltip from '@/components/Tooltip';
import DataTab from '@/components/tabs/DataTab';
import RcaTab from '@/components/tabs/RcaTab';
import ExplorerTab from '@/components/tabs/ExplorerTab';
import ActionQueueTab from '@/components/tabs/ActionQueueTab';
import ExperimentsTab from '@/components/tabs/ExperimentsTab';
import NewShowExperimentsTab from '@/components/tabs/NewShowExperimentsTab';
import ShowManagerTab from '@/components/tabs/ShowManagerTab';
import DeepDiveTab from '@/components/tabs/DeepDiveTab';
import GuidelineTab from '@/components/tabs/GuidelineTab';
import StaleBanner from '@/components/Banners';
import Logo from '@/components/Logo';

function EmptyState() {
  const setTab = useStore((s) => s.setTab);
  return (
    <div className="card p-10 text-center max-w-md mx-auto mt-10">
      <div className="text-4xl mb-3">🗂️</div>
      <div className="text-lg font-semibold">No data loaded yet</div>
      <p className="text-sm text-slate-500 mt-1 mb-4">Upload at least one CSV to see show intelligence.</p>
      <button className="btn btn-primary" onClick={() => setTab('data')}>Go to Data tab</button>
    </div>
  );
}

export default function Page() {
  const hydrate = useStore((s) => s.hydrate);
  const hydrated = useStore((s) => s.hydrated);
  const tab = useStore((s) => s.tab);
  const hasData = useStore((s) => !!(s.evalRows || s.fatRows));

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // After hydration, auto-sync once (silent — the Data tab shows any error).
  useEffect(() => {
    if (!hydrated) return;
    useStore.getState().autoSync({ silent: true });
  }, [hydrated]);

  // Daily auto-refresh at 7:30am local time (while the app is open). Schedules the
  // next 7:30, syncs, then reschedules. On-load sync above covers closed-overnight.
  useEffect(() => {
    if (!hydrated) return;
    let timer;
    const msUntilNext730 = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(7, 30, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return next - now;
    };
    const arm = () => {
      timer = setTimeout(() => {
        useStore.getState().autoSync({ silent: true });
        arm(); // reschedule for the following day
      }, msUntilNext730());
    };
    arm();
    return () => clearTimeout(timer);
  }, [hydrated]);

  let content = null;
  if (!hydrated) {
    content = <div className="text-sm text-slate-400 mt-10 text-center">Loading…</div>;
  } else if (tab !== 'data' && tab !== 'guide' && tab !== 'rca' && tab !== 'nse' && !hasData) {
    content = <EmptyState />;
  } else if (tab === 'data') content = <DataTab />;
  else if (tab === 'rca') content = <RcaTab />;
  else if (tab === 'explorer') content = (<><StaleBanner /><ExplorerTab /></>);
  else if (tab === 'queue') content = (<><StaleBanner /><ActionQueueTab /></>);
  else if (tab === 'experiments') content = (<><StaleBanner /><ExperimentsTab /></>);
  else if (tab === 'nse') content = (<><StaleBanner /><NewShowExperimentsTab /></>);
  else if (tab === 'manager') content = (<><StaleBanner /><ShowManagerTab /></>);
  else if (tab === 'deep') content = (<><StaleBanner /><DeepDiveTab /></>);
  else if (tab === 'guide') content = <GuidelineTab />;

  return (
    <>
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="max-w-[1320px] mx-auto px-5 py-3 flex items-center gap-3">
          <Logo />
          <div>
            <div className="font-semibold leading-tight">Seekho Show Monitor</div>
            <div className="text-xs text-slate-500 leading-tight">Lifecycle verdict × fatigue diagnosis — reconciled into one call per show.</div>
          </div>
          <Nav />
        </div>
      </header>
      <main className="max-w-[1320px] mx-auto px-5 py-5">{content}</main>
      <Tooltip />
    </>
  );
}
