'use client';
import { Line, Bar, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { num, pickv } from '@/lib/format';
import { globalBars } from '@/lib/metrics';
import { AUDIENCE_SOURCES } from '@/lib/model';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler);

// Contribution % over last 4 calendar weeks vs GLOBAL stop/retain bars.
export function TrajectoryChart({ ev, evalRows }) {
  const pts = [
    ['W-3', num(ev.l3w_minus_3_contrib_pct)],
    ['W-2', num(ev.l3w_minus_2_contrib_pct)],
    ['W-1', num(ev.l3w_minus_1_contrib_pct)],
    ['Now', num(ev.l3w_current_contrib_pct)],
  ];
  const g = globalBars(ev.language, evalRows);
  const stop = g ? g.stop : num(ev.stop_below_users_contrib_pct);
  const ret = g ? g.retain : num(ev.retain_above_users_contrib_pct);
  return (
    <Line
      data={{
        labels: pts.map((p) => p[0]),
        datasets: [
          { label: 'Contribution %', data: pts.map((p) => p[1]), borderColor: '#1D4ED8', backgroundColor: 'rgba(29,78,216,.08)', tension: 0.3, fill: true, spanGaps: true },
          { label: 'Retain (global)', data: pts.map(() => ret), borderColor: '#2A9D8F', borderDash: [5, 4], pointRadius: 0 },
          { label: 'Stop (global)', data: pts.map(() => stop), borderColor: '#E63946', borderDash: [5, 4], pointRadius: 0 },
        ],
      }}
      options={{ plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 } } } }, scales: { y: { ticks: { callback: (v) => v + '%' } } }, maintainAspectRatio: false }}
    />
  );
}

export function RetentionChart({ fs }) {
  // Convert step-wise relative retention → cumulative (% of original starters):
  // hook stays, mid = hook×mid, end = hook×mid×end. Matches the guardrail basis.
  const h = num(fs.show_avg_hook_retention_pct);
  const m = num(fs.show_avg_mid_retention_pct);
  const e = num(fs.show_avg_end_retention_pct);
  const cumMid = h != null && m != null ? (h * m) / 100 : m;
  const cumEnd = h != null && m != null && e != null ? (h * m * e) / 10000 : e;
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return (
    <Bar
      data={{
        labels: ['Hook', 'Mid', 'End'],
        datasets: [{ data: [r1(h), r1(cumMid), r1(cumEnd)], backgroundColor: ['#F4A261', '#D97706', '#1D4ED8'] }],
      }}
      options={{ plugins: { legend: { display: false } }, scales: { y: { max: 100, ticks: { callback: (v) => v + '%' } } }, maintainAspectRatio: false }}
    />
  );
}

// Daily audience by acquisition source — one line per source over ~30 days.
// metric = 'views' (play events) or 'users' (unique viewers).
const AUD_STYLE = {
  organic:  { label: 'Organic',  color: '#2A9D8F' },
  push:     { label: 'Push',     color: '#1D4ED8' },
  moe:      { label: 'MoEngage', color: '#7C3AED' },
  whatsapp: { label: 'WhatsApp', color: '#F4A261' },
};
export function AudienceSourceChart({ aud, metric = 'views' }) {
  const series = aud[metric] || aud.views;
  // Drop sources with no activity across the whole window to keep the chart clean.
  const active = AUDIENCE_SOURCES.filter((s) => (series[s] || []).some((v) => v > 0));
  const shortDate = (d) => { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d); return m ? `${m[2]}/${m[1]}` : d; };
  return (
    <Line
      data={{
        labels: aud.dates.map(shortDate),
        datasets: (active.length ? active : AUDIENCE_SOURCES).map((s) => ({
          label: AUD_STYLE[s].label,
          data: series[s],
          borderColor: AUD_STYLE[s].color,
          backgroundColor: AUD_STYLE[s].color,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 3,
          borderWidth: 2,
          spanGaps: true,
        })),
      }}
      options={{
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 } } } },
        scales: {
          x: { ticks: { maxTicksLimit: 10, font: { size: 9 } } },
          y: { beginAtZero: true, ticks: { precision: 0 } },
        },
        maintainAspectRatio: false,
      }}
    />
  );
}

export function FailureDoughnut({ fs }) {
  const hookF = num(pickv(fs, 'show_hook_fail_cnt_10eps', 'show_hook_fail_cnt_8eps')) || 0;
  const paceF = num(pickv(fs, 'show_pace_fail_cnt_10eps', 'show_pace_fail_cnt_8eps')) || 0;
  const endF = num(pickv(fs, 'show_ending_fail_cnt_10eps', 'show_ending_fail_cnt_8eps')) || 0;
  const okF = num(fs.ok_cnt) != null ? num(fs.ok_cnt) : (num(fs.show_failure_evaluable_eps_cnt) || 0) - hookF - paceF - endF;
  return (
    <Doughnut
      data={{
        labels: ['OK', 'Hook', 'Pace', 'Ending'],
        datasets: [{ data: [Math.max(0, okF), hookF, paceF, endF], backgroundColor: ['#2A9D8F', '#F4A261', '#D97706', '#4F46E5'] }],
      }}
      options={{ plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } }, maintainAspectRatio: false }}
    />
  );
}
