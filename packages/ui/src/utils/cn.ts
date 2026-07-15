import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Conditional className helper. Composes with `clsx`, then resolves
 *  conflicting Tailwind utilities with `tailwind-merge` so a caller's
 *  `className` overrides a component's base classes (e.g. `w-auto`
 *  wins over a base `w-full`). Plain `clsx` keeps both and lets the
 *  base win by stylesheet order. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
