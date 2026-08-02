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
