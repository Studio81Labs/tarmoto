import Link from "next/link";

/** Product wordmark; names are intentionally locale-independent. */
const WORDMARK = "TARMOTO";
import { TarmotoMark } from "@tarmoto/ui";

export function AppLogo({
  inverted = false,
  label,
}: {
  inverted?: boolean;
  label: string;
}) {
  return (
    <Link
      href="/"
      className="flex items-center gap-2.5 shrink-0"
      aria-label={label}
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
        <TarmotoMark size={18} />
      </span>
      <span
        className={`text-[15px] font-bold tracking-tight leading-none ${
          inverted ? "text-cream" : "text-ink"
        }`}
      >
        {WORDMARK}
      </span>
    </Link>
  );
}
