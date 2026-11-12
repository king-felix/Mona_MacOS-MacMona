import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "docs/evidence/**",
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
);
