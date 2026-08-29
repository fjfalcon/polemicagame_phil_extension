import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(ROOT, "src/content/panels/obs-panel.ts"), "utf8");

/**
 * Скрытие роли перед дневной сценой — единственное место, где ошибка стоит не
 * «неудобно», а «роль игрока уехала в эфир». Проверяем именно то, что было
 * сломано: латч «скрыто» ставился БЕЗУСЛОВНО, поэтому retry-машина считала
 * работу сделанной и не пробовала снова, а сцена переключалась — в логе всё
 * выглядело успехом (аудит наблюдаемости 02.08.2026, OP-1).
 */
describe("OP-1: латч видимости роли", () => {
  const body = source.slice(
    source.indexOf("async function hideRoleBeforeDaySceneSwitch"),
    source.indexOf("// ─────────────────────────── определение времени суток"),
  );

  test("функция вообще найдена (иначе тест бессмысленен)", () => {
    expect(body.length).toBeGreaterThan(100);
  });

  test("латч «скрыто» не выставляется в обход фактического применения", () => {
    expect(
      body,
      "прямое присваивание latch'а возвращает баг: сцена уедет, роль останется",
    ).not.toMatch(/lastAppliedRoleVisibility\s*=\s*["']hidden["']/);
  });

  test("неудача скрытия объявляется и запускает повтор", () => {
    expect(body).toMatch(/log\.warn\(/);
    expect(body, "после неудачи обязан заводиться retry").toMatch(/scheduleRoleVisibility\(/);
  });

  test("исчерпание попыток заканчивается терминальной строкой", () => {
    const schedule = source.slice(
      source.indexOf("function scheduleRoleVisibility"),
      source.indexOf("async function hideRoleBeforeDaySceneSwitch"),
    );
    expect(schedule, "молчаливая остановка повторов неотличима от успеха").toMatch(
      /attempt < 5[\s\S]*?log\.warn\(/,
    );
  });
});

/**
 * Хвосты автомода после teardown (adversarial 29.08.2026, находки 1–2).
 * Обвязки на живом DOM у панели нет — сторожим по исходнику, как и латч:
 * это ловушка на неосторожную правку, а не доказательство поведения.
 */
describe("симметрия автомода: таймер видимости роли и включение", () => {
  const stopBody = source.slice(
    source.indexOf("function stopDOMMonitoring"),
    source.indexOf("// ─────────────────────────── видимость панели"),
  );
  const schedBody = source.slice(
    source.indexOf("function scheduleRoleVisibility"),
    source.indexOf("async function hideRoleBeforeDaySceneSwitch"),
  );

  test("teardown автомода гасит pendingRoleVisibilityTimer", () => {
    // Таймер взводится на 3 с (ночь) и жил дольше выключения автомода:
    // срабатывал ПОСЛЕ restoreRoleVisibility и заново пинил роль !important.
    expect(stopBody).toMatch(/clearTimeout\(pendingRoleVisibilityTimer\)/);
  });

  test("колбэк таймера видимости гейтится на autoModeEnabled", () => {
    expect(schedBody).toMatch(/if \(!autoModeEnabled\) return;/);
  });

  test("включение автомода восстанавливает видимость роли текущей фазы", () => {
    // teardown возвращает стили роли (restoreRoleVisibility) — значит enable
    // обязан применить их заново, иначе цикл выкл/вкл на дне оставлял роль
    // видимой на дневной сцене до следующей смены фазы.
    const start = source.indexOf("if (wasInitialized && currentTimeOfDay) {");
    const enableBody = source.slice(start, source.indexOf("requestTimeOfDayCheck();", start));
    expect(enableBody).toMatch(/scheduleRoleVisibility\(currentTimeOfDay\)/);
  });
});

describe("латч против живого узла (аудит скрытия ролей 29.08.2026, №1/№2)", () => {
  test("№1: ранний выход schedule сверяет латч с живым пином, не с памятью", () => {
    expect(source).toMatch(
      /lastAppliedRoleVisibility === targetVisibility && pinHolds\(targetVisibility\)/,
    );
  });

  test("№1: пересозданный узел лечится и подписчиком, и страховочным опросом", () => {
    const heals = source.match(/!pinHolds\(lastAppliedRoleVisibility\)/g) ?? [];
    expect(heals.length, "две линии самолечения пина").toBeGreaterThanOrEqual(2);
  });

  test("№2: persisted-латч НЕ доверяется до применения", () => {
    const start = source.indexOf("currentTimeOfDay = stored.currentTimeOfDay;");
    const body = source.slice(start, source.indexOf("const applied = applyRoleVisibility", start));
    expect(body, "латч обнуляется: он описывает мёртвый DOM прошлой загрузки").toMatch(
      /lastAppliedRoleVisibility = null/,
    );
    expect(body).not.toMatch(/stored\.lastAppliedRoleVisibility/);
  });

  test("teardown отдаёт пины владельцу-модулю", () => {
    const start = source.indexOf("function restoreRoleVisibility");
    const body = source.slice(start, source.indexOf("}", start) + 1);
    expect(body).toMatch(/releasePins\(\)/);
  });
});
