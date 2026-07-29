#!/usr/bin/env node
/**
 * Заливка новой версии в Chrome Web Store и публикация.
 *
 *   source ~/.config/polemica-notes/cws.env && npm run publish:chrome
 *
 * Требует dist/polemica-chrome.zip — то есть сначала `npm run release:assets`.
 *
 * Канал публикации — `trustedTesters` НЕ используем: расширение unlisted,
 * публикуется сразу всем, у кого есть ссылка.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const zipPath = path.join(root, "dist", "polemica-chrome.zip");

const { CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_EXTENSION_ID } = process.env;
if (!CWS_CLIENT_ID || !CWS_CLIENT_SECRET || !CWS_REFRESH_TOKEN || !CWS_EXTENSION_ID) {
  console.error(
    "\n✖ Нет ключей Chrome Web Store.\n" +
      "  source ~/.config/polemica-notes/cws.env && npm run publish:chrome\n" +
      "  (получить разово: npm run chrome:auth)\n",
  );
  process.exit(1);
}

const zip = await fs.readFile(zipPath).catch(() => null);
if (!zip) {
  console.error(`\n✖ Нет ${path.relative(root, zipPath)} — сначала npm run release:assets\n`);
  process.exit(1);
}

const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
console.log(`\n▶ Публикация ${pkg.version} в Chrome Web Store (${zip.length} байт)\n`);

// 1. refresh → access token (живёт час, хранить не нужно)
const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: CWS_CLIENT_ID,
    client_secret: CWS_CLIENT_SECRET,
    refresh_token: CWS_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }),
});
const tokenData = await tokenRes.json();
if (!tokenRes.ok || !tokenData.access_token) {
  console.error("✖ Не удалось обновить токен:", JSON.stringify(tokenData, null, 2));
  process.exit(1);
}
const auth = {
  Authorization: `Bearer ${tokenData.access_token}`,
  "x-goog-api-version": "2",
};

// 2. Загрузка пакета
const upRes = await fetch(
  `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${CWS_EXTENSION_ID}`,
  { method: "PUT", headers: auth, body: zip },
);
const upData = await upRes.json();
// uploadState: SUCCESS | IN_PROGRESS | FAILURE. Ошибки версии («уже
// существует») приходят именно сюда, а не в HTTP-код.
if (!upRes.ok || upData.uploadState === "FAILURE") {
  console.error("✖ Загрузка не удалась:", JSON.stringify(upData, null, 2));
  process.exit(1);
}
console.log("✓ Пакет загружен:", upData.uploadState);

// 3. Публикация
const pubRes = await fetch(
  `https://www.googleapis.com/chromewebstore/v1.1/items/${CWS_EXTENSION_ID}/publish`,
  { method: "POST", headers: { ...auth, "Content-Length": "0" } },
);
const pubData = await pubRes.json();
if (!pubRes.ok) {
  console.error("✖ Публикация не удалась:", JSON.stringify(pubData, null, 2));
  process.exit(1);
}

console.log("✓ Отправлено на публикацию:", (pubData.status || []).join(", ") || "OK");
for (const detail of pubData.statusDetail || []) console.log("  " + detail);
console.log(
  "\nПроверка занимает от часов до нескольких дней; до её конца в сторе\n" +
    "остаётся прежняя версия.\n",
);
