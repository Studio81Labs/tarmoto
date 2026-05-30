"use client";
import { t } from "@/i18n";
import Link from "next/link";
import {
  ArrowRight,
  Bell,
  Bike,
  CreditCard,
  Database,
  Settings as SettingsIcon,
  Shield,
  User,
  type LucideIcon,
} from "lucide-react";
import { Card, PageHeader } from "@tarmoto/ui";

interface SettingsSection {
  href: string;
  icon: LucideIcon;
  label: string;
  description: string;
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    href: "/settings/profile",
    icon: User,
    label: "Profile",
    description: "Display name, bio, home region",
  },
  {
    href: "/settings/subscription",
    icon: CreditCard,
    label: "Subscription",
    description: "Plan, billing, payment methods",
  },
  {
    href: "/settings/privacy",
    icon: Shield,
    label: "Privacy",
    description: "Visibility, data sharing, consent",
  },
  {
    href: "/settings/bikes",
    icon: Bike,
    label: "My Bikes",
    description: "Manage your motorcycle garage",
  },
  {
    href: "/settings/notifications",
    icon: Bell,
    label: "Notifications",
    description: "Email, alerts, community updates",
  },
  {
    href: "/settings/data",
    icon: Database,
    label: "Data & Account",
    description: "Export your data or delete your account",
  },
];

// Hub is now a pure 2-col section grid per spec. Profile-editing UI
// previously bundled into this page lives at /settings/profile.
export default function SettingsHubPage() {
  return (
    <div className="mx-auto w-full max-w-page animate-fade-in p-7">
      <PageHeader
        stamp={t("Settings")}
        icon={<SettingsIcon size={18} strokeWidth={2} />}
        title={t("Settings")}
        sub={t(
          "Account, billing, privacy, notifications, and the rest of your preferences.",
        )}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {SETTINGS_SECTIONS.map((section) => (
          <Link key={section.href} href={section.href} className="group">
            <Card className="flex items-center gap-4 transition group-hover:border-line-strong">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-paper-2 text-ink">
                <section.icon size={18} strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-extrabold text-ink">
                  {t(section.label)}
                </p>
                <p className="mt-0.5 text-[12px] text-fg-dim">
                  {t(section.description)}
                </p>
              </div>
              <ArrowRight
                size={14}
                className="shrink-0 text-fg-mute transition group-hover:text-ink"
                aria-hidden="true"
              />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
