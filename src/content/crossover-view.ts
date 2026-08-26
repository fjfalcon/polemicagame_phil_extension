/**
 * Представление парной статистики (общий модуль).
 *
 * Жил приватным методом player-notes (ховер-кнопка за столом); вынесен,
 * когда та же сводка понадобилась странице профиля (просьба владельца
 * 26.08.2026). Два экземпляра одной таблицы разъехались бы при первой
 * правке формулировок — прецедент role-sprite.
 */
import type { Bucket, Crossover } from "@core/crossover";

/**
 * Сводка пересечений таблицей: сначала итог, потом разрезы по цветам.
 * Форма подсказана владельцем (образец 09.08.2026) — «одноцвет/разноцвет»
 * читается игроками сходу, в отличие от голых процентов.
 *
 * Победы ВЕЗДЕ мои: в одноцвете это и общая победа, в разноцвете — именно
 * моя. Иначе одна и та же колонка означала бы разное в разных строках.
 */
export function formatCrossover(x: Crossover): string {
  if (x.together === 0) {
    return x.capped
      ? "Общих игр в доступной истории нет"
      : "Вы ещё не играли вместе";
  }
  const line = (label: string, b: Bucket, inset = false): string => {
    if (b.games === 0) return "";
    const pct = Math.round((b.wins / b.games) * 100);
    return `
      <div style="display:flex;justify-content:space-between;gap:14px;${inset ? "opacity:.8;padding-left:10px;" : ""}">
        <span>${label}</span><span>${b.wins} / ${b.games} (${pct}%)</span>
      </div>`;
  };
  const rows = [
    `<div style="display:flex;justify-content:space-between;gap:14px;font-weight:600">
       <span>Совместных игр</span><span>${x.together}</span>
     </div>`,
    line("Одноцвет", x.sameTeam),
    line("— оба красные", x.sameRed, true),
    line("— оба чёрные", x.sameBlack, true),
    line("Разноцвет", x.versus),
    line("— ты красный", x.versusMyRed, true),
    line("— ты чёрный", x.versusMyBlack, true),
  ].join("");
  // Оборванную историю обязаны показать: «вместе 12» и «12 за доступный
  // отрезок» — разные утверждения, и второе легко принять за первое.
  const note = x.capped
    ? '<div style="opacity:.7;margin-top:6px">история длинная — учтён доступный отрезок</div>'
    : "";
  return `${rows}${note}`;
}
