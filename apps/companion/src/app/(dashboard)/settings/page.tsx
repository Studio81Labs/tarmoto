"use client";

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth';
import {
  User, CreditCard, Shield, Bell, Bike, ChevronRight,
  Database,
} from 'lucide-react';

const SETTINGS_SECTIONS = [
  { href: '/settings', icon: User, label: 'Profile', description: 'Display name, avatar, home region' },
  { href: '/settings/subscription', icon: CreditCard, label: 'Subscription', description: 'Plan, billing, payment methods' },
  { href: '/settings/privacy', icon: Shield, label: 'Privacy', description: 'Visibility, data sharing, consent' },
  { href: '/settings/bikes', icon: Bike, label: 'My Bikes', description: 'Manage your motorcycle garage' },
  { href: '/settings/notifications', icon: Bell, label: 'Notifications', description: 'Email, alerts, community updates' },
  { href: '/settings/data', icon: Database, label: 'Data & Account', description: 'Export your data or delete your account' },
];

export default function AccountPage() {
  const user = useAuthStore((s) => s.user);
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [homeRegion, setHomeRegion] = useState('');

  return (
    <div className="p-6 max-w-3xl mx-auto animate-fade-in">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      {/* Settings navigation */}
      <div className="space-y-1 mb-8">
        {SETTINGS_SECTIONS.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="flex items-center gap-4 p-4 rounded-xl hover:bg-slate-900 transition group"
          >
            <div className="p-2 rounded-lg bg-slate-800 text-slate-400 group-hover:text-tarmoto-cyan transition">
              <section.icon size={18} />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-white">{section.label}</p>
              <p className="text-xs text-slate-500">{section.description}</p>
            </div>
            <ChevronRight size={16} className="text-slate-600" />
          </Link>
        ))}
      </div>

      {/* Profile form */}
      <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-4">
        <h2 className="text-lg font-semibold mb-4">Profile</h2>

        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-full bg-tarmoto-cyan/20 flex items-center justify-center text-tarmoto-cyan text-xl font-bold">
            {displayName[0]?.toUpperCase() ?? 'T'}
          </div>
          <button className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition">
            Change photo
          </button>
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1.5">Display name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
          />
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1.5">Email</label>
          <input
            type="email"
            value={user?.email ?? ''}
            disabled
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800/50 border border-slate-700/50 text-slate-500 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1.5">Home region</label>
          <input
            type="text"
            value={homeRegion}
            onChange={(e) => setHomeRegion(e.target.value)}
            placeholder="e.g., Beskydy, Czech Republic"
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition"
          />
        </div>

        <button className="px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition">
          Save changes
        </button>
      </div>

    </div>
  );
}
