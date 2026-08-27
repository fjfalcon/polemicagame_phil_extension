/**
 * Общий «вид» плавающей панели: прозрачность фона, скрытый заголовок,
 * размер шрифта, режим «сквозь клики» — и элементы меню, которыми это
 * настраивают.
 *
 * Появился из twitch-панели (там всё это написано первым, 16.08.2026) в тот
 * момент, когда те же настройки понадобились «Моему вечеру» (просьба
 * владельца 27.08.2026). Две копии разошлись бы на первой же правке —
 * например, санитайзер враждебного localStorage починили бы в одной.
 *
 * ВНИМАНИЕ: настройки живут в localStorage СТРАНИЦЫ рядом с позицией панели
 * (fp:*), а страница принадлежит сайту — источник недоверенный, каждое поле
 * санитизируется при чтении (карта хранилища, AGENTS.md §5).
 */

export interface ChromePrefs {
  /** Заголовок скрыт: панель — чистый оверлей, ручка перетаскивания сверху. */
  headerHidden: boolean;
  /** Прозрачность фона, 0..100 (0 — фона нет вовсе). */
  bgOpacity: number;
  fontSize: "s" | "m" | "l";
  /** Панель не ловит мышь вообще — оверлей «только чтение» поверх игры. */
  clickThrough: boolean;
}

export const CHROME_DEFAULTS: ChromePrefs = {
  headerHidden: false,
  bgOpacity: 95,
  fontSize: "m",
  clickThrough: false,
};

/** Коэффициент к базовому кеглю панели: s/m/l — одинаково во всех панелях. */
export const FONT_SCALE = { s: 0.88, m: 1, l: 1.14 } as const;

/**
 * Прочитать своё поле объекта. ТОЛЬКО собственное (Object.hasOwn): доступ
 * через точку шёл бы по цепочке прототипов, и унаследованное поле подходящего
 * типа (clickThrough: true на Object.prototype) прошло бы схему как выбор
 * пользователя (аудит хрупкости 06.08.2026).
 */
export function ownField(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return Object.hasOwn(raw as object, key) ? (raw as Record<string, unknown>)[key] : undefined;
}

/** Санитайзер общих полей вида. Экспортирован как шов для property-тестов. */
export function sanitizeChromePrefs(raw: unknown, d: ChromePrefs = CHROME_DEFAULTS): ChromePrefs {
  const bgOpacity = ownField(raw, "bgOpacity");
  const fontSize = ownField(raw, "fontSize");
  const headerHidden = ownField(raw, "headerHidden");
  const clickThrough = ownField(raw, "clickThrough");
  // Дефолт панели уважается КАЖДЫМ полем: подпись обещает `d`, и панель с
  // другим дефолтом не должна молча получать чужой (adversarial 27.08.2026).
  return {
    headerHidden: typeof headerHidden === "boolean" ? headerHidden : d.headerHidden,
    bgOpacity:
      typeof bgOpacity === "number" && Number.isFinite(bgOpacity)
        ? Math.min(100, Math.max(0, Math.round(bgOpacity)))
        : d.bgOpacity,
    fontSize:
      fontSize === "s" || fontSize === "m" || fontSize === "l" ? fontSize : d.fontSize,
    clickThrough: typeof clickThrough === "boolean" ? clickThrough : d.clickThrough,
  };
}

/** Разобранный JSON из localStorage страницы; ошибка чтения = «нет настроек». */
/**
 * Потолок сырого JSON: хранилище принадлежит сайту, и многомегабайтная
 * строка в нашем ключе — мусор или атака на парсер, читать её незачем
 * (тем же потолком защищён парсер истории чата).
 */
const PREFS_RAW_MAX = 20_000;

export function readPanelPrefsRaw(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > PREFS_RAW_MAX) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function savePanelPrefs(key: string, prefs: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    /* приватный режим / квота */
  }
}

// ─────────────────────────── применение вида ───────────────────────────

/** Записать стиль, только если он реально меняется (наблюдатель следит за style). */
function setStyle(el: HTMLElement, prop: "background" | "borderColor" | "boxShadow" | "display" | "pointerEvents" | "opacity" | "font", value: string): void {
  if (el.style[prop] !== value) el.style[prop] = value;
}

export interface ApplyChromeTargets {
  root: HTMLElement;
  header: HTMLElement;
  /** Ручки ресайза: в «сквозь клики» их насечка не должна светиться в эфире. */
  resizeHandles?: HTMLElement[];
  /** Полоска-ручка, видимая вместо скрытого заголовка. */
  hoverStrip?: HTMLElement | null;
  /** Чип-замок: единственное кликабельное место в режиме «сквозь клики». */
  unlockChip?: HTMLElement | null;
  /** Меню настроек — в режиме «сквозь клики» его некому закрыть. */
  gearMenu?: HTMLElement | null;
}

/**
 * Разложить настройки вида по элементам панели.
 *
 * Идемпотентности здесь не требуется: зовётся по действию пользователя в
 * меню, а не из подписчика onDomChange (§4 инвариантов).
 */
export function applyChrome(prefs: ChromePrefs, t: ApplyChromeTargets): void {
  const a = prefs.bgOpacity / 100;
  // Записи гейтированы сравнением: ползунок «Фон» шлёт до сотни событий
  // input за жест, и безусловная запись будила бы общий наблюдатель на
  // каждое из них (adversarial 27.08.2026).
  setStyle(t.root, "background", `rgba(30,31,38,${a.toFixed(2)})`);
  setStyle(t.root, "borderColor", `rgba(255,255,255,${(0.12 * a).toFixed(3)})`);
  setStyle(t.root, "boxShadow", a < 0.2 ? "none" : "0 8px 30px rgba(0,0,0,.45)");
  setStyle(t.header, "display", prefs.headerHidden ? "none" : "flex");
  if (t.hoverStrip) {
    setStyle(t.hoverStrip, "display", prefs.headerHidden && !prefs.clickThrough ? "flex" : "none");
  }
  setStyle(t.root, "pointerEvents", prefs.clickThrough ? "none" : "");
  if (t.unlockChip) setStyle(t.unlockChip, "display", prefs.clickThrough ? "grid" : "none");
  for (const h of t.resizeHandles ?? []) {
    // Мышь ручки всё равно не ловят (наследуют pointer-events:none), но
    // насечка уголка светилась на прозрачном оверлее — видно зрителям.
    setStyle(h, "display", prefs.clickThrough ? "none" : "block");
  }
  if (prefs.clickThrough && t.gearMenu) setStyle(t.gearMenu, "display", "none");
}

// ─────────────────────────── элементы меню ───────────────────────────

export function menuRow(label: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;";
  const l = document.createElement("span");
  l.textContent = label;
  l.style.color = "rgba(255,255,255,.85)";
  r.append(l, control);
  return r;
}

export function menuCheck(value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const c = document.createElement("input");
  c.type = "checkbox";
  c.checked = value;
  c.style.cursor = "pointer";
  c.addEventListener("change", () => onChange(c.checked));
  return c;
}

/**
 * Ползунок с ЖИВЫМ предпросмотром и одной записью на диск.
 *
 * `input` — только вид (иначе перетаскивание ползунка пишет в localStorage
 * десятки раз), `change` — сохранение по отпусканию.
 */
export function menuRange(
  value: number,
  onPreview: (v: number) => void,
  onCommit: () => void,
): HTMLInputElement {
  const range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = "100";
  range.value = String(value);
  range.style.cssText = "width:100px;cursor:pointer;";
  range.addEventListener("input", () => onPreview(Number(range.value)));
  range.addEventListener("change", onCommit);
  return range;
}

export function menuSegmented<T extends string>(
  variants: readonly T[],
  current: T,
  label: (v: T) => string,
  onPick: (v: T) => void,
): HTMLElement {
  const wrap = document.createElement("span");
  variants.forEach((v) => {
    const b = document.createElement("button");
    b.textContent = label(v);
    b.dataset.value = v;
    b.style.cssText =
      "border:1px solid rgba(255,255,255,.25);background:transparent;color:#fff;" +
      "cursor:pointer;padding:2px 7px;margin-left:4px;border-radius:5px;font-size:11px;";
    if (v === current) b.style.background = "rgba(99,102,241,.5)";
    b.addEventListener("click", () => {
      wrap.querySelectorAll("button").forEach((x) => (x.style.background = "transparent"));
      b.style.background = "rgba(99,102,241,.5)";
      onPick(v);
    });
    wrap.appendChild(b);
  });
  return wrap;
}

export function menuSelect(
  variants: readonly number[],
  current: number,
  onPick: (v: number) => void,
): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.style.cssText =
    "background:#1e1f26;color:#fff;border:1px solid rgba(255,255,255,.25);" +
    "border-radius:5px;padding:2px 4px;cursor:pointer;font-size:11px;";
  for (const n of variants) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = String(n);
    if (n === current) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onPick(Number(sel.value)));
  return sel;
}

export function menuHint(text: string): HTMLElement {
  const hint = document.createElement("div");
  hint.textContent = text;
  hint.style.cssText = "color:rgba(255,255,255,.45);font-size:10px;line-height:1.4;";
  return hint;
}

/** Пустой контейнер меню «шестерёнки». Наполняется при каждом открытии. */
export function buildGearMenu(root: HTMLElement): HTMLElement {
  const menu = document.createElement("div");
  Object.assign(menu.style, {
    position: "absolute",
    top: "34px",
    right: "6px",
    zIndex: "6",
    display: "none",
    width: "210px",
    padding: "10px",
    background: "#23242c",
    border: "1px solid rgba(255,255,255,.15)",
    borderRadius: "8px",
    boxShadow: "0 8px 24px rgba(0,0,0,.5)",
    font: "12px/1.5 system-ui, sans-serif",
    // Панель может быть НИЖЕ меню, а у root overflow:hidden — без потолка
    // высоты нижние пункты недостижимы (блокер ревью 16.08.2026).
    maxHeight: "calc(100% - 44px)",
    overflowY: "auto",
    boxSizing: "border-box",
  } as CSSStyleDeclaration);
  root.appendChild(menu);
  return menu;
}

/**
 * Полоска-ручка вместо скрытого заголовка: проявляется под курсором, несёт
 * «⚙» и «▾» (вернуть заголовок) и служит ручкой перетаскивания.
 */
export function buildHoverStrip(opts: {
  root: HTMLElement;
  onGear: () => void;
  onShowHeader: () => void;
  /**
   * Кнопки панели, которые нельзя терять вместе с заголовком. У «Моего
   * вечера» это «обновить», «начать заново» и «закрыть»: скрытие заголовка
   * отбирало три действия из четырёх (adversarial 27.08.2026).
   */
  extra?: Array<{ label: string; title: string; onClick: () => void }>;
}): HTMLElement {
  const strip = document.createElement("div");
  Object.assign(strip.style, {
    position: "absolute",
    top: "0",
    left: "0",
    right: "0",
    height: "18px",
    zIndex: "5",
    display: "none",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "4px",
    padding: "0 4px",
    cursor: "move",
    userSelect: "none",
    touchAction: "none",
    opacity: "0",
    transition: "opacity .15s",
    background: "linear-gradient(rgba(0,0,0,.6), transparent)",
  } as CSSStyleDeclaration);
  strip.addEventListener("mouseenter", () => setStyle(strip, "opacity", "1"));
  strip.addEventListener("mouseleave", () => setStyle(strip, "opacity", "0"));

  const mkBtn = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    Object.assign(b.style, {
      background: "transparent",
      border: "none",
      color: "#fff",
      cursor: "pointer",
      fontSize: "11px",
      lineHeight: "1",
      padding: "2px 4px",
    } as CSSStyleDeclaration);
    b.addEventListener("click", onClick);
    return b;
  };
  for (const b of opts.extra ?? []) strip.appendChild(mkBtn(b.label, b.title, b.onClick));
  strip.append(
    mkBtn("⚙", "Настройки панели", opts.onGear),
    mkBtn("▾", "Показать заголовок", opts.onShowHeader),
  );
  opts.root.appendChild(strip);
  return strip;
}

/** Чип-замок: выход из режима «сквозь клики», когда панель мышь не ловит. */
export function buildUnlockChip(
  root: HTMLElement,
  title: string,
  onUnlock: () => void,
): HTMLElement {
  const chip = document.createElement("button");
  chip.textContent = "🔓";
  chip.title = title;
  Object.assign(chip.style, {
    position: "absolute",
    top: "4px",
    right: "4px",
    zIndex: "7",
    width: "22px",
    height: "22px",
    display: "none",
    placeItems: "center",
    border: "none",
    borderRadius: "6px",
    background: "rgba(0,0,0,.55)",
    fontSize: "12px",
    cursor: "pointer",
    opacity: "0.35",
    transition: "opacity .15s",
    // Родитель в режиме сквозь-кликов имеет pointer-events:none; у чипа —
    // явный auto, поэтому он единственный остаётся кликабельным.
    pointerEvents: "auto",
  } as CSSStyleDeclaration);
  chip.addEventListener("mouseenter", () => setStyle(chip, "opacity", "1"));
  chip.addEventListener("mouseleave", () => setStyle(chip, "opacity", "0.35"));
  chip.addEventListener("click", onUnlock);
  root.appendChild(chip);
  return chip;
}
