/**
 * Фича: «Выкрикнуть» с клавиши.
 *
 * Просьба владельца 13.08.2026. Кнопка выкрика живёт в центре игровых
 * контролов и подменяется на месте (см. controls-safety) — попасть по ней
 * мышью в нужный момент тем сложнее, чем важнее момент.
 *
 * Осторожность здесь не лишняя: выкрик — РАСХОДУЕМОЕ действие, лишний стоит
 * фола. Отсюда три ограничения:
 *  1. фича ВЫКЛЮЧЕНА по умолчанию — действие за игрока включает сам игрок
 *     (тот же принцип, что у автовозврата в очередь);
 *  2. клавиша работает только в игровой комнате и только если кнопка выкрика
 *     сейчас видима и не заблокирована — вне своего момента нажатие не делает
 *     ничего;
 *  3. кликаем САМУЮ ГЛУБОКУЮ подходящую кнопку и только по подписи из TEXT
 *     (инвариант AGENTS.md §4 п.2) — «выкрикнуть» не должно случайно попасть
 *     в кнопку-обёртку или в чужой диалог.
 *
 * Автоповтор зажатой клавиши гасит сам роутер, а печать в чате — проверка
 * isTypingContext: KeyC в русской раскладке это «с».
 */
import { keyboard } from "@core/keyboard";
import { isVisible, safeClick } from "@core/dom";
import { log } from "@core/log";
import { SITE, TEXT } from "@core/selectors";
import { isGameRoomPath } from "@shared/routes";
import type { Feature, FeatureContext } from "@core/feature";

const SCOPE = "outcry-hotkey";

const norm = (text: string | null | undefined): string =>
  (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Кнопка выключена сайтом (выкрик уже потрачен, не твой момент). */
function disabled(el: Element): boolean {
  return (
    el.classList.contains("disabled") ||
    el.hasAttribute("disabled") ||
    el.getAttribute("aria-disabled") === "true"
  );
}

/**
 * Видимая кнопка выкрика в центре контролов. null — сейчас выкрикнуть нельзя.
 * Экспорт — тестовый шов.
 */
export function findOutcryButton(root: ParentNode = document): HTMLElement | null {
  const center = root.querySelector<HTMLElement>(SITE.controlsCenter);
  if (!center) return null;
  const candidates = Array.from(center.querySelectorAll<HTMLElement>(SITE.controlsButton));
  return (
    candidates.find((button) => {
      if (!TEXT.outcryButton.some((marker) => norm(button.textContent).includes(marker))) {
        return false;
      }
      if (!isVisible(button) || disabled(button)) return false;
      // Только самая глубокая: у вложенной обёртки текст тот же, а клик по
      // ней сайт может не считать нажатием кнопки.
      return !candidates.some((other) => other !== button && button.contains(other));
    }) ?? null
  );
}

/** Нажатие клавиши. Экспорт — тестовый шов. */
export function pressOutcry(): boolean {
  if (!isGameRoomPath(location.pathname)) return false;
  const button = findOutcryButton();
  if (!button) {
    log.debug(SCOPE, "выкрик сейчас недоступен — кнопки нет");
    return false;
  }
  safeClick(button);
  log.info(SCOPE, "выкрик по клавише");
  return true;
}

let off: (() => void) | null = null;
let boundCode = "";

function bind(code: string): void {
  off?.();
  boundCode = code || "KeyC";
  off = keyboard.register(
    boundCode,
    () => {
      pressOutcry();
    },
    { preventDefault: true },
  );
}

export const outcryHotkeyFeature: Feature = {
  id: "outcry-hotkey",
  settingKey: "outcry_hotkey_enabled",

  enable(ctx: FeatureContext) {
    bind(ctx.settings.outcry_hotkey_code);
  },

  update(ctx: FeatureContext) {
    // Смена клавиши применяется на лету, без перезагрузки игры.
    if (ctx.settings.outcry_hotkey_code !== boundCode) bind(ctx.settings.outcry_hotkey_code);
  },

  disable() {
    off?.();
    off = null;
    boundCode = "";
  },
};
