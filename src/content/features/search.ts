/**
 * Фича: при нажатии кнопки поиска игры уведомляет background,
 * который инжектит автопринятие. Порт content.js.
 * Гейтится настройкой auto_accept_enabled.
 */
import { sendRuntime } from "@core/messaging";
import { SITE } from "@core/selectors";
import { releaseForUserAction } from "../auto-accept-gate";
import type { Feature } from "@core/feature";

let onClick: ((e: MouseEvent) => void) | null = null;

export const searchFeature: Feature = {
  id: "search",
  settingKey: "auto_accept_enabled",
  enable() {
    onClick = (e: MouseEvent) => {
      // Только НАСТОЯЩИЙ клик игрока: синтетический click() от скрипта сайта
      // открывал 10-секундное окно автопринятия в background-инжекте
      // (аудит безопасности 01.08.2026, находка 11).
      if (!e.isTrusted) return;
      const t = e.target as HTMLElement;
      if (t.matches?.(SITE.profileSearchButton)) {
        // Игрок сам начал поиск — его действие важнее нашей разведки очереди:
        // если стоп-кран ещё стоял, снимаем и работаем как обычно.
        releaseForUserAction();
        // players/gameFound из старого протокола никто не читал — не собираем.
        void sendRuntime({ action: "startSearch" });
      } else if (t.matches?.(SITE.profileSearchClose)) {
        void sendRuntime({ action: "stopSearch" });
      }
    };
    document.addEventListener("click", onClick, true);
  },
  disable() {
    if (onClick) document.removeEventListener("click", onClick, true);
    onClick = null;
  },
};
