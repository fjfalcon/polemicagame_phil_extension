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
import { fileSha256, treeSha256 } from "./dist-digest.mjs";
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
  try {
    const raw = execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" });
    got = JSON.parse(raw).version;
  } catch {
    fail("dist/polemica-chrome.zip не читается (битый архив или нет manifest.json)");
  }
} else if (target === "firefox") {
  const mf = path.join(root, "dist/firefox/manifest.json");
  if (!fs.existsSync(mf)) fail("dist/firefox/manifest.json отсутствует");
  got = JSON.parse(fs.readFileSync(mf, "utf8")).version;
} else if (target === "release") {
  // Финальный preflight перед gh release: ВСЕ артефакты против штампа —
  // подмена файла между release:assets и ручным gh release create ловится
  // (ревью 26.08.2026, хвост №2 шестой волны).
  got = want; // версии сверяются ниже штампом и manifest-проверками таргетов
} else {
  fail(`неизвестный таргет «${target}» (chrome-zip | firefox | release)`);
}

if (got !== want) fail(`версия артефакта ${got} ≠ package.json ${want} — артефакт устарел`);

// Штамп gated-прогона: версия могла совпасть, а исходники — уехать
// (same-version stale, ревью 26.08.2026). HEAD штампа обязан равняться
// текущему; грязное дерево — предупреждение, не блок (соло-компромисс).
const stampPath = path.join(root, "dist/.gate-stamp.json");
if (!fs.existsSync(stampPath)) fail("dist/.gate-stamp.json отсутствует — артефакт собран мимо release:assets");
let stamp;
try {
  stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
} catch {
  fail("dist/.gate-stamp.json не читается");
}
if (stamp.version !== want) fail(`штамп гейта от версии ${stamp.version} — прогони release:assets заново`);
if (!stamp.chromeZipSha256 || !stamp.firefoxTreeSha256) {
  fail("штамп старого формата (без дайджестов) — прогони release:assets заново");
}
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (stamp.gitHead !== head) {
  fail(`артефакт собран на ${String(stamp.gitHead).slice(0, 7)}, HEAD сейчас ${head.slice(0, 7)} — исходники уехали`);
}
// Привязка к БАЙТАМ (ревью 26.08.2026, хвост №1): частичная пересборка
// (build:firefox) после gated-прогона меняет дерево при том же штампе.
if (target === "chrome-zip") {
  const sha = fileSha256(path.join(root, "dist/polemica-chrome.zip"));
  if (sha !== stamp.chromeZipSha256) {
    fail("dist/polemica-chrome.zip изменился после gated-прогона — пересобери");
  }
} else {
  const sha = treeSha256(path.join(root, "dist/firefox"));
  if (sha !== stamp.firefoxTreeSha256) {
    fail("dist/firefox изменился после gated-прогона (build мимо гейта?) — пересобери");
  }
}
if (target === "release") {
  const checks = [
    ["dist/polemica-chrome.zip", stamp.chromeZipSha256],
    ["dist/polemica-firefox.zip", stamp.firefoxZipSha256],
    [`dist/polemica-notes-firefox-${want}.xpi`, stamp.xpiSha256],
  ];
  for (const [rel, expected] of checks) {
    const p = path.join(root, rel);
    if (!expected) fail(`${rel}: в штампе нет хэша — прогони release:assets (с подписью)`);
    if (!fs.existsSync(p)) fail(`${rel} отсутствует`);
    if (fileSha256(p) !== expected) fail(`${rel} изменился после gated-прогона — пересобери`);
  }
  const tree = treeSha256(path.join(root, "dist/firefox"));
  if (tree !== stamp.firefoxTreeSha256) fail("dist/firefox изменился после gated-прогона");
}
if (stamp.dirty) console.warn("⚠ verify-dist: артефакт собирался с незакоммиченными правками (штамп dirty).");
console.log(`✓ verify-dist: ${target} = ${got}, gated-прогон на ${head.slice(0, 7)}`);
