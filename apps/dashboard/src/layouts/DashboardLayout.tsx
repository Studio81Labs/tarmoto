import { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import {
  Home,
  Map,
  Route,
  History,
  BarChart3,
  Users,
  Settings,
  Bike,
  LogOut,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Bell,
} from 'lucide-react';
import clsx from 'clsx';

const NAV_SECTIONS = [
  {
    label: 'Main',
    items: [
      { to: '/', icon: Home, label: 'Home' },
      { to: '/explore', icon: Map, label: 'Road Explorer' },
    ],
  },
  {
    label: 'Planning',
    items: [
      { to: '/trips', icon: Route, label: 'Trips' },
    ],
  },
  {
    label: 'Riding',
    items: [
      { to: '/rides', icon: History, label: 'Ride History' },
      { to: '/stats', icon: BarChart3, label: 'Statistics' },
      { to: '/road-map', icon: MapPin, label: 'My Road Map' },
    ],
  },
  {
    label: 'Community',
    items: [
      { to: '/community', icon: Users, label: 'Community' },
    ],
  },
  {
    label: 'Account',
    items: [
      { to: '/settings', icon: Settings, label: 'Settings' },
      { to: '/settings/bikes', icon: Bike, label: 'My Bikes' },
    ],
  },
];

export function DashboardLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950">
      {/* ── Sidebar ── */}
      <aside
        className={clsx(
          'flex flex-col border-r border-slate-800 bg-slate-950 transition-all duration-300',
          collapsed ? 'w-16' : 'w-60',
        )}
      >
        {/* Logo */}
        <div className="flex h-16 items-center justify-between px-4 border-b border-slate-800">
          {!collapsed && (
            <span className="text-lg font-bold tracking-tight">
              <span className="text-tarmoto-cyan">T</span>armoto
            </span>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-6">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label}>
              {!collapsed && (
                <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                  {section.label}
                </p>
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      clsx(
                        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
                        isActive
                          ? 'bg-tarmoto-cyan/10 text-tarmoto-cyan'
                          : 'text-slate-400 hover:text-white hover:bg-slate-800/60',
                        collapsed && 'justify-center px-0',
                      )
                    }
                  >
                    <item.icon size={18} />
                    {!collapsed && <span>{item.label}</span>}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* User section */}
        <div className="border-t border-slate-800 p-3">
          <button
            onClick={handleLogout}
            className={clsx(
              'flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-red-400 hover:bg-red-400/5 transition',
              collapsed && 'justify-center px-0',
            )}
          >
            <LogOut size={18} />
            {!collapsed && <span>Log out</span>}
          </button>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-16 items-center justify-between border-b border-slate-800 px-6">
          <div />
          <div className="flex items-center gap-4">
            <button className="relative p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition">
              <Bell size={18} />
              <span className="absolute top-1 right-1 w-2 h-2 bg-tarmoto-cyan rounded-full" />
            </button>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-tarmoto-cyan/20 flex items-center justify-center text-tarmoto-cyan text-sm font-bold">
                {user?.displayName?.[0]?.toUpperCase() ?? 'T'}
              </div>
              {user?.displayName && (
                <span className="text-sm font-medium text-slate-300">
                  {user.displayName}
                </span>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
