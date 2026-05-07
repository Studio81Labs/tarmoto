import { t } from "@/i18n";
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex bg-slate-950">
      <div className="hidden lg:flex lg:w-1/2 items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-tarmoto-cyan/10 via-slate-950 to-slate-950" />
        <div className="relative z-10 max-w-md text-center px-8">
          <div className="text-6xl font-extrabold mb-4">
            <span className="text-tarmoto-cyan">{t("T")}</span>
          </div>
          <h1 className="text-3xl font-bold mb-3">{t("Tarmoto")}</h1>
          <p className="text-slate-400 text-lg">
            {t("Know the road before you ride it.")}
          </p>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}
