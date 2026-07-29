#!/usr/bin/env node
/**
 * Разовое получение refresh-токена для Chrome Web Store API.
 *
 *   CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... npm run chrome:auth
 *
 * Печатает готовые строки для ~/.config/polemica-notes/cws.env.
 *
 * Google выключил OOB-поток (копирование кода из браузера) в 2022, поэтому
 * тут поднимается локальный сервер: браузер после подтверждения вернётся на
 * http://127.0.0.1:<порт>, скрипт заберёт code сам и обменяет его на токены.
 * ЭТОТ ЖЕ адрес должен быть прописан в OAuth-клиенте (тип «Desktop app»
 * добавляет loopback автоматически).
 *
 * Порт фиксированный: у OAuth-клиента типа Web application redirect-URI
 * задаётся точной строкой, а «любой порт» разрешён только Desktop-типу.
 */
import http from "node:http";
import { execFile } from "node:child_process";

const PORT = 8976;
const REDIRECT = `http://127.0.0.1:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

const clientId = process.env.CWS_CLIENT_ID;
const clientSecret = process.env.CWS_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(
    "\n✖ Нужны CWS_CLIENT_ID и CWS_CLIENT_SECRET из Google Cloud Console.\n" +
      "  CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... npm run chrome:auth\n",
  );
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    // Без этих двух refresh_token НЕ придёт: Google отдаёт его только при
    // первом согласии, а prompt=consent заставляет спросить заново.
    access_type: "offline",
    prompt: "consent",
  }).toString();

console.log("\nОткрываю браузер для подтверждения доступа…");
console.log("Если не открылся — перейди вручную:\n" + authUrl + "\n");
execFile("open", [authUrl], () => undefined);

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, REDIRECT);
    const c = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<meta charset="utf-8"><body style="font:16px system-ui;padding:40px">${
        c ? "Готово — возвращайся в терминал." : "Не получилось: " + (err || "нет кода")
      }</body>`,
    );
    server.close();
    if (c) resolve(c);
    else reject(new Error(err || "код не получен"));
  });
  server.listen(PORT, "127.0.0.1");
  setTimeout(() => {
    server.close();
    reject(new Error("истекло время ожидания (5 минут)"));
  }, 300_000);
});

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT,
  }),
});
const data = await res.json();
if (!res.ok || !data.refresh_token) {
  console.error("\n✖ Токен не выдан:", JSON.stringify(data, null, 2));
  console.error(
    "\nЧаще всего это значит, что согласие уже давалось раньше. Отзови доступ на\n" +
      "https://myaccount.google.com/permissions и запусти команду снова.\n",
  );
  process.exit(1);
}

console.log("\n✓ Готово. Сохрани в ~/.config/polemica-notes/cws.env (chmod 600):\n");
console.log(`export CWS_CLIENT_ID="${clientId}"`);
console.log(`export CWS_CLIENT_SECRET="${clientSecret}"`);
console.log(`export CWS_REFRESH_TOKEN="${data.refresh_token}"`);
console.log(`export CWS_EXTENSION_ID="haacghfiifkhblmebkmdiifenndpofdo"\n`);
