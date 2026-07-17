import type { CatalogsByLocale } from "@tarmoto/shared";
import { en, type EnglishMessageKey } from "./en";

// =============================================================================
// Companion UI message catalogs.
//
// To add a language: create a sibling `./<locale>.ts` exporting a
// `Partial<Record<EnglishMessageKey, string>>`, import it, and add it here.
// Missing keys fall back to English automatically. Register the language's
// label in the shared `LOCALES` registry (@tarmoto/shared/i18n) — the
// completeness test in ../index.test.ts fails until both edits are made.
// =============================================================================

export type TranslationCatalog = Record<EnglishMessageKey, string>;

export const companionCatalogs: CatalogsByLocale<EnglishMessageKey> = { en };

export { en, type EnglishMessageKey };
