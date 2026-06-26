import { routes } from "../../app/routes.js";

interface SidebarProps {
  active: string;
  onNavigate: (key: string) => void;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="Admin sections">
      <div className="sidebar__brand">Tarmoto Admin</div>
      <ul>
        {routes.map((route) => (
          <li key={route.key}>
            <button
              type="button"
              className={active === route.key ? "is-active" : ""}
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
