import { useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/**
 * ProfilePage — Rider public profile
 *
 * TODO: Fetch /riders/:riderId from API
 * TODO: Profile header (avatar, name, bio, bikes, home region)
 * TODO: Stats row (rides, km, roads discovered)
 * TODO: Badge showcase
 * TODO: Route collections by this rider
 * TODO: Follow/unfollow
 * TODO: Recent shared rides
 */

export function ProfilePage() {
  const { riderId } = useParams<{ riderId: string }>();

  return (
    <div className="p-6 max-w-4xl mx-auto animate-fade-in">
      <Link to="/community" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-6 transition">
        <ArrowLeft size={16} /> Community
      </Link>

      <div className="rounded-2xl bg-slate-900 border border-slate-800 p-8 text-center">
        <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-tarmoto-cyan/20 flex items-center justify-center text-tarmoto-cyan text-2xl font-bold">
          ?
        </div>
        <p className="text-slate-400">Rider profile: {riderId}</p>
      </div>
    </div>
  );
}
