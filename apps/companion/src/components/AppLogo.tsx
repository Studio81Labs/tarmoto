import { t } from "@/i18n";
import Link from "next/link";
function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-label={t("Tarmoto")}
    >
      <rect x="18" y="20" width="64" height="12" rx="4" fill="#0ED3CF" />
      <rect x="40" y="20" width="20" height="42" rx="4" fill="#0ED3CF" />
      <path
        d="M 16 80 L 30 80 L 38 70 L 46 86 L 54 68 L 62 82 L 70 76 L 84 76"
        stroke="#0ED3CF"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
export function AppLogo() {
  return (
    <Link href="/" className="flex items-center gap-2 shrink-0">
      <LogoMark size={28} />
      <span className="text-lg font-bold tracking-tight">
        {"TAR"}
        <span className="text-tarmoto-cyan">{t("MOTO")}</span>
      </span>
    </Link>
  );
}
