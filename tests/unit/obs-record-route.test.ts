// @vitest-environment jsdom
/**
 * Автозапись: маршрут → команды фону. Стражи: выключенная фича молчит,
 * повторная сверка того же состояния не дублирует команды, включение
 * посреди игры стартует запись, выключение — останавливает СВОЮ.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const sent = vi.hoisted(() => ({ commands: [] as string[] }));

vi.mock("@core/messaging", () => ({
  sendRuntime: vi.fn(async (msg: { command: string }) => {
    sent.commands.push(msg.command);
    return { success: true, data: { started: true } };
  }),
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));

import { obsRecordFeature, syncObsRecordRoute } from "@content/features/obs-record";
import type { FeatureContext } from "@core/feature";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  obsRecordFeature.disable();
  syncObsRecordRoute(false);
  sent.commands.length = 0;
});

describe("автозапись по маршруту", () => {
  test("вход в комнату — start, выход — stop; повторы не дублируются", async () => {
    obsRecordFeature.enable({ settings: {} } as unknown as FeatureContext);
    syncObsRecordRoute(true);
    syncObsRecordRoute(true); // сверка того же состояния (роутер зовёт часто)
    await flush();
    expect(sent.commands).toEqual(["record_start"]);
    syncObsRecordRoute(false);
    syncObsRecordRoute(false);
    await flush();
    expect(sent.commands).toEqual(["record_start", "record_stop"]);
  });

  test("фича выключена — маршрут не рождает команд", async () => {
    syncObsRecordRoute(true);
    syncObsRecordRoute(false);
    await flush();
    expect(sent.commands).toEqual([]);
  });

  test("включили настройку уже сидя в комнате — запись стартует сразу", async () => {
    syncObsRecordRoute(true); // в комнате, фича ещё выключена
    obsRecordFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    expect(sent.commands).toEqual(["record_start"]);
  });

  test("выключение фичи в комнате останавливает запись (симметрия)", async () => {
    obsRecordFeature.enable({ settings: {} } as unknown as FeatureContext);
    syncObsRecordRoute(true);
    await flush();
    obsRecordFeature.disable();
    await flush();
    expect(sent.commands).toEqual(["record_start", "record_stop"]);
  });
});
