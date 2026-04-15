"use client";

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

const NOTIFICATION_SETTINGS = [
  { key: 'emailDigest', label: 'Email digest', description: 'Weekly summary of your riding stats and community activity' },
  { key: 'hazardAlerts', label: 'Hazard alerts', description: 'Alerts for new hazards on your saved routes' },
  { key: 'newFollowers', label: 'New followers', description: 'When someone follows your profile' },
  { key: 'routeComments', label: 'Route comments', description: 'Comments on your shared routes and rides' },
  { key: 'tripCollaboration', label: 'Trip collaboration', description: 'Updates on trips you\'re collaborating on' },
  { key: 'productUpdates', label: 'Product updates', description: 'New features, improvements, and tips' },
] as const;

type NotificationKey = typeof NOTIFICATION_SETTINGS[number]['key'];

export default function NotificationsPage() {
  const [enabled, setEnabled] = useState<Record<NotificationKey, boolean>>({
    emailDigest: false,
    hazardAlerts: false,
    newFollowers: false,
    routeComments: false,
    tripCollaboration: false,
    productUpdates: false,
  });

  const toggle = (key: NotificationKey) => {
    setEnabled((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="p-6 max-w-3xl mx-auto animate-fade-in">
      <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition">
        <ArrowLeft size={16} /> Settings
      </Link>
      <h1 className="text-2xl font-bold mb-6">Notifications</h1>

      <div className="space-y-4">
        {NOTIFICATION_SETTINGS.map((setting) => (
          <div key={setting.key} className="flex items-center justify-between p-4 rounded-xl bg-slate-900 border border-slate-800">
            <div>
              <p className="font-medium text-white text-sm">{setting.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{setting.description}</p>
            </div>
            <button
              onClick={() => toggle(setting.key)}
              className={`relative w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-tarmoto-cyan/30 ${
                enabled[setting.key] ? 'bg-tarmoto-cyan' : 'bg-slate-700'
              }`}
              aria-pressed={enabled[setting.key]}
              aria-label={`Toggle ${setting.label}`}
            >
              <span
                className={`absolute left-0.5 top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transform transition-transform ${
                  enabled[setting.key] ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
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
