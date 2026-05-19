import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  // Right-side slot for primary CTAs / actions (e.g. "New trip"). The
  // wrapper handles wrap-to-next-line on narrow viewports so the heading
  // stays readable.
  action?: ReactNode;
}

// Canonical page header used by every top-level dashboard route. The
// shape was lifted from /rides/compare and stripped of its back-arrow
// (the sidebar owns navigation now). Detail / overlay routes can keep
// their bespoke chrome — this component is for section landings.
export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  action,
}: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
          <Icon size={22} className="text-accent" aria-hidden="true" />
          {title}
        </h1>
        {subtitle && <p className="mt-0.5 text-sm text-fg-dim">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
