/**
 * Диагностический снимок состояния — раздел в экспорте лога (решение
 * владельца 26.08.2026 после обсуждения внешнего арх-ревью).
 *
 * Каждый разбор жалобы начинался с реконструкции: «а что вообще включено,
 * что в хранилище, жив ли OBS?». Снимок отвечает на это до первого вопроса.
 *
 * ПРИВАТНОСТЬ (инвариант аудита 01.08.2026 — лог уезжает в файл для
 * поддержки): в снимок НЕ кладутся тексты заметок, история чата и пароль
 * OBS. Хранилище описывается МЕТРИКАМИ (счётчики и размеры), не содержимым.
 */
import type { Settings } from "@shared/types";
import { NOTES_KEY } from "./notes-store";
import { safeEndpoint } from "@shared/safe-endpoint";

/** Настройки для снимка: секреты маскируются, остальное — как есть. */
export function formatSettings(settings: Settings): string[] {
  return Object.entries(settings)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (key === "obs_password") return `${key}: ${value ? "<задан>" : "<пуст>"}`;
      // В адресе OBS бывают логин/пароль/токены — в снимок только хост
      // (то же правило safeEndpoint, что в логе OBS; ревью 26.08.2026).
      if (key === "obs_host") return `${key}: ${safeEndpoint(String(value ?? ""))}`;
      return `${key}: ${JSON.stringify(value)}`;
    });
}

export interface StorageMetric {
  label: string;
  count: number;
  bytes: number;
}

/**
 * Метрики storage.local: размер по группам, содержимое не раскрывается.
 * Заметки — одной строкой «N шт, X КБ»; журнал — своей группой; прочие
 * pn_/obs_-ключи перечисляются поимённо (их значения — техфлаги, не тексты).
 */
export function storageMetrics(all: Record<string, unknown>): StorageMetric[] {
  const size = (v: unknown): number => {
    try {
      return JSON.stringify(v)?.length ?? 0;
    } catch {
      return 0;
    }
  };
  const out: StorageMetric[] = [];
  let logCount = 0;
  let logBytes = 0;
  const rest: StorageMetric[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key === NOTES_KEY) {
      const notes = value && typeof value === "object" ? Object.keys(value).length : 0;
      out.push({ label: `заметки (${NOTES_KEY})`, count: notes, bytes: size(value) });
      continue;
    }
    if (key.startsWith("polemica:logs:")) {
      logCount++;
      logBytes += size(value);
      continue;
    }
    rest.push({ label: key, count: 1, bytes: size(value) });
  }
  if (logCount > 0) out.push({ label: "журнал (буферы)", count: logCount, bytes: logBytes });
  rest.sort((a, b) => b.bytes - a.bytes);
  return [...out, ...rest];
}

export function formatMetrics(metrics: StorageMetric[]): string[] {
  return metrics.map(
    (m) => `${m.label}: ${m.count} шт, ${(m.bytes / 1024).toFixed(1)} КБ`,
  );
}

/** Раздел снимка с заголовком; секции падают поодиночке, не всем снимком. */
export function section(title: string, lines: string[]): string {
  return [`── ${title} ──`, ...(lines.length ? lines : ["<пусто>"])].join("\n");
}
