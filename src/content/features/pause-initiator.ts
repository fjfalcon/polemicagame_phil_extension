/**
 * Фича: «кто поставил паузу».
 *
 * Боль (владелец, 08.08.2026): «бесит, что кто-то ставит паузу, а кто —
 * непонятно». Сайт этого не показывает НИГДЕ: ни на экране паузы, ни в
 * текстах локали — хотя сервер инициатора присылает. В состоянии игры есть
 * `pause.initiatorId`, сайт его читает и прокидывает в обработчик паузы,
 * а тот параметр игнорирует (room/bundle/main.js, сверено 08.08.2026).
 *
 * Как устроено:
 *  - id достаёт зонд в мире страницы (room-probe-page): у isolated world
 *    свой WebSocket, сокеты сайта оттуда не видны. Зонд шлёт РОВНО одно
 *    число через window.postMessage — тела сообщений комнаты наружу не
 *    уходят (см. шапку зонда: через тот же сокет идут роли и ночные ходы);
 *  - эта фича слушает сообщения зонда, переводит id в «№N Ник» и дописывает
 *    строку на экран паузы — туда, где сайт рисует «Пауза» (просьба
 *    владельца: «выводил бы куда-нибудь сюда»).
 *
 * Почему подпись рисуется из подписчика onDomChange, а не один раз: экран
 * паузы — это Vue-компонент роллера, он перерисовывается (тикает время,
 * меняется счётчик готовности) и наш узел сносит. Запись идемпотентна
 * (инвариант §4 п.1): пишем, только если текста ещё нет или он изменился.
 */
import { onDomChange } from "@core/dom";
import { SITE } from "@core/selectors";
import { log } from "@core/log";
import type { Feature, FeatureContext } from "@core/feature";

const SCOPE = "pause-initiator";

/** Сообщение зонда: только id инициатора и признак конца паузы. */
export const PROBE_SOURCE = "pn-room-probe";
/** Наш узел с подписью на экране паузы. */
export const LABEL_CLASS = "pn-pause-initiator";

let unsubscribe: (() => void) | null = null;
let probeListener: ((e: MessageEvent) => void) | null = null;

/** Последний известный инициатор (null — паузу не ставили либо id не пришёл). */
let initiatorId: number | null = null;
/** Про этого инициатора уже написали в лог (не на каждый тик). */
let loggedFor: number | null = null;

/**
 * Как назвать инициатора.
 *
 * id — это позиция игрока в комнате (0-based), как и `playerId` в состоянии
 * сайта; человеку номера показывают с единицы, поэтому в подписи N+1.
 * Ник берём с плитки: `.player-number.player-N` — так сайт сам различает
 * игроков, и это переживает пересадку по местам.
 *
 * Чистая функция — тестовый шов.
 */
export function describeInitiator(id: number, doc: Document = document): string {
  const numberEl = doc.querySelector(`${SITE.playerNumber}.player-${id}`);
  const tile = numberEl?.closest(SITE.player);
  // Судья сидит на СВОЕЙ плитке (сайт даёт ей класс judge-player, а номер
  // 11-й — за столом такого места нет). Без этой ветки пауза от судьи
  // подписывалась бы «№11 Ник» прямо под сайтовым «Игра приостановлена
  // судьёй» (ревью 08.08.2026, блокер).
  if (tile?.classList.contains(SITE.judgeTileClass)) return "судья";
  const nick = tile?.querySelector(SITE.playerName)?.textContent?.trim();
  if (!numberEl) {
    // Плитки нет — это не обязательно «не за столом»: в мобильной вёрстке
    // сайт не рисует СВОЮ плитку, и паузу мог поставить сам игрок.
    return myPlayerId(doc) === id ? "вы" : `№${id + 1}`;
  }
  return nick ? `№${id + 1} ${nick}` : `№${id + 1}`;
}

/** Мой номер за столом (по своей плитке); null — своей плитки нет. */
function myPlayerId(doc: Document): number | null {
  const numberEl = doc.querySelector(`${SITE.myPlayerTile} ${SITE.playerNumber}`);
  for (const cls of Array.from(numberEl?.classList || [])) {
    const m = /^player-(\d+)$/.exec(cls);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * ВИДИМЫЙ экран паузы (пауза рисуется тем же блоком, что итог игры).
 *
 * Проверка размеров обязательна и должна быть настоящей: прежняя версия
 * содержала `!el.isConnected === false` — выражение тождественно истинно
 * для любого найденного узла, то есть видимость не проверялась вовсе, а
 * мутант «вернуть элемент как есть» проходил все тесты (ревью 08.08.2026).
 */
function pauseScreen(doc: Document = document): HTMLElement | null {
  const el = doc.querySelector<HTMLElement>(SITE.roomPauseScreen);
  if (!el) return null;
  return el.offsetWidth > 0 || el.offsetHeight > 0 ? el : null;
}

/**
 * Дописать/обновить подпись на экране паузы. Идемпотентно: без изменений в
 * DOM ничего не пишется, иначе подписчик будил бы сам себя (§4 п.1).
 */
export function renderLabel(doc: Document = document): void {
  const screen = pauseScreen(doc);
  const existing = doc.querySelector<HTMLElement>(`.${LABEL_CLASS}`);
  // Паузы нет или инициатор неизвестен — подписи быть не должно.
  if (!screen || initiatorId === null) {
    existing?.remove();
    return;
  }
  const text = `Паузу поставил: ${describeInitiator(initiatorId, doc)}`;
  if (existing) {
    if (existing.parentElement !== screen) screen.appendChild(existing);
    if (existing.textContent !== text) existing.textContent = text;
    return;
  }
  const el = doc.createElement("span");
  el.className = LABEL_CLASS;
  el.textContent = text;
  // Инлайн-стиль, а не отдельный <style>: одна строка, и её не должен
  // потерять сайт при перерисовке роллера.
  el.style.cssText =
    "display:block;margin-top:6px;font-size:14px;color:#ffd166;text-align:center;";
  screen.appendChild(el);
}

function onProbeMessage(e: MessageEvent): void {
  if (e.source !== window) return;
  const data = e.data as { source?: string; initiatorId?: unknown; finished?: unknown };
  if (data?.source !== PROBE_SOURCE) return;
  if (data.finished === true) {
    // Пауза кончилась — забываем инициатора, иначе следующая пауза начнётся
    // с чужой подписью, пока не придёт свой id.
    initiatorId = null;
    loggedFor = null;
    renderLabel();
    return;
  }
  const id = typeof data.initiatorId === "number" ? data.initiatorId : null;
  // null здесь — не «инициатора нет», а «в этом кадре его не прислали»:
  // затирать им уже известного нельзя (кадры обновления времени идут чаще).
  if (id === null) return;
  initiatorId = id;
  if (loggedFor !== id) {
    loggedFor = id;
    log.info(SCOPE, "паузу поставил:", describeInitiator(id));
  }
  renderLabel();
}

export const pauseInitiatorFeature: Feature = {
  id: "pause-initiator",
  settingKey: "pause_initiator_enabled",

  enable(_ctx: FeatureContext) {
    probeListener = (e: MessageEvent) => onProbeMessage(e);
    window.addEventListener("message", probeListener);
    // Роллер перерисовывается на каждом тике паузы и сносит наш узел —
    // возвращаем его вместе с остальными подписчиками.
    unsubscribe = onDomChange(() => renderLabel());
    renderLabel();
  },

  disable() {
    unsubscribe?.();
    unsubscribe = null;
    if (probeListener) {
      window.removeEventListener("message", probeListener);
      probeListener = null;
    }
    initiatorId = null;
    loggedFor = null;
    document.querySelector(`.${LABEL_CLASS}`)?.remove();
  },
};
