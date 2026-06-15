/**
 * Диагностика селекторов сайта. Помогает быстро понять, что сломалось после
 * редизайна polemicagame.com (расширение завязано на разметку сайта).
 *
 * В консоли: polemicaDiag() — покажет, сколько элементов матчит каждый SITE-селектор
 * и текущую версию расширения.
 * Плюс пассивная проверка: если страница похожа на игру, но ключевые селекторы пусты,
 * пишет предупреждение в консоль.
 */
import { browser } from "@core/env";
import { log } from "@core/log";
import { SITE } from "@core/selectors";

function snapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(SITE)) {
    if (typeof value !== "string") continue;
    try {
      out[key] = document.querySelectorAll(value).length;
    } catch {
      out[key] = -1; // некорректный селектор
    }
  }
  return out;
}

export function setupDiagnostics(): void {
  (window as any).polemicaDiag = () => {
    const version = browser.runtime.getManifest().version;
    const selectors = snapshot();
    const missing = Object.entries(selectors)
      .filter(([, n]) => n === 0)
      .map(([k]) => k);
    // eslint-disable-next-line no-console
    console.log(`[polemica:diag] v${version}`, { selectors, missing });
    return { version, selectors, missing };
  };

  // Пассивная проверка: если это похоже на игровую страницу, но игроков нет —
  // вероятно, изменилась разметка. Пишем предупреждение (видно на уровне warn).
  setTimeout(() => {
    const looksLikeGame =
      location.pathname.includes("/game") || !!document.querySelector(SITE.playerVideoWrapper);
    if (looksLikeGame && document.querySelectorAll(SITE.player).length === 0) {
      log.warn(
        "diag",
        "похоже на игру, но селектор .player пуст — возможно, изменилась разметка сайта. Запусти polemicaDiag() в консоли для деталей.",
      );
    }
  }, 8000);
}
