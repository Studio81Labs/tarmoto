import { t } from "@/i18n";
import { TarmotoMark } from "@/components/tarmoto/atoms";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-cream text-ink">
      <div className="relative hidden w-1/2 items-center justify-center overflow-hidden bg-ink text-cream lg:flex">
        {/* Subtle topo lines */}
        <svg
          viewBox="0 0 600 800"
          preserveAspectRatio="xMidYMid slice"
          className="absolute inset-0 h-full w-full opacity-25"
          aria-hidden="true"
        >
          <g stroke="rgba(245,239,230,0.18)" strokeWidth="1" fill="none">
            {Array.from({ length: 14 }).map((_, i) => {
              const y = 40 + i * 55;
              return (
                <path
                  key={i}
                  d={`M -20 ${y} C 150 ${y - 28 + (i % 3) * 8}, 320 ${y + 22}, 520 ${y - 12} S 820 ${y + 18}, 1050 ${y - 6}`}
                />
              );
            })}
          </g>
        </svg>
        <div className="relative z-10 max-w-md px-10">
          <div className="mb-8 flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent">
              <TarmotoMark size={26} color="#0E0E10" />
            </span>
            <span className="font-mono text-[11px] font-bold uppercase tracking-[2px] text-cream/55">
              {t("TARMOTO · WEB")}
            </span>
          </div>
          <h1 className="text-[44px] font-bold leading-[1.05] tracking-tight text-cream">
            {t("A map of every road worth riding.")}
          </h1>
          <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-cream/65">
            {t(
              "Plan the loop on a real screen. Tune for curves and asphalt. Push it to your phone before you ride.",
            )}
          </p>
          <div className="mt-10 inline-flex items-center gap-2 rounded-full border border-cream/15 px-3 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-cream/70">
              {t("Beta · launching summer 2026")}
            </span>
          </div>
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center bg-cream px-6 py-12">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}
