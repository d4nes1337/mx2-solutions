import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Web tests run in jsdom with the React plugin. They are deliberately scoped to
// `.test.tsx` files so the monorepo root vitest (node environment, `*.test.ts`)
// never picks them up. Run with: pnpm --filter @mx2/web test
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Component tests get plain elements instead of the animation runtime.
      "motion/react": fileURLToPath(new URL("./test/motion-shim.tsx", import.meta.url)),
      // Mirror the "@/*" -> "./*" path alias from tsconfig.json.
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.tsx"],
  },
});
