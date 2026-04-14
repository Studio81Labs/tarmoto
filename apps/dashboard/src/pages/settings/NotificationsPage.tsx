import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export function NotificationsPage() {
  return (
    <div className="p-6 max-w-3xl mx-auto animate-fade-in">
      <Link to="/settings" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition">
        <ArrowLeft size={16} /> Settings
      </Link>
      <h1 className="text-2xl font-bold mb-6">Notifications</h1>

      <div className="space-y-4">
        {[
          { label: 'Email digest', description: 'Weekly summary of your riding stats and community activity' },
          { label: 'Hazard alerts', description: 'Alerts for new hazards on your saved routes' },
          { label: 'New followers', description: 'When someone follows your profile' },
          { label: 'Route comments', description: 'Comments on your shared routes and rides' },
          { label: 'Trip collaboration', description: 'Updates on trips you\'re collaborating on' },
          { label: 'Product updates', description: 'New features, improvements, and tips' },
        ].map((setting) => (
          <div key={setting.label} className="flex items-center justify-between p-4 rounded-xl bg-slate-900 border border-slate-800">
            <div>
              <p className="font-medium text-white text-sm">{setting.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{setting.description}</p>
            </div>
            <button
              className="relative w-11 h-6 rounded-full bg-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-tarmoto-cyan/30"
              onClick={(e) => {
                const btn = e.currentTarget;
                btn.classList.toggle('bg-tarmoto-cyan');
                btn.classList.toggle('bg-slate-700');
                const dot = btn.querySelector('span');
                dot?.classList.toggle('translate-x-5');
                dot?.classList.toggle('translate-x-0');
              }}
            >
              <span className="absolute left-0.5 top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transform translate-x-0 transition-transform" />
            </button>
          </div>
        ))}
      </div>

      <button className="mt-6 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition">
        Save preferences
      </button>
    </div>
  );
}
