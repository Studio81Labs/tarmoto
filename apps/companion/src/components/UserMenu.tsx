"use client";
import { t } from "@/i18n";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { Settings, LogOut } from "lucide-react";
import { useDropdown } from "@/hooks";

export function UserMenu() {
  const { data: session } = useSession();
  const user = session?.user;
  const { open, close, toggle, ref } = useDropdown();
  const handleLogout = () => {
    close();
    signOut({ callbackUrl: "/login" });
  };
  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        className="flex items-center gap-2.5 rounded-full border border-ink/15 bg-cream px-1.5 py-1 text-sm text-ink transition hover:bg-paper"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-[12px] font-bold text-ink shrink-0">
          {user?.displayName?.[0]?.toUpperCase() ?? "T"}
        </span>
        {user?.displayName && (
          <span className="pr-2 text-[13px] font-semibold">
            {user.displayName}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-52 overflow-hidden rounded-xl border border-ink/15 bg-cream py-1 shadow-[0_12px_32px_rgba(14,14,16,0.14)]">
          <Link
            href="/settings"
            onClick={close}
            className="flex items-center gap-3 px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-paper"
          >
            <Settings size={16} />
            {t("Settings")}
          </Link>
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-quality-very-poor/15 hover:text-quality-very-poor"
          >
            <LogOut size={16} />
            {t("Log out")}
          </button>
        </div>
      )}
    </div>
  );
}
