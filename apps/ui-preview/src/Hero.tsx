/**
 * Hero · mirrors the `.hero` block in the Web App v2 Design Map:
 * eyebrow stamps, big serif title with italic Fraunces emphasis, and a
 * 6-row meta-card on the right that ends with the orange "Living doc"
 * status row.
 */
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
          The design map
          <br />
          <em className="font-serif font-normal italic text-accent">
            for Web App v2.
          </em>
        </h1>
        <p className="mt-[22px] max-w-[62ch] text-[17px] leading-[1.55] text-fg-dim">
          Everything you need to build a screen that looks like it belongs in
          Tarmoto: tokens, atoms, composite components, layout patterns, map
          vocabulary, and the rules that govern how they fit together. Built
          against the cream / ink / accent palette shipped in{" "}
          <span className="font-mono">Web App v2.html</span> and rendered live
          via <span className="font-mono">@tarmoto/ui</span>.
        </p>
      </div>
      <div className="flex flex-col gap-2.5 rounded-[14px] bg-ink p-6 text-cream">
        <Row k="Stack" v="React 19 · Tailwind v4" />
        <Row k="Tokens" v="theme.css (@theme bridge)" />
        <Row k="Type" v="Space Grotesk · JB Mono · Fraunces" />
        <Row k="Theme" v="Cream paper · Ink fg" />
        <Row k="Grid" v="4 pt base · 12 pt density" />
        <Row k="Status" v="● Living doc" accent />
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
