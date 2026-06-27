import { Heading } from "@tarmoto/ui";
import { routes } from "../../app/routes.js";

interface SidebarProps {
  active: string;
  onNavigate: (key: string) => void;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
  return (
    <nav
      className="flex h-full w-56 shrink-0 flex-col border-r border-line bg-cream px-4 py-6"
      aria-label="Admin sections"
    >
      <Heading as="div" size="sm" className="mb-6 px-2">
        Tarmoto Admin
      </Heading>
      <ul className="flex flex-col gap-1">
        {routes.map((route) => (
          <li key={route.key}>
            <button
              type="button"
              className={[
                "w-full rounded-lg px-3 py-2 text-left text-[13px] font-bold transition-colors",
                active === route.key
                  ? "bg-ink text-cream"
                  : "text-ink hover:bg-paper",
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
