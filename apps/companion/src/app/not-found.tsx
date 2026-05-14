import Link from "next/link";
import { MapPinned, Route } from "lucide-react";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-cream text-ink">
      <section className="mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-6 py-16">
        <div className="mb-5 flex items-center gap-3 font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-ink/60">
          <Route size={16} />
          Tarmoto
        </div>
        <h1 className="max-w-2xl text-5xl font-black leading-tight md:text-7xl">
          Road not found
        </h1>
        <p className="mt-5 max-w-xl text-lg leading-8 text-ink/65">
          This route marker does not point anywhere in the companion app. Head
          back to your dashboard or open the public road explorer.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded bg-ink px-4 py-2.5 text-sm font-bold text-cream transition hover:bg-ink/85"
          >
            <Route size={16} />
            Go home
          </Link>
          <Link
            href="/explore"
            className="inline-flex items-center gap-2 rounded border border-ink/15 px-4 py-2.5 text-sm font-bold transition hover:bg-paper"
          >
            <MapPinned size={16} />
            Open explorer
          </Link>
        </div>
      </section>
    </main>
  );
}
