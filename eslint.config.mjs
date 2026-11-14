import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "docs/evidence/**",
      "packaging/**/out/**",
      "tools/monabuild/**",
      "tools/p01-spike/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: [
      "src/**/*.ts",
      "src/**/*.tsx",
      "test/**/*.ts",
      "scripts/**/*.mjs",
      "packaging/**/*.mjs",
      "*.config.ts",
      "*.config.mts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },
  {
    // RD-023: the R11 blocker (a conditional hook after an early return) threw at
    // runtime while lint reported zero errors, because no react-hooks plugin was
    // configured. `rules-of-hooks` is the one rule that catches that class, so it
    // is an error here. `exhaustive-deps` is deliberately not enabled: it is a
    // correctness hint that reports on almost every effect in this codebase, and
    // switching it on would change the lint result for files this queue did not
    // touch. Adding it is its own task with its own evidence.
    files: ["src/renderer/**/*.ts", "src/renderer/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
    },
  },
);
