/**
 * Фича: диагностика подключения очереди поиска игры (тумблер в «Ещё»).
 *
 * Зачем: игроков «выкидывает» из очереди, когда вкладка поиска в фоне.
 * Гипотеза — браузерный троттлинг таймеров душит клиентский ping socket.io
 * (у сайта engine.io v3: ping шлёт КЛИЕНТ по setTimeout; reconnection: false).
 * Фича собирает доказательства с таймстампами:
 *  - события WebSocket страницы (handshake с pingInterval/pingTimeout,
 *    каждый ping/pong, момент и код разрыва) — через PAGE-скрипт
 *    conn-diag-page.ts, потому что isolated world сокеты сайта не видит;
 *  - дрейф собственного таймера (когда браузер начал душить вкладку);
 *  - смены видимости вкладки.
 *
 * Всё пишется в общий лог расширения (префикс conn-diag) — выгружается
 * кнопкой «Скачать» в попапе. Для персиста нужен включённый тумблер
 * «Вести логи» (подсказано в popup.html).
 *
 * Только страница /game-search: на других страницах фича спит.
 */
import { browser } from "@core/env";
import { log } from "@core/log";
import type { Feature, FeatureContext } from "@core/feature";

const SCOPE = "conn-diag";
const PAGE_SCRIPT = "conn-diag-page.js";

let messageListener: ((e: MessageEvent) => void) | null = null;
let visibilityListener: (() => void) | null = null;
let driftTimer: ReturnType<typeof setTimeout> | null = null;
let injected = false;

function isSearchPage(): boolean {
  return location.pathname === "/game-search" || location.pathname.startsWith("/game-search/");
}

function injectPageScript(): void {
  // Повторный инжект того же файла безопасен (page-скрипт идемпотентен),
  // но не плодим теги без нужды.
  if (injected && document.querySelector(`script[data-pn-conn-diag]`)) return;
  const s = document.createElement("script");
  s.src = browser.runtime.getURL(PAGE_SCRIPT);
  s.dataset.pnConnDiag = "1";
  // После выполнения тег больше не нужен.
  s.addEventListener("load", () => s.remove());
  (document.head || document.documentElement).appendChild(s);
  injected = true;
}

export const connectionDiagFeature: Feature = {
  id: "connection-diag",
  settingKey: "connection_diag_enabled",
  enable(_ctx: FeatureContext) {
    if (!isSearchPage()) return;

    injectPageScript();

    messageListener = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const data = e.data as { source?: string; t?: number; line?: string };
      if (data?.source !== "pn-conn-diag" || typeof data.line !== "string") return;
      log.info(SCOPE, `+${((data.t || 0) / 1000).toFixed(1)}s`, data.line.slice(0, 400));
    };
    window.addEventListener("message", messageListener);

    visibilityListener = () => log.info(SCOPE, "visibility", document.visibilityState);
    document.addEventListener("visibilitychange", visibilityListener);

    // Дрейф цепочки setTimeout: в норме ~0, «+55s» = интенсивный троттлинг
    // (раз в минуту), дыры в десятки минут = заморозка/выгрузка вкладки.
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      const drift = now - last - 5000;
      if (Math.abs(drift) > 500) log.info(SCOPE, `timer drift +${Math.round(drift / 100) / 10}s`);
      last = now;
      driftTimer = setTimeout(tick, 5000);
    };
    driftTimer = setTimeout(tick, 5000);

    log.info(SCOPE, "enabled on", location.pathname, "hidden=", document.hidden);
  },
  disable() {
    if (messageListener) {
      window.removeEventListener("message", messageListener);
      messageListener = null;
    }
    if (visibilityListener) {
      document.removeEventListener("visibilitychange", visibilityListener);
      visibilityListener = null;
    }
    if (driftTimer) {
      clearTimeout(driftTimer);
      driftTimer = null;
    }
    // Прокси WebSocket в мире страницы снять нельзя — просим его замолчать.
    if (injected) {
      try {
        window.postMessage({ source: "pn-conn-diag-stop" }, location.origin);
      } catch {
        /* страница закрывается */
      }
    }
  },
};
