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

  run("npm", ["run", "typecheck"]);
  run("npm", ["run", "build"]);

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
