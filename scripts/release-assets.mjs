#!/usr/bin/env node
/**
 * Готовит ВСЕ файлы релиза: собирает оба таргета, пакует zip и подписывает
 * XPI для Firefox.
 *
 * Подпись обязательна с 8.1.56: временная установка в Firefox стирает
 * настройки и заметки при каждом закрытии браузера (см. AGENTS.md §2б).
 * Раньше этот шаг делался руками и его легко было забыть — тогда
 * пользователи Firefox получали релиз, который «слетает».
 *
 * Ключи AMO берутся из окружения (WEB_EXT_API_KEY / WEB_EXT_API_SECRET):
 *   source ~/.config/polemica-notes/amo.env && npm run release:assets
 *
 * Без ключей скрипт НЕ падает молча: zip-и собираются, а про пропущенную
 * подпись он говорит явно и выходит с ненулевым кодом — чтобы релиз без
 * .xpi нельзя было выложить по невнимательности. Осознанный пропуск:
 * `npm run release:assets -- --skip-sign`.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const skipSign = process.argv.includes("--skip-sign");

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}

async function readVersion() {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "src/manifest/manifest.base.json"), "utf8"),
  );
  // Версия живёт в двух местах без автосинки — расхождение ломает обновление
  // у пользователей (баннер сравнивает версию манифеста с тегом релиза).
  if (pkg.version !== manifest.version) {
    throw new Error(
      `версии разошлись: package.json ${pkg.version} ≠ manifest.base.json ${manifest.version}`,
    );
  }
  // Chrome Web Store отклоняет загрузку с description длиннее 132 символов —
  // причём уже ПОСЛЕ подписи Firefox, то есть версия оказывается сожжённой
  // (AMO подписывает номер один раз). Ловим на входе.
  const MAX_DESCRIPTION = 132;
  if ((manifest.description || "").length > MAX_DESCRIPTION) {
    throw new Error(
      `description в manifest.base.json — ${manifest.description.length} символов, ` +
        `Chrome Web Store принимает не больше ${MAX_DESCRIPTION}`,
    );
  }
  return pkg.version;
}

async function zipTarget(target, outName) {
  const out = path.join(dist, outName);
  await fs.rm(out, { force: true });
  // zip пишет пути относительно cwd — поэтому пакуем изнутри папки таргета.
  run("zip", ["-qr", out, "."], { cwd: path.join(dist, target) });
  return out;
}

async function main() {
  const version = await readVersion();
  console.log(`\n▶ Сборка релиза ${version}\n`);

  // Полный гейт (26.08.2026, ревью доказуемости контура): релизные артефакты
  // НЕ собираются, пока красное хоть что-то из: production typecheck,
  // typecheck тестов, вся vitest-сюита. Дисциплина «гоняю руками» больше не
  // единственная преграда.
  run("npm", ["run", "typecheck"]);
  run("npx", ["tsc", "-p", "tests/tsconfig.json", "--noEmit"]);
  run("npm", ["test"]);
  run("npm", ["run", "build"]);
  // web-ext lint — после сборки, ТОЛЬКО firefox-таргет: web-ext — линтер
  // Firefox, и на хромовом манифесте он всегда «падал» на service_worker
  // (гейт поймал это в первый же прогон 26.08.2026 — прежняя ручная
  // проверка прятала exit-код за пайпом в tail). Chrome-манифест валидирует
  // сам CWS при загрузке. Warnings не блокируют (32 известных про
  // innerHTML), errors — блокируют.
  run("npm", ["run", "lint:ext:firefox"]);

  // Мягкий след adversarial-контура: леджер волн должен упоминать текущую
  // версию. Предупреждение, НЕ блок — механический запрет превратил бы
  // дисциплину в церемонию (решение 26.08.2026).
  try {
    const ledger = await fs.readFile(path.join(root, "docs/review-ledger.md"), "utf8");
    if (!ledger.includes(version)) {
      console.warn(
        `\n⚠ docs/review-ledger.md не упоминает ${version} — adversarial-волна по этому релизу не записана (или не проводилась).\n`,
      );
    }
  } catch {
    console.warn("\n⚠ docs/review-ledger.md отсутствует — леджер волн не ведётся.\n");
  }

  const assets = [
    await zipTarget("chrome", "polemica-chrome.zip"),
    await zipTarget("firefox", "polemica-firefox.zip"),
  ];

  if (skipSign) {
    console.log("\n⚠ Подпись пропущена (--skip-sign): Firefox-пользователи получат только zip.\n");
  } else if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
    console.error(
      "\n✖ Нет ключей AMO. Подпись пропущена, .xpi НЕ собран.\n" +
        "  source ~/.config/polemica-notes/amo.env && npm run release:assets\n",
    );
    process.exitCode = 1;
  } else {
    const signedDir = path.join(dist, "signed");
    // Чистим: web-ext складывает сюда все прошлые версии, и glob ниже мог бы
    // подобрать .xpi от предыдущего релиза.
    await fs.rm(signedDir, { recursive: true, force: true });
    run("npx", ["web-ext", "sign", "-s", "dist/firefox", "-a", "dist/signed", "--channel", "unlisted"]);

    const xpi = (await fs.readdir(signedDir)).find((f) => f.endsWith(".xpi"));
    if (!xpi) throw new Error("web-ext отработал, но .xpi не найден");
    // Имя от web-ext — со служебным хешем; для релиза даём человеческое.
    const target = path.join(dist, `polemica-notes-firefox-${version}.xpi`);
    await fs.copyFile(path.join(signedDir, xpi), target);
    assets.push(target);
  }

  console.log("\n✓ Файлы релиза:");
  for (const a of assets) console.log("  " + path.relative(root, a));
  console.log(
    `\nДальше:\n  gh release create v${version} ${assets
      .map((a) => path.relative(root, a))
      .join(" ")} --title "…" -F -\n`,
  );
}

main().catch((e) => {
  console.error("\n✖ " + e.message + "\n");
  process.exit(1);
});
