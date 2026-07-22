"use client";

import { useState } from "react";
import { Select } from "@tarmoto/ui";
import { LOCALES, SUPPORTED_LOCALES, type SupportedLocale } from "@/i18n";
import { useI18n } from "@/i18n/I18nProvider";

/**
 * Lets the rider pick a UI language. Persists the choice as a cookie via
 * `/api/locale` so the server-rendered `<html lang>` and initial paint match
 * the rider's preference on subsequent loads. We trigger a full page reload
 * after saving so the root layout re-resolves the locale and every server
 * component re-renders with the new catalog.
 */
export function LocaleSwitcher() {
  const { locale, t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No switcher when only one locale is registered. Keeps the settings page
  // clean until a second language is added to the registry.
  if (SUPPORTED_LOCALES.length <= 1) return null;

  const handleChange = (next: SupportedLocale) => {
    if (next === locale) return;
    setError(null);
    setPending(true);
    void fetch("/api/locale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: next }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(t("Could not save your language."));
        if (typeof window !== "undefined") window.location.reload();
      })
      .catch(() => {
        setPending(false);
        setError(t("Could not save your language."));
      });
  };

  return (
    <div>
      <Select
        id="settings-locale"
        label={t("Language")}
        value={locale}
        disabled={pending}
        onChange={(next) => handleChange(next as SupportedLocale)}
        options={SUPPORTED_LOCALES.map((value) => ({
          value,
          label: LOCALES[value].label,
        }))}
      />
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
