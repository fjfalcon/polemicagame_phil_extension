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

class KeyboardRouter {
  private bindings = new Map<string, Binding>();
  private started = false;

  private onKeyDown = (e: KeyboardEvent) => {
    const b = this.bindings.get(e.code);
    if (!b) return;
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
    this.started = true;
  }

  /**
   * Зарегистрировать хоткей по физической клавише (event.code, напр. "KeyF", "F8").
   * Возвращает функцию отписки.
   */
  register(code: string, handler: HotkeyHandler, opts: { preventDefault?: boolean } = {}): () => void {
    this.ensureStarted();
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
