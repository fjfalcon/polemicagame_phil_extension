/**
 * Глобальный перехват ошибок → в логгер (буфер + storage.local).
 * Ставится в каждом контексте (content/background/popup): ошибки, которые раньше
 * улетали в консоль и терялись, теперь попадают в выгружаемые логи.
 */
import { log } from "./log";

/**
 * error-события НЕ изолированы по мирам: в content-скрипт прилетают и
 * uncaught-ошибки самого сайта. Без фильтра они забивали наш буфер (600
 * записей), вытесняя собственную диагностику, а зацикленная ошибка сайта
 * давала непрерывную срочную запись в storage. Наши ошибки отличаем по
 * filename с extension-схемой; без filename («Script error.») — чужие.
 * unhandledrejection изолирован per-realm — там фильтр не нужен.
 */
function isOwnError(e: { filename?: string }): boolean {
  const f = e?.filename || "";
  return f.includes("-extension://");
}

/** Не чаще одной записи в секунду — защита от зацикленной ошибки. */
let lastErrorLogAt = 0;

export function installErrorCapture(scope: string): void {
  const g = globalThis as unknown as {
    addEventListener?: (type: string, cb: (e: any) => void) => void;
  };
  const isContent = scope === "content";
  g.addEventListener?.("error", (e: any) => {
    if (isContent && !isOwnError(e)) return;
    const now = Date.now();
    if (now - lastErrorLogAt < 1000) return;
    lastErrorLogAt = now;
    const where = e?.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : "";
    log.error(`${scope}:error`, (e?.message || String(e)) + where);
  });
  g.addEventListener?.("unhandledrejection", (e: any) => {
    const now = Date.now();
    if (now - lastErrorLogAt < 1000) return;
    lastErrorLogAt = now;
    const r = e?.reason;
    log.error(`${scope}:unhandled`, r instanceof Error ? r.stack || r.message : String(r));
  });
}
