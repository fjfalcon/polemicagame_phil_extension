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
    // PAGE-скрипт диагностики подключения (MAIN world, инжект тегом).
    // Самодостаточен: без импортов core/* (см. шапку файла).
    "conn-diag-page": "src/content/page/conn-diag-page.ts",
    // Зонд комнаты: PAGE-скрипт (мир страницы) и его ранний инжектор
    // (content-скрипт на document_start — сокет комнаты создаётся раньше,
    // чем грузится основной content.js).
    "room-probe-page": "src/content/page/room-probe-page.ts",
    "room-probe-inject": "src/content/page/room-probe-inject.ts",
  },
  outDir: ".dist-js",
  format: ["iife"],
  target: "es2022",
  splitting: false,
  treeshake: true,
  sourcemap: false,
  // Минификация включена по аудиту 01.08.2026 (находка 6): content.js грузится
  // на каждой странице сайта в document_end, и ~449 KiB неминифицированного JS
  // парсились до возврата управления странице. Обфускации нет — это допустимо
  // и для CWS, и для подписи AMO.
  minify: true,
  clean: true,
  // esbuild iife: одна самодостаточная функция на каждый entry
  outExtension() {
    return { js: ".js" };
  },
});
