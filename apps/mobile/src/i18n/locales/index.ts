import type { CatalogsByLocale } from "@tarmoto/shared";
import { en, type EnglishMessageKey } from "./en";

export type TranslationCatalog = Record<EnglishMessageKey, string>;

// Register a locale here only after its catalog covers every English source
// key. The shared engine still supports partial catalogs during translation,
// while catalog.test.ts prevents an incomplete locale reaching the selector.
export const mobileCatalogs: CatalogsByLocale<EnglishMessageKey> = { en };

export { en, type EnglishMessageKey };
