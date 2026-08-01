import { TarmotoMark } from "@tarmoto/ui";
import type { AdminRoute } from "../../app/routes.js";

interface SidebarProps {
  routes: AdminRoute[];
  active: string;
  onNavigate: (key: string) => void;
}

export function Sidebar({ routes, active, onNavigate }: SidebarProps) {
  return (
    <nav
      className="flex h-full w-56 shrink-0 flex-col gap-5 border-r border-ink/10 bg-ink px-4 py-6 text-cream"
      aria-label="Admin sections"
    >
      {/* Brand — accent mark + product name with the "admin console" stamp,
          mirroring the companion sidebar's logo treatment, where the block is
          the home link. Overview requires only `read_only`, so it is reachable
          for every authenticated admin. */}
      <button
        type="button"
        className="flex items-center gap-2.5 self-start rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-cream/5"
        aria-label="Tarmoto Admin Console — go to Overview"
        onClick={() => onNavigate("overview")}
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-accent">
          <TarmotoMark size={20} />
        </span>
        <span className="leading-tight">
          <span className="block text-[15px] font-extrabold tracking-tight text-cream">
            TARMOTO
          </span>
          <span className="block text-[10px] font-bold uppercase tracking-[1.5px] text-cream/50">
            Admin Console
          </span>
        </span>
      </button>

      <div className="h-px bg-cream/10" />

      <ul className="flex flex-col gap-1">
        {routes.map((route) => (
          <li key={route.key}>
            <button
              type="button"
              className={[
                "w-full rounded-lg px-3 py-2 text-left text-[13px] font-bold transition-colors",
                active === route.key
                  ? "bg-accent text-ink"
                  : "text-cream hover:bg-cream/5",
              ].join(" ")}
              aria-current={active === route.key ? "page" : undefined}
              onClick={() => onNavigate(route.key)}
            >
              {route.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
