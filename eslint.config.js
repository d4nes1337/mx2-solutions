// Flat ESLint config. Enforces TS rules + architectural import boundaries:
// apps may depend on packages; packages must not depend on apps; the worker and
// api must not import each other directly (share via packages/*).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
      "polymarket_claude_mvp_kit_v1/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    plugins: { import: importPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@mx2/api", "@mx2/api/*", "@mx2/worker", "@mx2/worker/*"],
              message: "apps must not import each other; share code via packages/* instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // packages/* are pure libraries: they must not reach into apps.
    files: ["packages/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@mx2/api", "@mx2/api/*", "@mx2/worker", "@mx2/worker/*"],
              message: "packages/* must not depend on apps.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  prettier,
);
