import type { CatalogsByLocale } from "@tarmoto/shared";
import { en, type EnglishMessageKey } from "./en";

export type TranslationCatalog = Record<EnglishMessageKey, string>;

export const mobileCatalogs: CatalogsByLocale<EnglishMessageKey> = { en };

export { en, type EnglishMessageKey };
