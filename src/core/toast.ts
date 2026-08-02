/**
 * Короткое сообщение поверх страницы игры.
 *
 * Зачем: часть отказов расширения человек не может заметить в принципе —
 * квадрат метки покрасился, но не сохранился; хоткей нажат, но роль не
 * подменилась. Лог для поддержки такие случаи теперь фиксирует, но игроку в
 * этот момент нужно сказать вслух (аудит наблюдаемости 02.08.2026, раздел
 * «Ответ пользователю»).
 *
 * Правила:
 *  - показываем отказы и действия, которые расширение делает ЗА игрока
 *    (например, автовозврат в поиск); обычные успехи сюда добавлять нельзя —
 *    тост поверх игры мешает;
 *  - одинаковые сообщения не дублируются (dedupe по ключу);
 *  - плашка не перехватывает клики (pointer-events: none);
 *  - узел свой, вставляется в body и снимается по таймеру — сайт мы не трогаем.
 */

const TOAST_CLASS = "pn-toast";
/** Одно и то же сообщение не повторяем чаще, чем раз в это время. */
const DEDUPE_MS = 30_000;

const lastShownAt = new Map<string, number>();
let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container?.isConnected) return container;
  const el = document.createElement("div");
  el.className = `${TOAST_CLASS}-wrap`;
  el.style.cssText = `
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483600;
    display: flex; flex-direction: column; gap: 8px; pointer-events: none;
  `;
  document.body.appendChild(el);
  container = el;
  return el;
}

export interface ToastOptions {
  /** Ключ для подавления повторов; по умолчанию — сам текст. */
  key?: string;
  /** Сколько держать на экране. */
  durationMs?: number;
  kind?: "info" | "warn";
}

/** Показать сообщение игроку. Возвращает false, если повтор подавлен. */
export function showToast(text: string, options: ToastOptions = {}): boolean {
  const key = options.key ?? text;
  const now = Date.now();
  const last = lastShownAt.get(key) ?? 0;
  if (now - last < DEDUPE_MS) return false;
  lastShownAt.set(key, now);

  try {
    const el = document.createElement("div");
    el.className = TOAST_CLASS;
    el.textContent = text;
    el.style.cssText = `
      background: ${options.kind === "warn" ? "#3a2230" : "#161c2c"};
      color: #e6e9f0; border: 1px solid rgba(255,255,255,.15);
      border-radius: 10px; padding: 10px 14px; max-width: 320px;
      font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.45);
      /* Кликать в тосте нечего, а справа снизу в комнате живут игровые
         контролы (микрофон/камера/настройки) — плашка не имеет права
         перехватывать по ним клики на 5-8 секунд (ревью 02.08.2026). */
      pointer-events: none;
    `;
    ensureContainer().appendChild(el);
    setTimeout(() => el.remove(), options.durationMs ?? 5000);
    return true;
  } catch {
    // Страница могла уйти из-под нас — сообщение не критично.
    return false;
  }
}

/** Снять всё и забыть историю (вызывать в disable фич). */
export function clearToasts(): void {
  container?.remove();
  container = null;
  lastShownAt.clear();
}
