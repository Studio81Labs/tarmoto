import { FolderOpen, Plus } from 'lucide-react';

/**
 * RouteCollectionsPage — Browse and manage route collections
 *
 * TODO: Fetch /community/collections from API
 * TODO: Collection cards with map preview
 * TODO: Create new collection modal
 * TODO: Public/private toggle
 */

export function RouteCollectionsPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Route Collections</h1>
        <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition">
          <Plus size={16} /> New collection
        </button>
      </div>

      <div className="rounded-2xl bg-slate-900 border border-slate-800 p-16 text-center">
        <FolderOpen size={48} className="mx-auto text-slate-600 mb-4" />
        <p className="text-slate-400 text-lg mb-2">No collections yet</p>
        <p className="text-slate-500 text-sm">Curate your favorite roads into shareable collections.</p>
      </div>
    </div>
  );
}
