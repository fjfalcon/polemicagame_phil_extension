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
    include: ["tests/contract/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
});
