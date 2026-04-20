import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  {
    // Downgrade strict hooks rules that flag existing patterns across
    // the app. These identify real smells worth refactoring — setState
    // inside useEffect often indicates derived state that should be
    // computed during render, and ref access during render can race
    // concurrent rendering. Tracked as gradual cleanup; keeping these
    // as warn so the signal stays visible without blocking PRs.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
];

export default eslintConfig;
