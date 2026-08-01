import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./src/core", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@content": fileURLToPath(new URL("./src/content", import.meta.url)),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/invariants/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 8_000,
  },
});
