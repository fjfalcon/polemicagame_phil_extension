/**
 * Фича: при нажатии кнопки поиска игры уведомляет background,
 * который инжектит автопринятие. Порт content.js.
 * Гейтится настройкой auto_accept_enabled.
 */
import { sendRuntime } from "@core/messaging";
import { SITE } from "@core/selectors";
import type { Feature } from "@core/feature";

let onClick: ((e: MouseEvent) => void) | null = null;

export const searchFeature: Feature = {
  id: "search",
  settingKey: "auto_accept_enabled",
  enable() {
    onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.matches?.(SITE.profileSearchButton)) {
        let players = "0";
        const el = document.querySelector(SITE.profileSearchPlayers);
        const m = el?.textContent?.match(/\d+/g);
        if (m) players = m[0];
        void sendRuntime({ action: "startSearch", players, gameFound: true });
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
