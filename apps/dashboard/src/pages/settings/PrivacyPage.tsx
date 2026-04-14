import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export function PrivacyPage() {
  return (
    <div className="p-6 max-w-3xl mx-auto animate-fade-in">
      <Link to="/settings" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition">
        <ArrowLeft size={16} /> Settings
      </Link>
      <h1 className="text-2xl font-bold mb-6">Privacy & Data</h1>

      <div className="space-y-6">
        {[
          { label: 'Profile visibility', description: 'Who can see your profile and riding stats', options: ['Public', 'Riders only', 'Private'], default: 1 },
          { label: 'Default ride sharing', description: 'How new rides are shared by default', options: ['Public', 'Private'], default: 1 },
          { label: 'Road data contribution', description: 'Share accelerometer data to improve road quality maps for all riders', options: ['Enabled', 'Disabled'], default: 0 },
        ].map((setting) => (
          <div key={setting.label} className="rounded-xl bg-slate-900 border border-slate-800 p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium text-white">{setting.label}</p>
                <p className="text-sm text-slate-400 mt-0.5">{setting.description}</p>
              </div>
              <select
                defaultValue={setting.default}
                className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
              >
                {setting.options.map((opt, i) => (
                  <option key={opt} value={i}>{opt}</option>
                ))}
              </select>
            </div>
          </div>
        ))}

        <div className="rounded-xl bg-slate-900 border border-slate-800 p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="font-medium text-white">Location data retention</p>
              <p className="text-sm text-slate-400 mt-0.5">How long your raw ride GPS data is stored</p>
            </div>
            <select className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition">
              <option>3 months</option>
              <option>6 months</option>
              <option selected>1 year</option>
              <option>Forever</option>
            </select>
          </div>
        </div>
      </div>

      <button className="mt-6 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition">
        Save preferences
      </button>
    </div>
  );
}
