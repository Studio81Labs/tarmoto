import { makeTranslator, type Translator } from '@tarmoto/shared';
import { en, type EmailMessageKey } from './en.js';

export type { EmailMessageKey };

/** Translator over the backend email catalogs. English-only for now. */
export const translateEmail: Translator<EmailMessageKey> =
  makeTranslator<EmailMessageKey>({ en });
