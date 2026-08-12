/**
 * Единый keyboard-роутер. Раньше role-faker/pause-hotkey/auto-start каждый
 * вешали свой keydown(capture) и конфликтовали (D блокировался в одном месте,
 * обрабатывался в другом). Теперь один слушатель и явная регистрация хоткеев.
 *
 * Поддерживает раскладко-независимость через event.code (KeyF == и F, и А).
 */
import { log } from "./log";

export type HotkeyHandler = (e: KeyboardEvent) => void;

interface Binding {
  code: string;
  handler: HotkeyHandler;
  preventDefault: boolean;
}

/**
 * Может ли эта физическая клавиша дать символ в поле ввода.
 * F1..F12, Escape и стрелки — не могут, поэтому такой хоткей (например пауза на F8)
 * должен работать и когда курсор стоит в чате.
 */
export function producesText(code: string): boolean {
  return /^(Key|Digit|Numpad|Minus|Equal|Bracket|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Space|Intl)/.test(
    code,
  );
}

/** Пользователь печатает — в поле ввода, в textarea или в contenteditable. */
export function isTypingContext(e: KeyboardEvent): boolean {
  const candidates: Array<EventTarget | null> = [e.target, document.activeElement];
  for (const c of candidates) {
    if (!(c instanceof HTMLElement)) continue;
    const tag = c.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (c.isContentEditable) return true;
  }
  return false;
}

class KeyboardRouter {
  private bindings = new Map<string, Binding>();
  private started = false;

  private onKeyDown = (e: KeyboardEvent) => {
    const b = this.bindings.get(e.code);
    if (!b) return;

    // Хоткеи привязаны к event.code (физической клавише) ради раскладко-независимости.
    // Обратная сторона: в русской раскладке KeyF — это «а», KeyD — «в», KeyE — «у».
    // Без этих проверок фраза в игровом чате перещёлкивала подменённую роль и
    // снимала скрытие роли — то есть показывала её на стриме.
    if (isTypingContext(e) && producesText(e.code)) return;
    // Ctrl+F / Cmd+D и прочие сочетания принадлежат браузеру и сайту, не нам.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Зажатая клавиша не должна гнать обработчик с частотой автоповтора.
    if (e.repeat) return;

    if (b.preventDefault) e.preventDefault();
    try {
      b.handler(e);
    } catch (err) {
      log.error("keyboard", "handler threw", e.code, err);
    }
  };

  private ensureStarted() {
    if (this.started) return;
    // capture=true: перехватываем раньше обработчиков сайта
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.started = true;
  }

  /** Клавиши-«зажатия», которые сейчас нажаты: чтобы отпуск был ровно один. */
  private held = new Set<string>();
  private holds = new Map<string, { down: () => void; up: () => void }>();

  private onKeyUp = (e: KeyboardEvent) => {
    this.releaseHold(e.code);
  };

  /**
   * Страховка от «залипшей» клавиши: alt-tab, потеря фокуса или сворачивание
   * вкладки съедают keyup, и режим «подсмотреть» остался бы включённым — то
   * есть роль уехала бы в эфир. Ровно то, от чего фича и защищает.
   */
  private onBlur = () => {
    for (const code of Array.from(this.held)) this.releaseHold(code);
  };

  private onVisibility = () => {
    if (document.visibilityState === "hidden") this.onBlur();
  };

  private releaseHold(code: string): void {
    if (!this.held.delete(code)) return;
    try {
      this.holds.get(code)?.up();
    } catch (err) {
      log.error("keyboard", "hold release threw", code, err);
    }
  }

  /**
   * Клавиша-«зажатие»: `down` на нажатии, `up` на отпускании И на любой
   * потере фокуса. Нужна там, где показ чего-либо на экране должен жить
   * ровно столько, сколько человек держит палец (роли у стримера).
   */
  registerHold(code: string, down: () => void, up: () => void): () => void {
    this.ensureStarted();
    this.holds.set(code, { down, up });
    const unregister = this.register(code, () => {
      if (this.held.has(code)) return;
      this.held.add(code);
      down();
    }, { preventDefault: true });
    return () => {
      this.releaseHold(code);
      this.holds.delete(code);
      unregister();
    };
  }

  /**
   * Зарегистрировать хоткей по физической клавише (event.code, напр. "KeyF", "F8").
   * Возвращает функцию отписки.
   */
  register(code: string, handler: HotkeyHandler, opts: { preventDefault?: boolean } = {}): () => void {
    this.ensureStarted();
    // Одна клавиша — один обработчик: попап не мешает назначить двум фичам одну
    // и ту же клавишу, и тогда вторая молча вытесняла первую. Хотя бы фиксируем.
    if (this.bindings.has(code)) log.warn("keyboard", "hotkey collision, rebinding", code);
    this.bindings.set(code, { code, handler, preventDefault: opts.preventDefault ?? false });
    return () => {
      if (this.bindings.get(code)?.handler === handler) this.bindings.delete(code);
    };
  }
}

export const keyboard = new KeyboardRouter();

/** Чисто модификаторные клавиши — не годятся как самостоятельный хоткей. */
export function isModifierCode(code: string): boolean {
  return /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/.test(code);
}

/** Человекочитаемая подпись для KeyboardEvent.code (для UI настроек). */
export function formatKeyCode(code: string): string {
  if (!code) return "—";
  if (code.startsWith("Key")) return code.slice(3); // KeyP → P
  if (code.startsWith("Digit")) return code.slice(5); // Digit5 → 5
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  if (code.startsWith("Arrow")) return code.slice(5); // ArrowUp → Up
  const named: Record<string, string> = {
    Escape: "Esc",
    Space: "Space",
    Enter: "Enter",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Tab: "Tab",
  };
  return named[code] ?? code; // F1..F12 и прочее — как есть
}
