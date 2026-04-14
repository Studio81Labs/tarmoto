import { ArrowLeft, Check } from 'lucide-react';
import { Link } from 'react-router-dom';

export function SubscriptionPage() {
  const plans = [
    { name: 'Free', price: '$0', features: ['Basic navigation', 'Road quality overlay (limited)', 'Hazard alerts', '1 active trip'] },
    { name: 'Premium', price: '$29.99/yr', features: ['Unlimited trip planning', 'Full road quality zoom', 'Offline maps', 'Commuter mode', 'GPX export', 'Collaborative trips (5 riders)'], highlighted: true },
    { name: 'Pro', price: '$49.99/yr', features: ['Everything in Premium', 'Unlimited group rides', 'Priority hazard alerts', 'API access', 'Garmin export', 'Advanced analytics'] },
  ];

  return (
    <div className="p-6 max-w-4xl mx-auto animate-fade-in">
      <Link to="/settings" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition">
        <ArrowLeft size={16} /> Settings
      </Link>
      <h1 className="text-2xl font-bold mb-6">Subscription</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {plans.map((plan) => (
          <div
            key={plan.name}
            className={`rounded-2xl p-6 border ${
              plan.highlighted
                ? 'bg-tarmoto-cyan/5 border-tarmoto-cyan/30'
                : 'bg-slate-900 border-slate-800'
            }`}
          >
            <h3 className="text-lg font-bold mb-1">{plan.name}</h3>
            <p className="text-2xl font-extrabold text-tarmoto-cyan mb-4">{plan.price}</p>
            <ul className="space-y-2">
              {plan.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-slate-300">
                  <Check size={14} className="text-tarmoto-cyan mt-0.5 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
            <button
              className={`w-full mt-6 py-2 rounded-lg text-sm font-semibold transition ${
                plan.highlighted
                  ? 'bg-tarmoto-cyan text-slate-950 hover:bg-tarmoto-cyan-light'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {plan.highlighted ? 'Upgrade' : 'Current plan'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
