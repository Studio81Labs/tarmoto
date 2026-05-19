import { t } from "@/i18n";
import Link from "next/link";
import { TarmotoMark } from "./tarmoto/atoms";

export function AppLogo({ inverted = false }: { inverted?: boolean }) {
  return (
    <Link
      href="/"
      className="flex items-center gap-2.5 shrink-0"
      aria-label={t("Tarmoto")}
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
        <TarmotoMark size={18} />
      </span>
      <span
        className={`text-[15px] font-bold tracking-tight leading-none ${
          inverted ? "text-cream" : "text-ink"
        }`}
      >
        TARMOTO
      </span>
    </Link>
  );
}
