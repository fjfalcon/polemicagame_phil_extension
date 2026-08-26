/**
 * Фича: автозапись игр в OBS (стримерский пакет, просьба владельца
 * 26.08.2026).
 *
 * Вошёл в игровую комнату — запись пошла; ушёл из комнаты — остановилась.
 * Каждая игра — отдельный файл, без ручного «ой, забыл включить запись».
 *
 * Границы аккуратности (запись — ЧУЖОЙ ресурс стримера):
 *  • если запись уже шла (стример пишет сам) — не присваиваем и не трогаем:
 *    фон помечает «нашу» запись флагом в storage.local и останавливает
 *    только её;
 *  • вторая вкладка с комнатой держит запись живой (страж в фоне);
 *  • фича выключена по умолчанию — включает сам стример.
 *
 * Маршрут сообщает URL-роутер (syncObsRecordRoute) — тот же источник правды,
 * что у остальных route-фич. F5 посреди игры безопасен: record_start при
 * уже идущей записи отвечает {already} и ничего не делает.
 */
import { log } from "@core/log";
import { sendRuntime } from "@core/messaging";
import { showToast } from "@core/toast";
import type { Feature } from "@core/feature";

const SCOPE = "obs-record";

let enabled = false;
let inRoom = false;

async function command(cmd: "record_start" | "record_stop"): Promise<void> {
  const res = await sendRuntime<{ success?: boolean; data?: Record<string, unknown>; error?: string }>(
    { type: "obs_command", command: cmd },
  );
  if (!res?.success) {
    // Типовая причина — OBS не подключён; для стримера это тихий no-op,
    // тост на каждом входе в комнату был бы наказанием за выключенный OBS.
    log.info(SCOPE, cmd, "не выполнена:", res?.error ?? "нет ответа фона");
    return;
  }
  const d = res.data ?? {};
  if (cmd === "record_start") {
    if (d.started) {
      log.info(SCOPE, "запись начата (вход в комнату)");
      showToast("● Запись игры включена");
    } else if (d.already) {
      log.info(SCOPE, "запись уже шла — не присваиваем (пишет сам стример)");
    }
  } else {
    if (d.stopped) {
      log.info(SCOPE, "запись остановлена (выход из комнаты)", d.path ?? "");
      showToast("■ Запись игры сохранена");
    } else if (d.ignored) {
      log.info(SCOPE, "остановка записи пропущена:", String(d.ignored));
    }
  }
}

/** Маршрут от URL-роутера: в игровой комнате или нет. */
export function syncObsRecordRoute(nowInRoom: boolean): void {
  if (nowInRoom === inRoom) return;
  inRoom = nowInRoom;
  if (!enabled) return;
  void command(nowInRoom ? "record_start" : "record_stop");
}

export const obsRecordFeature: Feature = {
  id: "obs-record",
  settingKey: "obs_auto_record_enabled",

  enable() {
    enabled = true;
    // Включили настройку уже сидя в комнате — стартуем не дожидаясь перехода.
    if (inRoom) void command("record_start");
  },

  disable() {
    // Симметрия: выключение фичи в комнате останавливает НАШУ запись (чужую
    // фон и так не тронет).
    if (enabled && inRoom) void command("record_stop");
    enabled = false;
  },
};
