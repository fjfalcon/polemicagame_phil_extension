/**
 * Глобальный перехват ошибок → в логгер (буфер + storage.local).
 * Ставится в каждом контексте (content/background/popup): ошибки, которые раньше
 * улетали в консоль и терялись, теперь попадают в выгружаемые логи.
 */
import { log } from "./log";

export function installErrorCapture(scope: string): void {
  const g = globalThis as unknown as {
    addEventListener?: (type: string, cb: (e: any) => void) => void;
  };
  g.addEventListener?.("error", (e: any) => {
    const where = e?.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : "";
    log.error(`${scope}:error`, (e?.message || String(e)) + where);
  });
  g.addEventListener?.("unhandledrejection", (e: any) => {
    const r = e?.reason;
    log.error(`${scope}:unhandled`, r instanceof Error ? r.stack || r.message : String(r));
  });
}
