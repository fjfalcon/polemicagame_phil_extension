/**
 * Фича: развести опасные кнопки игровых контролов по разным краям.
 *
 * Боль (владелец, 09.08.2026): «игроки случайно жмут „Завершите речь“ и как
 * итог „Выкрикнуть“». Причина не в том, что кнопки рядом, — они буквально В
 * ОДНОЙ ТОЧКЕ.
 *
 * Как это устроено у сайта (сверено с живым room/bundle/main.js и style.css):
 *   .controls  → flex, три зоны: .left | .center | .right
 *   .center    → justify-content: center
 * Компонент UserControls рисует кнопки ФРАГМЕНТОМ (без обёртки) из списка
 * действий, который приходит с сервера, отфильтрованного по
 * ["skip","guess","cancelGuess","foul"]. В центре почти всегда РОВНО ОДНА
 * кнопка: своя речь → «Завершите речь» (skip), чужая → «Выкрикнуть» (foul).
 * Поэтому в момент конца речи кнопка подменяется на месте, и повторный
 * клик — или клик, начатый до подмены, — тратит выкрик (а это фол).
 *
 * Отсюда решение: не менять ПОРЯДОК (при одной кнопке он ничего не значит),
 * а прижать кнопки к разным краям центра — «Завершите речь» вправо, ЛХ
 * влево. Тогда после подмены палец оказывается над пустым местом.
 * «Выкрикнуть» намеренно оставлен по центру: это не опасная кнопка, а та,
 * от которой мы уводим.
 *
 * Раскладку делает CSS, а JS только помечает кнопки классом — записей в DOM
 * на тик нет, кроме появления/исчезновения самой кнопки (инвариант §4 п.1).
 * Классы сайта для этих кнопок неразличимы (все — `.button.preset-N`), так
 * что различаем по подписи; обе локали держатся в TEXT и сторожатся
 * контрактными пробами.
 */
import { onDomChange } from "@core/dom";
import { SITE, TEXT } from "@core/selectors";
import type { Feature, FeatureContext } from "@core/feature";

const STYLE_ID = "pn-controls-safety";
/** Класс кнопки, которую уводим вправо. */
export const FINISH_CLASS = "pn-ctl-finish";
/** Класс кнопок лучшего хода — они уходят влево. */
export const GUESS_CLASS = "pn-ctl-guess";

let unsubscribe: (() => void) | null = null;

/** Нормализовать подпись кнопки для сравнения с маркерами. */
function norm(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Какой из наших классов положен кнопке; null — не наша кнопка. */
export function classifyButton(label: string): string | null {
  const t = norm(label);
  if (!t) return null;
  if (TEXT.finishSpeechButton.some((m) => t.includes(m))) return FINISH_CLASS;
  if (TEXT.guessButtons.some((m) => t.includes(m))) return GUESS_CLASS;
  return null;
}

/**
 * `margin: auto` вместо `order`: в центре обычно ОДНА кнопка, и порядок при
 * одном элементе не значит ничего, а автоотступ прижимает её к краю даже в
 * одиночку.
 */
const CSS = `
.controls .center > .${FINISH_CLASS} { margin-left: auto !important; }
.controls .center > .${GUESS_CLASS} { margin-right: auto !important; }
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Пометить кнопки центра. Идемпотентно: без изменений в DOM ничего не пишем. */
export function markButtons(root: ParentNode = document): void {
  const center = root.querySelector<HTMLElement>(SITE.controlsCenter);
  if (!center) return;
  for (const button of Array.from(center.querySelectorAll<HTMLElement>(SITE.controlsButton))) {
    const wanted = classifyButton(button.textContent);
    const hasFinish = button.classList.contains(FINISH_CLASS);
    const hasGuess = button.classList.contains(GUESS_CLASS);
    if (wanted === FINISH_CLASS) {
      if (!hasFinish) button.classList.add(FINISH_CLASS);
      if (hasGuess) button.classList.remove(GUESS_CLASS);
    } else if (wanted === GUESS_CLASS) {
      if (!hasGuess) button.classList.add(GUESS_CLASS);
      if (hasFinish) button.classList.remove(FINISH_CLASS);
    } else {
      // Подпись сменилась на чужую (Vue переиспользует узел под другое
      // действие) — метку обязаны снять, иначе «Выкрикнуть» уедет вправо,
      // ровно туда, откуда мы его уводим.
      if (hasFinish) button.classList.remove(FINISH_CLASS);
      if (hasGuess) button.classList.remove(GUESS_CLASS);
    }
  }
}

/** Снять всё наше (выключение фичи). */
function cleanup(): void {
  document.getElementById(STYLE_ID)?.remove();
  for (const cls of [FINISH_CLASS, GUESS_CLASS]) {
    document.querySelectorAll<HTMLElement>(`.${cls}`).forEach((el) => el.classList.remove(cls));
  }
}

export const controlsSafetyFeature: Feature = {
  id: "controls-safety",
  settingKey: "safe_controls_layout_enabled",

  enable(_ctx: FeatureContext) {
    ensureStyle();
    markButtons();
    // Кнопки появляются и исчезают на каждой смене говорящего — держим метки
    // тем же общим наблюдателем, что и остальные фичи.
    unsubscribe = onDomChange(() => markButtons());
  },

  disable() {
    unsubscribe?.();
    unsubscribe = null;
    cleanup();
  },
};
