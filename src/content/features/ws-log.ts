/**
 * Фича: «Полный лог общения с сервером».
 *
 * Просьба владельца 09.08.2026 — после того, как разбор одной-единственной
 * паузы трижды упёрся в догадки о протоколе. Каждый заход стоил ему
 * отдельной игры, а закрывал вопрос ровно один ответ: как выглядит кадр.
 *
 * Устройство: кадры видит зонд в мире страницы (у изолированного мира свой
 * WebSocket), сюда они приезжают через postMessage и ложатся в отдельное
 * хранилище (core/ws-log) — не в обычный журнал, который они бы утопили.
 *
 * Настройка ВЫКЛЮЧЕНА по умолчанию и это принципиально: в кадрах комнаты
 * едут роли, ночные ходы и чат. Включает человек, осознанно и на время
 * разбора; медиа и ключи сессии не попадают в файл никогда (см. core/ws-log).
 */
import { log } from "@core/log";
import { finishSession, flushNow, record, size, startSession } from "@core/ws-log";
import type { Feature, FeatureContext } from "@core/feature";

const SCOPE = "ws-log";

/** Команда зонду: включить/выключить пересылку кадров. */
export const LOG_CMD_SOURCE = "pn-ws-log-cmd";
/** Источник сообщений зонда (тот же, что у подписи инициатора паузы). */
export const PROBE_SOURCE = "pn-room-probe";

let listener: ((e: MessageEvent) => void) | null = null;
let onHide: (() => void) | null = null;
/** Сколько кадров отброшено как чужие (медиа) — видно в логе при выключении. */
let skipped = 0;

/** Сказать зонду, писать кадры или нет. */
export function commandProbe(on: boolean): void {
  try {
    window.postMessage({ source: LOG_CMD_SOURCE, on }, location.origin);
  } catch {
    /* страница уходит */
  }
}

/** Обработка сообщения зонда. Экспорт — тестовый шов. */
export function onProbeMessage(e: MessageEvent): void {
  if (e.source !== window) return;
  const data = e.data as { source?: string; frame?: { dir?: unknown; raw?: unknown } };
  if (data?.source !== PROBE_SOURCE || !data.frame) return;
  const dir = data.frame.dir === "out" ? "out" : "in";
  if (!record(dir, data.frame.raw)) skipped++;
}

export const wsLogFeature: Feature = {
  id: "ws-log",
  settingKey: "ws_full_log_enabled",

  enable(_ctx: FeatureContext) {
    skipped = 0;
    // Прибрать ЧУЖИЕ куски до первой записи: ключи именуются по сессии
    // страницы, и без этого каждый заход копил свои, а старые не удалял никто
    // — хранилище переполнялось, и вместе с ним переставали сохраняться
    // заметки (жалоба 10.08.2026).
    // Уборка чужого с ПОЛОВИННЫМ бюджетом + учёт остатка в общем потолке
    // (PERF26-4): полный бюджет с выброшенным результатом позволял двум
    // потолкам сложиться в квоте, общей с заметками.
    void startSession();
    listener = (e: MessageEvent) => onProbeMessage(e);
    window.addEventListener("message", listener);
    commandProbe(true);
    // Сброс на уходе со страницы: F5 посреди игры не должен стирать
    // собранное — ровно ради этого кадры вообще уезжают в storage.
    onHide = () => void flushNow();
    window.addEventListener("pagehide", onHide);
    log.info(SCOPE, "полный лог кадров ВКЛЮЧЁН (медиа и ключи сессии в него не пишутся)");
  },

  disable() {
    commandProbe(false);
    if (listener) {
      window.removeEventListener("message", listener);
      listener = null;
    }
    if (onHide) {
      window.removeEventListener("pagehide", onHide);
      onHide = null;
    }
    // Собранное НЕ стираем: человек выключает лог после разбора, а скачать
    // файл хочет уже потом. Для стирания есть отдельная кнопка в попапе.
    log.info(SCOPE, `полный лог кадров выключен (в памяти ${size()}, пропущено медиа: ${skipped})`);
    // Хвост ДОЖИДАЕТСЯ записи до закрытия поколения: прежний порядок терял
    // последние секунды — ровно те, ради которых лог включали (adversarial
    // 26.08.2026, HIGH-1).
    void finishSession();
  },
};
