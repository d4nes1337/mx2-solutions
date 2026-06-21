import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TypeScript source so tests run
    // without a prior build step. Vite maps the ".js" import specifiers to
    // their sibling ".ts" sources automatically.
    alias: {
      "@mx2/core": pkg("./packages/core/src/index.ts"),
      "@mx2/config": pkg("./packages/config/src/index.ts"),
      "@mx2/observability": pkg("./packages/observability/src/index.ts"),
      "@mx2/db": pkg("./packages/db/src/index.ts"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/**/src/**", "apps/**/src/**"],
    },
  },
});
