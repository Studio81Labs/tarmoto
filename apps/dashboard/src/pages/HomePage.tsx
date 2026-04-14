import { Link } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Map, Route, History, BarChart3, Plus, ArrowRight } from 'lucide-react';

const QUICK_ACTIONS = [
  { to: '/trips/new', icon: Plus, label: 'Plan a trip', color: 'text-orange-400' },
  { to: '/explore', icon: Map, label: 'Explore roads', color: 'text-tarmoto-cyan' },
  { to: '/rides', icon: History, label: 'Ride history', color: 'text-blue-400' },
  { to: '/stats', icon: BarChart3, label: 'My stats', color: 'text-purple-400' },
];

export function HomePage() {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8 animate-fade-in">
      {/* Welcome */}
      <div>
        <h1 className="text-2xl font-bold">
          Welcome back{user?.displayName ? `, ${user.displayName}` : ''}
        </h1>
        <p className="text-slate-400 mt-1">Here's what's happening on your roads.</p>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {QUICK_ACTIONS.map((action) => (
          <Link
            key={action.to}
            to={action.to}
            className="group flex flex-col items-center gap-3 p-6 rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition"
          >
            <action.icon size={28} className={action.color} />
            <span className="text-sm font-medium text-slate-300 group-hover:text-white transition">
              {action.label}
            </span>
          </Link>
        ))}
      </div>

      {/* Recent rides placeholder */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Recent rides</h2>
          <Link to="/rides" className="text-sm text-tarmoto-cyan hover:underline flex items-center gap-1">
            View all <ArrowRight size={14} />
          </Link>
        </div>
        <div className="rounded-2xl bg-slate-900 border border-slate-800 p-12 text-center">
          <History size={40} className="mx-auto text-slate-600 mb-3" />
          <p className="text-slate-400">No rides recorded yet.</p>
          <p className="text-sm text-slate-500 mt-1">Your rides from the mobile app will appear here.</p>
        </div>
      </section>

      {/* Active trips placeholder */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Your trips</h2>
          <Link to="/trips/new" className="text-sm text-tarmoto-cyan hover:underline flex items-center gap-1">
            Plan new trip <ArrowRight size={14} />
          </Link>
        </div>
        <div className="rounded-2xl bg-slate-900 border border-slate-800 p-12 text-center">
          <Route size={40} className="mx-auto text-slate-600 mb-3" />
          <p className="text-slate-400">No trips planned yet.</p>
          <p className="text-sm text-slate-500 mt-1">Create your first trip to discover the best roads.</p>
        </div>
      </section>
    </div>
  );
}
