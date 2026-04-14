import { BarChart3 } from 'lucide-react';

/**
 * StatsPage — Riding statistics dashboard
 *
 * TODO: Fetch /rides/stats from API
 * TODO: All-time totals cards
 * TODO: Recharts: monthly distance bar chart, calendar heatmap
 * TODO: Year-over-year comparison
 * TODO: Filter by bike, ride type, region
 */

export function StatsPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <h1 className="text-2xl font-bold mb-6">Statistics</h1>

      {/* All-time totals */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        {[
          { label: 'Total distance', value: '0', unit: 'km' },
          { label: 'Total rides', value: '0', unit: '' },
          { label: 'Total hours', value: '0', unit: 'h' },
          { label: 'Elevation gained', value: '0', unit: 'm' },
          { label: 'Roads discovered', value: '0', unit: '' },
        ].map((stat) => (
          <div key={stat.label} className="p-4 rounded-xl bg-slate-900 border border-slate-800">
            <p className="text-xs text-slate-500 mb-1">{stat.label}</p>
            <p className="text-2xl font-bold text-white">
              {stat.value}<span className="text-sm font-normal text-slate-400 ml-1">{stat.unit}</span>
            </p>
          </div>
        ))}
      </div>

      {/* Charts placeholder */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 h-72 flex items-center justify-center">
          <div className="text-center">
            <BarChart3 size={40} className="mx-auto text-slate-700 mb-3" />
            <p className="text-slate-500 text-sm">Monthly distance chart</p>
          </div>
        </div>
        <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 h-72 flex items-center justify-center">
          <p className="text-slate-500 text-sm">Riding calendar heatmap</p>
        </div>
      </div>
    </div>
  );
}
