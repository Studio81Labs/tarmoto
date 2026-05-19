/**
 * @tarmoto/ui
 *
 * Tarmoto Web App v2 component library — cream/ink palette, JetBrains Mono
 * stamps, five-stop quality vocabulary. Built primarily for the Next.js
 * companion, structured so the marketing site and any future web surface
 * can adopt the same primitives without duplication.
 *
 * Spec: design/Web App v2 Design Map.html · sections 01–26.
 *
 * Components are styled with Tailwind utility classes that reference the
 * Web App v2 token names (`bg-ink`, `text-cream`, `border-line`,
 * `text-quality-q4`, etc.). To wire those tokens into Tailwind v4, import
 * `@tarmoto/ui/theme.css` from your consumer's globals.css. Non-Tailwind
 * consumers can import `@tarmoto/ui/tokens.css` to get plain CSS
 * variables in the `--tm-*` namespace.
 */

export * from "./tokens";
export * from "./atoms";
export * from "./controls";
export * from "./components";
export * from "./feedback";
export { cn } from "./utils/cn";
