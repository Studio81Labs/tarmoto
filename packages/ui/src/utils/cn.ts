import clsx, { type ClassValue } from "clsx";

/** Conditional className helper. Re-exports `clsx` so consumers don't
 *  need a separate dependency to compose styles. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
