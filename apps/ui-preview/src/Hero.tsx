export function Hero() {
  return (
    <div className="grid grid-cols-[1fr_320px] items-end gap-[60px] border-b border-line px-[60px] pb-[60px] pt-20">
      <div>
        <div className="mb-7 flex items-center gap-[18px]">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-fg-dim">
            Tarmoto · web companion · v2
          </span>
          <span className="font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-fg-dim">
            For: front-end devs
          </span>
        </div>
        <h1 className="font-serif text-[86px] font-bold leading-[0.92] tracking-[-2.6px]">
          The map for the design map.{" "}
          <em className="not-italic font-normal italic text-accent">
            Built with the library.
          </em>
        </h1>
        <p className="mt-[22px] max-w-[60ch] text-[17px] leading-[1.55] text-fg-dim">
          Every example on this page renders through the live{" "}
          <span className="font-mono">@tarmoto/ui</span> package — atoms,
          composite components, layout patterns, and feedback surfaces from the
          Web App v2 design map. If a row looks off, it's the library that's
          drifted, not a screenshot.
        </p>
      </div>
      <div className="flex flex-col gap-2.5 rounded-[14px] bg-ink p-6 text-cream">
        <Row k="Package" v="@tarmoto/ui" />
        <Row k="Stack" v="React 19 · Tailwind v4" />
        <Row k="Tokens" v="theme.css (@theme bridge)" />
        <Row k="Type" v="Space Grotesk · JB Mono · Fraunces" />
        <Row k="Theme" v="Cream paper · Ink fg" />
        <Row k="Grid" v="4 pt base · 12 pt density" />
        <Row k="Status" v="● Living preview" accent />
      </div>
    </div>
  );
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-[12px]">
      <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-cream/55">
        {k}
      </span>
      <span className={`font-bold ${accent ? "text-accent" : "text-cream"}`}>
        {v}
      </span>
    </div>
  );
}
