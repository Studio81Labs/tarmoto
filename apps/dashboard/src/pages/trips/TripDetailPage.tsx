import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Edit, Share2, Download, Trash2 } from 'lucide-react';

export function TripDetailPage() {
  const { tripId } = useParams<{ tripId: string }>();

  // TODO: Fetch trip data from API
  // TODO: Display map with route, day-by-day breakdown, Road Preview Cards
  // TODO: Collaboration panel showing members and suggestions

  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <div className="flex items-center gap-4 mb-6">
        <Link to="/trips" className="p-2 rounded-lg hover:bg-slate-800 transition">
          <ArrowLeft size={20} className="text-slate-400" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Trip Detail</h1>
          <p className="text-slate-500 text-sm">Trip ID: {tripId}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/trips/${tripId}/edit`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-semibold hover:bg-tarmoto-cyan-light transition"
          >
            <Edit size={14} /> Edit
          </Link>
          <button className="p-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition">
            <Share2 size={16} />
          </button>
          <button className="p-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition">
            <Download size={16} />
          </button>
          <button className="p-2 rounded-lg bg-slate-800 text-red-400 hover:bg-red-400/10 transition">
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {/* Trip map + details placeholder */}
      <div className="rounded-2xl bg-slate-900 border border-slate-800 h-96 flex items-center justify-center">
        <p className="text-slate-500">Trip route map and day-by-day breakdown</p>
      </div>
    </div>
  );
}
