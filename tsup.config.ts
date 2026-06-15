import { defineConfig } from "tsup";

/**
 * Один JS-бандл, общий для обоих браузеров.
 * Различия Chrome/Firefox решаются на уровне манифеста (см. scripts/assemble.mjs)
 * и webextension-polyfill (chrome.* -> browser.* в рантайме).
 *
 * Формат iife: content/background/popup в MV3 грузятся как классические скрипты,
 * поэтому никаких import-ов в рантайме — всё инлайнится в один файл на entry.
 */
export default defineConfig({
  entry: {
    background: "src/background/index.ts",
    content: "src/content/index.ts",
    popup: "src/popup/index.ts",
  },
  outDir: ".dist-js",
  format: ["iife"],
  target: "es2022",
  splitting: false,
  treeshake: true,
  sourcemap: false,
  minify: false,
  clean: true,
  // esbuild iife: одна самодостаточная функция на каждый entry
  outExtension() {
    return { js: ".js" };
  },
});
