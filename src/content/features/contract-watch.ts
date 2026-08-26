/**
 * Фича: сторож контракта с сайтом (решение владельца 26.08.2026).
 *
 * Сайт — Vue-SPA без версионирования разметки: селектор может умереть молча,
 * и до этой фичи поломку диагностировали раскопками по жалобе. Сторож пишет
 * ОДНУ строку на вход в комнату: сколько ключевых узлов нашлось и откуда
 * взялся спрайт ролей. Здоровая строка — фон; строка с нулём — готовый
 * диагноз («селектор устарел») ещё до жалобы.
 *
 * Замер — через 15 секунд после входа: комната монтируется асинхронно,
 * мерить раньше значит ловить ложные нули. Уход из комнаты до срока
 * отменяет замер. Всегда включён (settingKey null): это датчик, пишет
 * только в журнал.
 */
import { log } from "@core/log";
import { SITE } from "@core/selectors";
import { resolveRoleSpriteBaseUrl } from "../role-sprite";
import type { Feature } from "@core/feature";

const SCOPE = "contract";

/** Пауза после входа в комнату до замера. */
export const SETTLE_MS = 15_000;

export interface RoomContract {
  tiles: number;
  controls: number;
  cameras: number;
  /** Откуда взялся спрайт ролей: живой DOM или зашитый фолбэк. */
  spriteSource: "dom" | "fallback";
}

/** Замер ключевых селекторов комнаты. Чистая по DOM — тестовый шов. */
export function evaluateRoomContract(root: ParentNode = document): RoomContract {
  const spriteInDom =
    root.querySelector(SITE.roleSymbols) !== null ||
    Array.from(root.querySelectorAll(SITE.roleUse)).some((u) => {
      const href = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
      return ["#civilian", "#sheriff", "#mafia", "#godfather"].some((m) => href.includes(m));
    });
  return {
    tiles: root.querySelectorAll(SITE.playerDesktop).length,
    controls: root.querySelectorAll(SITE.obsGameControls).length,
    cameras: root.querySelectorAll(SITE.playerVideo).length,
    spriteSource: spriteInDom ? "dom" : "fallback",
  };
}

/** Нули там, где в живой комнате нулей не бывает, — контракт под вопросом. */
export function contractLooksBroken(c: RoomContract): boolean {
  return c.tiles === 0 || c.controls === 0;
}

let enabled = false;
let inRoom = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
/** Фолбэк-спрайт проверяется сетью один раз за сессию вкладки. */
let spriteProbed = false;

function cancelSettle(): void {
  if (settleTimer !== null) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

function measure(): void {
  const c = evaluateRoomContract();
  const line = `комната: плитки=${c.tiles} контролы=${c.controls} камеры=${c.cameras} спрайт=${c.spriteSource}`;
  if (contractLooksBroken(c)) {
    // Нули — вероятный дрейф разметки сайта: селекторы пора сверять.
    log.warn(SCOPE, line, "— похоже на смену разметки сайта");
  } else {
    log.info(SCOPE, line);
  }
  // Зашитый фолбэк спрайта — единственный наш URL с hash'ем сборки сайта:
  // пересобрали бандл — иконки ролей молча пропали бы. Проверяем раз в сессию.
  if (c.spriteSource === "fallback" && !spriteProbed) {
    spriteProbed = true;
    const base = resolveRoleSpriteBaseUrl();
    if (base) {
      fetch(base, { method: "HEAD" })
        .then((res) => {
          if (!res.ok) log.warn(SCOPE, `фолбэк-спрайт ролей не отвечает (${res.status}): ${base}`);
        })
        .catch(() => log.warn(SCOPE, "фолбэк-спрайт ролей недоступен:", base));
    }
  }
}

/** Маршрут от URL-роутера: в игровой комнате или нет. */
export function syncContractWatchRoute(nowInRoom: boolean): void {
  if (nowInRoom === inRoom) return;
  inRoom = nowInRoom;
  cancelSettle();
  if (!enabled || !nowInRoom) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    measure();
  }, SETTLE_MS);
}

export const contractWatchFeature: Feature = {
  id: "contract-watch",
  // Датчик: ничего не делает за игрока, пишет только в журнал.
  settingKey: null,

  enable() {
    enabled = true;
    // Включились уже в комнате (бут вкладки) — таймер с этого момента.
    if (inRoom) {
      cancelSettle();
      settleTimer = setTimeout(() => {
        settleTimer = null;
        measure();
      }, SETTLE_MS);
    }
  },

  disable() {
    enabled = false;
    cancelSettle();
  },
};
