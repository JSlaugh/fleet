import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

// The workspace uses ESM with explicit `.ts` import extensions (Vite resolves
// these natively) and a `@fleet/shared` tsconfig path — alias it to the source
// so tests resolve it the same way `tsc` does.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@fleet/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // dashboard tests mount Vue components and need a DOM; everything else runs under node.
    environmentMatchGlobs: [["packages/dashboard/**", "happy-dom"]],
  },
});
