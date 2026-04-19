"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
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
  Trophy,
} from "lucide-react";
import clsx from "clsx";

const NAV_SECTIONS = [
  {
    label: "Main",
    items: [
      { href: "/", icon: Home, label: "Home" },
      { href: "/explore", icon: Map, label: "Road Explorer" },
    ],
  },
  {
    label: "Planning",
    items: [{ href: "/trips", icon: Route, label: "Trips" }],
  },
  {
    label: "Riding",
    items: [
      { href: "/rides", icon: History, label: "Ride History" },
      { href: "/stats", icon: BarChart3, label: "Statistics" },
      { href: "/road-map", icon: MapPin, label: "My Road Map" },
    ],
  },
  {
    label: "Community",
    items: [
      { href: "/community", icon: Users, label: "Community" },
      { href: "/gamification", icon: Trophy, label: "Achievements" },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/settings", icon: Settings, label: "Settings" },
      { href: "/settings/bikes", icon: Bike, label: "My Bikes" },
    ],
  },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  const handleLogout = () => {
    signOut({ callbackUrl: "/login" });
  };

  return (
    <aside
      className={clsx(
        "flex flex-col border-r border-slate-800 bg-slate-950 transition-all duration-300",
        collapsed ? "w-16" : "w-60",
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
              {section.items.map((item) => {
                const isActive =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={clsx(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                      isActive
                        ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
                        : "text-slate-400 hover:text-white hover:bg-slate-800/60",
                      collapsed && "justify-center px-0",
                    )}
                  >
                    <item.icon size={18} />
                    {!collapsed && <span>{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* User section */}
      <div className="border-t border-slate-800 p-3">
        <button
          onClick={handleLogout}
          className={clsx(
            "flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-red-400 hover:bg-red-400/5 transition",
            collapsed && "justify-center px-0",
          )}
        >
          <LogOut size={18} />
          {!collapsed && <span>Log out</span>}
        </button>
      </div>
    </aside>
  );
}
