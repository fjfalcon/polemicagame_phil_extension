/**
 * Фича: раскладка кнопок действий в игре.
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
 * а прижимать кнопки к краям центра автоотступами — с одним элементом
 * работает только это.
 *
 * РАСКЛАДКА НАСТРАИВАЕТСЯ. Сначала она была зашита в код, но правильного
 * места «для всех» не существует, а любая перестановка стоила бы релиза
 * (замечание владельца 09.08.2026). Теперь позиция каждой кнопки — обычная
 * настройка; дефолты повторяют прежнее безопасное поведение.
 *
 * Раскладку делает CSS, а JS только помечает кнопки классом — записей в DOM
 * на тик нет, кроме появления/исчезновения самой кнопки (инвариант §4 п.1).
 * Классы сайта для этих кнопок неразличимы (все — `.button.preset-N`), так
 * что различаем по подписи; обе локали держатся в TEXT и сторожатся
 * контрактными пробами.
 */
import { onDomChange } from "@core/dom";
import { SITE, TEXT } from "@core/selectors";
import {
  CONTROL_KINDS,
  DEFAULT_CONTROL_POSITIONS,
  controlPositionKey,
  readControlPosition,
} from "@shared/controls-layout";
import type { ControlKind, ControlPosition } from "@shared/controls-layout";
import type { Feature, FeatureContext } from "@core/feature";
import type { Settings } from "@shared/types";

const STYLE_ID = "pn-controls-safety";
/** Классы-метки кнопок: по ним же работает CSS и уборка. */
export const KIND_CLASS: Record<ControlKind, string> = {
  finish: "pn-ctl-finish",
  outcry: "pn-ctl-outcry",
  guess: "pn-ctl-guess",
};

let unsubscribe: (() => void) | null = null;
let positions: Record<ControlKind, ControlPosition> = { ...DEFAULT_CONTROL_POSITIONS };

/** Нормализовать подпись кнопки для сравнения с маркерами. */
function norm(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Что это за кнопка; null — не наша. */
export function classifyButton(label: string): ControlKind | null {
  const t = norm(label);
  if (!t) return null;
  if (TEXT.finishSpeechButton.some((m) => t.includes(m))) return "finish";
  if (TEXT.outcryButton.some((m) => t.includes(m))) return "outcry";
  if (TEXT.guessButtons.some((m) => t.includes(m))) return "guess";
  return null;
}

/** Прочитать раскладку из настроек. Экспорт — тестовый шов. */
export function readPositions(settings: Partial<Settings> | null): Record<ControlKind, ControlPosition> {
  const out = {} as Record<ControlKind, ControlPosition>;
  for (const kind of Object.keys(CONTROL_KINDS) as ControlKind[]) {
    out[kind] = readControlPosition(
      kind,
      (settings as Record<string, unknown> | null)?.[controlPositionKey(kind)],
    );
  }
  return out;
}

/**
 * CSS раскладки. `margin: auto` вместо `order`: в центре обычно ОДНА кнопка,
 * и порядок при одном элементе не значит ничего, а автоотступ прижимает её к
 * краю даже в одиночку. Центр — отсутствие правил, а не своё правило: так
 * кнопка остаётся ровно там, где её рисует сайт.
 */
export function styleText(map: Record<ControlKind, ControlPosition>): string {
  const rules: string[] = [];
  for (const kind of Object.keys(CONTROL_KINDS) as ControlKind[]) {
    const cls = KIND_CLASS[kind];
    if (map[kind] === "right") {
      rules.push(`.controls .center > .${cls} { margin-left: auto !important; }`);
    } else if (map[kind] === "left") {
      rules.push(`.controls .center > .${cls} { margin-right: auto !important; }`);
    }
  }
  return rules.join("\n");
}

function syncStyle(): void {
  const css = styleText(positions);
  const existing = document.getElementById(STYLE_ID);
  if (!css) {
    existing?.remove();
    return;
  }
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

/** Пометить кнопки центра. Идемпотентно: без изменений в DOM ничего не пишем. */
export function markButtons(root: ParentNode = document): void {
  const center = root.querySelector<HTMLElement>(SITE.controlsCenter);
  if (!center) return;
  for (const button of Array.from(center.querySelectorAll<HTMLElement>(SITE.controlsButton))) {
    const kind = classifyButton(button.textContent);
    for (const [k, cls] of Object.entries(KIND_CLASS) as [ControlKind, string][]) {
      const should = k === kind;
      const has = button.classList.contains(cls);
      // Метку обязаны и СНИМАТЬ: Vue переиспользует узел под другое действие,
      // и оставшийся класс увёл бы «Выкрикнуть» туда, откуда мы его уводим.
      if (should && !has) button.classList.add(cls);
      else if (!should && has) button.classList.remove(cls);
    }
  }
}

/** Снять всё наше (выключение фичи). */
function cleanup(): void {
  document.getElementById(STYLE_ID)?.remove();
  for (const cls of Object.values(KIND_CLASS)) {
    document.querySelectorAll<HTMLElement>(`.${cls}`).forEach((el) => el.classList.remove(cls));
  }
}

export const controlsSafetyFeature: Feature = {
  id: "controls-safety",
  settingKey: "safe_controls_layout_enabled",

  enable(ctx: FeatureContext) {
    positions = readPositions(ctx.settings);
    syncStyle();
    markButtons();
    // Кнопки появляются и исчезают на каждой смене говорящего — держим метки
    // тем же общим наблюдателем, что и остальные фичи.
    unsubscribe = onDomChange(() => markButtons());
  },

  update(ctx: FeatureContext) {
    // Смена раскладки в попапе применяется сразу, без перезагрузки игры.
    positions = readPositions(ctx.settings);
    syncStyle();
    markButtons();
  },

  disable() {
    unsubscribe?.();
    unsubscribe = null;
    cleanup();
  },
};
