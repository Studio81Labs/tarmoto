import { t } from "@/i18n";

/**
 * Auth-screen hero brand mark — the same road-bar-and-mountains glyph
 * the marketing site uses in its top nav (`apps/marketing/src/components/
 * Nav.astro`). Kept inline here because it's the only place in the
 * companion that needs the marketing version of the lockup; the cream
 * dashboard chrome continues to use the simpler triangle in
 * `components/tarmoto/atoms.tsx`.
 */
function MarketingLogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
    >
      <rect x="18" y="20" width="64" height="12" rx="4" fill="#0E0E10" />
      <rect x="40" y="20" width="20" height="42" rx="4" fill="#0E0E10" />
      <path
        d="M 16 80 L 30 80 L 38 70 L 46 86 L 54 68 L 62 82 L 70 76 L 84 76"
        stroke="#0E0E10"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

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
          <div className="mb-8 flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent">
              <MarketingLogoMark size={20} />
            </span>
            <span className="text-[16px] font-semibold tracking-[-0.012em] text-cream">
              {t("Tarmoto")}
            </span>
          </div>
          <h1 className="text-[44px] font-bold leading-[1.05] tracking-tight text-cream">
            {t("The route is already waiting.")}
          </h1>
          <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-cream/65">
            {t(
              "Open your synced rides, check the essentials, and head out without signal anxiety.",
            )}
          </p>
          <div className="mt-10 inline-flex items-center gap-2 rounded-full border border-cream/15 px-3 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-cream/70">
              {t("TARMOTO · COMPANION")}
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
