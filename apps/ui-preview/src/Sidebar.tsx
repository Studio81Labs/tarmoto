import { TarmotoMark } from "@tarmoto/ui";

interface NavItem {
  id: string;
  num: string;
  label: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Sidebar · mirrors the `.nav` block in the Web App v2 Design Map.
 * Brand mark + groups (Foundations / Atoms / Components / Feedback /
 * Maps / Patterns) — numbered anchors `#colors`, `#quality`, …
 *
 * The preview adds Buttons/Alerts/Tooltips/Toasts (§17–§20) to the
 * library coverage. The source HTML's `#map-vocab` etc. become §21–§26
 * here so the numbering stays linear in the rail.
 */
const GROUPS: NavGroup[] = [
  {
    label: "Foundations",
    items: [
      { id: "colors", num: "01", label: "Color surfaces" },
      { id: "quality", num: "02", label: "Quality scale" },
      { id: "color-rules", num: "03", label: "Color rules" },
      { id: "type", num: "04", label: "Typography" },
      { id: "space", num: "05", label: "Spacing & radius" },
      { id: "shadow", num: "06", label: "Shadow & elevation" },
    ],
  },
  {
    label: "Atoms",
    items: [
      { id: "atoms", num: "07", label: "Atoms" },
      { id: "pill", num: "08", label: "Pill / button" },
      { id: "controls", num: "09", label: "Form controls" },
      { id: "qbars", num: "10", label: "Quality bars" },
    ],
  },
  {
    label: "Components",
    items: [
      { id: "card", num: "11", label: "Card" },
      { id: "metric", num: "12", label: "Metric tile" },
      { id: "rpc", num: "13", label: "Road preview" },
      { id: "nav-rail", num: "14", label: "Nav rail" },
      { id: "table", num: "15", label: "Data table" },
      { id: "tweaks", num: "16", label: "Tweaks panel" },
    ],
  },
  {
    label: "Feedback",
    items: [
      { id: "buttons", num: "17", label: "Buttons & CTAs" },
      { id: "alerts", num: "18", label: "Alerts & banners" },
      { id: "tooltips", num: "19", label: "Tooltips" },
      { id: "toasts", num: "20", label: "Toasts" },
    ],
  },
  {
    label: "Maps",
    items: [
      { id: "map-vocab", num: "21", label: "Map vocabulary" },
      { id: "map-modes", num: "22", label: "Map modes" },
      { id: "map-overlays", num: "23", label: "Map overlays" },
    ],
  },
  {
    label: "Patterns",
    items: [
      { id: "layouts", num: "24", label: "Layouts" },
      { id: "density", num: "25", label: "Density" },
      { id: "do-dont", num: "26", label: "Do & don't" },
      { id: "system-states", num: "27", label: "System states" },
    ],
  },
];

export function Sidebar() {
  return (
    <aside className="sticky top-0 h-screen w-[240px] overflow-y-auto border-r border-ink bg-ink px-[22px] py-7 text-cream">
      <div className="mb-7 flex items-center gap-2.5">
        <span className="grid size-[30px] place-items-center rounded-[7px] bg-accent">
          <TarmotoMark size={16} color="#0E0E10" />
        </span>
        <div className="text-[14px] font-extrabold tracking-tight">TARMOTO</div>
      </div>

      <nav className="flex flex-col gap-px">
        {GROUPS.map((g) => (
          <div key={g.label}>
            <div className="px-2.5 pb-1.5 pt-3.5 font-mono text-[9px] uppercase tracking-[1.4px] text-cream/40">
              {g.label}
            </div>
            {g.items.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="flex items-baseline gap-2.5 rounded-[7px] px-2.5 py-2 text-[12.5px] font-semibold text-cream transition-colors hover:bg-cream/6"
              >
                <span className="w-[22px] shrink-0 font-mono text-[10px] font-bold text-cream/40">
                  {item.num}
                </span>
                {item.label}
              </a>
            ))}
          </div>
        ))}
      </nav>

      <div className="mt-6 border-t border-cream/10 pt-5 font-mono text-[10px] leading-[1.7] tracking-[0.6px] text-cream/50">
        Rev 02 · May 2026
        <br />
        Owner · Design
        <br />
        Rendered with the live <span className="text-cream">
          @tarmoto/ui
        </span>{" "}
        package.
      </div>
    </aside>
  );
}
