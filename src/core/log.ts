/**
 * Лёгкий логгер с уровнями. В проде по умолчанию молчит (кроме warn/error),
 * чтобы убрать сотни console.log из старого кода.
 * Уровень можно поднять в DevTools: localStorage.setItem('polemica:loglevel','debug')
 */
type Level = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

function resolveLevel(): Level {
  try {
    const v = (globalThis as any).localStorage?.getItem("polemica:loglevel") as Level | null;
    if (v && v in ORDER) return v;
  } catch {
    /* localStorage недоступен в service worker */
  }
  return "warn";
}

let current: Level = resolveLevel();

function emit(level: Exclude<Level, "silent">, scope: string, args: unknown[]) {
  if (ORDER[level] < ORDER[current]) return;
  const tag = `[polemica:${scope}]`;
  // eslint-disable-next-line no-console
  (console[level] ?? console.log)(tag, ...args);
}

export const log = {
  setLevel(l: Level) {
    current = l;
  },
  debug: (scope: string, ...a: unknown[]) => emit("debug", scope, a),
  info: (scope: string, ...a: unknown[]) => emit("info", scope, a),
  warn: (scope: string, ...a: unknown[]) => emit("warn", scope, a),
  error: (scope: string, ...a: unknown[]) => emit("error", scope, a),
};
