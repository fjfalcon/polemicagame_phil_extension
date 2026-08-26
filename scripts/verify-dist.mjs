#!/usr/bin/env node
/**
 * Preflight для publish/sign (ревью 26.08.2026): артефакт обязан быть той же
 * версии, что package.json — иначе в стор/на подпись уедет СТАРАЯ сборка
 * («поднял версию, забыл пересобрать»). Гейт release:assets это гарантирует
 * для своего прогона; этот скрипт закрывает запуск publish:chrome /
 * sign:firefox мимо него.
 *
 * Использование: node scripts/verify-dist.mjs chrome-zip | firefox
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const want = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const target = process.argv[2];

function fail(msg) {
  console.error(`\n✖ verify-dist: ${msg}\n  Пересобери артефакты: npm run release:assets\n`);
  process.exit(1);
}

let got;
if (target === "chrome-zip") {
  const zip = path.join(root, "dist/polemica-chrome.zip");
  if (!fs.existsSync(zip)) fail("dist/polemica-chrome.zip отсутствует");
  const raw = execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" });
  got = JSON.parse(raw).version;
} else if (target === "firefox") {
  const mf = path.join(root, "dist/firefox/manifest.json");
  if (!fs.existsSync(mf)) fail("dist/firefox/manifest.json отсутствует");
  got = JSON.parse(fs.readFileSync(mf, "utf8")).version;
} else {
  fail(`неизвестный таргет «${target}» (chrome-zip | firefox)`);
}

if (got !== want) fail(`версия артефакта ${got} ≠ package.json ${want} — артефакт устарел`);
console.log(`✓ verify-dist: ${target} = ${got}`);
