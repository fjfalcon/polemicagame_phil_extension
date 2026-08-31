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

  test("находка A: право лечить не зависит от латча — желаемое выводится из фазы", () => {
    // Прежняя схема гейтила heal на истинность латча; любой путь неудачи
    // гасил латч навсегда при бюджете ретраев ~1,25 с — F5/SPA-возврат
    // оставляли роль в эфире до смены фазы.
    const start = source.indexOf("function healRolePin");
    expect(start, "healRolePin существует").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("function scheduleRoleVisibility", start));
    expect(body).toMatch(/desiredRoleVisibility\(\)/);
    expect(body, "без целей heal молчит — ретраи в пустоту сжигали бюджет").toMatch(
      /getRoleVisibilityTargets\(\)\.length === 0/,
    );
    // Точная форма гейта: мутация «!want || !латч» проходила мимо прежнего
    // негативного регэкспа (ловил только «латч &&»).
    expect(body, "гейт — ровно отсутствие желаемого, латч не участвует").toMatch(
      /if \(!want\) return;/,
    );
    expect(body).not.toMatch(/if \(!want \|\|/);
  });

  test("находка A: heal зовут обе линии — подписчик и страховочный опрос", () => {
    // C точкой с запятой: голый /healRolePin\(\)/ матчил и ОПРЕДЕЛЕНИЕ
    // функции — снятый вызов подписчика проходил зелёным (поймано мутацией).
    const calls = source.match(/healRolePin\(\);/g) ?? [];
    expect(calls.length, "подписчик (roleNodeAdded) + 2с-интервал").toBeGreaterThanOrEqual(2);
  });

  test("находка C: ранний break не съедает roleNodeAdded", () => {
    const start = source.indexOf("unsubDom = onDomChange((mutations) => {");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("if (shouldCheckTime) requestTimeOfDayCheck", start));
    expect(body, "выход из цикла только когда найдено ОБА").toMatch(
      /if \(shouldCheckTime && roleNodeAdded\) break;/,
    );
  });

  test("№2: persisted-латч НЕ доверяется до применения", () => {
    const start = source.indexOf("currentTimeOfDay = stored.currentTimeOfDay;");
    expect(start, "якорь restore-пути жив").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("const applied = applyRoleVisibility", start));
    expect(body, "латч обнуляется: он описывает мёртвый DOM прошлой загрузки").toMatch(
      /lastAppliedRoleVisibility = null/,
    );
    expect(body).not.toMatch(/stored\.lastAppliedRoleVisibility/);
  });

  test("находка E: мёртвое persisted-поле латча больше не пишется", () => {
    const start = source.indexOf("const state: AutoSceneState = {");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("};", start));
    expect(body, "restore игнорирует — запись была бы приманкой").not.toMatch(
      /lastAppliedRoleVisibility,/,
    );
  });

  test("teardown отдаёт пины владельцу-модулю", () => {
    const start = source.indexOf("function restoreRoleVisibility");
    const body = source.slice(start, source.indexOf("}", start) + 1);
    expect(body).toMatch(/releasePins\(\)/);
  });
});

describe("смена сцены только по живому распознанию (жалоба 31.08.2026)", () => {
  test("детектор помечает каждый вызов: маркеры или фолбэк", () => {
    const i = source.indexOf("const result = detectTimeOfDayInner();");
    expect(i).toBeGreaterThan(-1);
    expect(source.slice(i, i + 200)).toMatch(/lastDetectWasLive = !phaseUnknownHit;/);
  });

  test("фолбэчный результат не трогает машину смены: ни взвод, ни подтверждение, ни отмена", () => {
    // На входе в комнату фолбэк «не понял → день» подтверждался как
    // null → day: прегейм-сцена стримера сменялась «Днём» на экране
    // ожидания, нулевая ночь шла в эфире на дневной сцене (63 с по логу).
    // Якорные проверки ОБОИХ гейтов по месту — счёт вхождений обходился
    // копией строки-приманки в чужой функции (adversarial, Н3).
    const evalStart = source.indexOf("function evaluateTimeOfDay");
    expect(evalStart).toBeGreaterThan(-1);
    const gateIdx = source.indexOf("if (!lastDetectWasLive) return;", evalStart);
    const equalIdx = source.indexOf("if (newTimeOfDay === previousTimeOfDay)", evalStart);
    const armIdx = source.indexOf("pendingTimeOfDay = newTimeOfDay;", evalStart);
    expect(gateIdx, "гейт существует в evaluateTimeOfDay").toBeGreaterThan(-1);
    // Гейт стоит ДО ветки «не изменилось»: фолбэчный тик не должен и ГАСИТЬ
    // живо взведённый pending (Н5), не только взводить.
    expect(gateIdx).toBeLessThan(equalIdx);
    expect(gateIdx).toBeLessThan(armIdx);
    // Второй гейт — в окне подтверждения, между повторным детектом и логом.
    const confirmDetect = source.indexOf("const confirmedTimeOfDay = detectTimeOfDay();");
    const confirmLog = source.indexOf("фаза подтверждена", confirmDetect);
    expect(confirmDetect).toBeGreaterThan(-1);
    const confirmGate = source.indexOf("if (!lastDetectWasLive) return;", confirmDetect);
    expect(confirmGate, "гейт подтверждения на месте").toBeGreaterThan(-1);
    expect(confirmGate).toBeLessThan(confirmLog);
  });

  test("Н3: lastDetectWasLive присваивается ровно в двух местах — объявление и деривация", () => {
    // Третье присваивание (например, «= true» перед гейтом) — обход гейта.
    const writes = source.match(/lastDetectWasLive = /g) ?? [];
    expect(writes.length).toBe(2);
  });

  test("Н1: каждая фолбэчная ветка детектора помечена phaseUnknownHit", () => {
    // «Изолированная Ночь» возвращала currentTimeOfDay || \"day\" БЕЗ метки —
    // «остаёмся в текущем» считалось живым и проходило гейт (Н1).
    const marks = source.match(/phaseUnknownHit = true;/g) ?? [];
    expect(marks.length, "изолированная ночь + финальный фолбэк + catch").toBeGreaterThanOrEqual(3);
    const iso = source.indexOf('Found isolated "Ночь"');
    expect(iso).toBeGreaterThan(-1);
    const isoBranch = source.slice(source.lastIndexOf("if (", iso - 200), iso);
    expect(isoBranch + source.slice(iso, iso + 50)).toContain("phaseUnknownHit");
  });

  test("Н2: до первого живого распознания роль запинена fail-safe hidden", () => {
    const start = source.indexOf("function desiredRoleVisibility");
    const body = source.slice(start, source.indexOf("function healRolePin", start));
    expect(body, "фаза null при автомоде — прятать").toMatch(
      /if \(!currentTimeOfDay\) return "hidden";/,
    );
  });

  test("Н4: уход из комнаты обнуляет persisted-состояние автосцены", () => {
    const start = source.indexOf("function resetNightOnLeave");
    const body = source.slice(start, source.indexOf("/** Автоматически переключает", start));
    expect(body, "persisted-ночь умирает вместе с уходом").toMatch(
      /clearPersistedAutoState\(false\)/,
    );
  });
});
