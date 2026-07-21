import type { CatalogsByLocale } from "@tarmoto/shared";
import { en, type EnglishMessageKey } from "./en";

// =============================================================================
// Companion UI message catalogs.
//
// To add a language: create a sibling `./<locale>.ts`, import it, and add it
// here only after it covers every English source key. The engine supports
// partial fallback for development, but the catalog coverage test prevents a
// partially translated locale from being exposed by the production selector.
// Register the language's label in the shared `LOCALES` registry
// (@tarmoto/shared/i18n) — the completeness test in ../index.test.ts fails
// until both surface edits are made.
// =============================================================================

export type TranslationCatalog = Record<EnglishMessageKey, string>;

export const companionCatalogs: CatalogsByLocale<EnglishMessageKey> = { en };

export { en, type EnglishMessageKey };
