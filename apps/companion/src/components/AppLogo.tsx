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
        <TarmotoMark size={18} color="#0E0E10" />
      </span>
      <span className="leading-none">
        <span
          className={`block text-[15px] font-bold tracking-tight ${
            inverted ? "text-cream" : "text-ink"
          }`}
        >
          TARMOTO
        </span>
        <span
          className={`mt-0.5 block font-mono text-[9px] tracking-[1px] ${
            inverted ? "text-cream/50" : "text-ink/45"
          }`}
        >
          WEB · v1.4
        </span>
      </span>
    </Link>
  );
}
