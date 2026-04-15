"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { accountApi } from '@/lib/api';
import { ArrowLeft, Plus, Bike as BikeIcon, Check } from 'lucide-react';
import type { Bike } from '@/lib/types';

export default function BikesPage() {
  const [bikes, setBikes] = useState<Bike[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    accountApi.getBikes().then(({ data }) => {
      setBikes((data as unknown as Bike[]) ?? []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-3xl mx-auto animate-fade-in">
      <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition">
        <ArrowLeft size={16} /> Settings
      </Link>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">My Bikes</h1>
        <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition">
          <Plus size={16} /> Add bike
        </button>
      </div>

      {bikes.length === 0 && !loading ? (
        <div className="rounded-2xl bg-slate-900 border border-slate-800 p-12 text-center">
          <BikeIcon size={48} className="mx-auto text-slate-600 mb-4" />
          <p className="text-slate-400 mb-2">No bikes in your garage</p>
          <p className="text-slate-500 text-sm">Add your motorcycle to get bike-specific stats and recommendations.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {bikes.map((bike) => (
            <div key={bike.id} className="flex items-center gap-4 p-4 rounded-xl bg-slate-900 border border-slate-800">
              <div className="w-12 h-12 rounded-lg bg-slate-800 flex items-center justify-center">
                <BikeIcon size={20} className="text-slate-400" />
              </div>
              <div className="flex-1">
                <p className="font-medium text-white">{bike.make} {bike.model}</p>
                <p className="text-sm text-slate-400">{bike.year} • {bike.totalKm.toLocaleString()} km</p>
              </div>
              {bike.isActive && (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-tarmoto-cyan/10 text-tarmoto-cyan text-xs font-medium">
                  <Check size={12} /> Active
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
