import { describe, expect, test } from "vitest";

import {
  PENDING_HARD_CAP_MS,
  PENDING_TTL_MS,
  parseMark,
  refreshMark,
  serializeMark,
  validateMark,
} from "@content/features/requeue-pending";

/**
 * Метка моста живёт в sessionStorage САЙТА — недоверенном хранилище. Каждое
 * правило здесь оплачено конкретной дырой: скользящий TTL — серверными
 * длительностями без верхней границы (аудит 03.08.2026, RQ-4), запрет метки
 * из будущего — трюком «вечно свежего» значения (аудит безопасности 01.08,
 * №15), потолок эпизода — тем, что освежением можно накрутить вечную жизнь.
 */
const NOW = 1_800_000_000_000;

describe("validateMark: границы свежести", () => {
  const mark = (issuedAt: number, refreshedAt: number) =>
    JSON.stringify({ issuedAt, refreshedAt });

  test("свежая метка проходит", () => {
    const verdict = validateMark(mark(NOW - 1000, NOW - 1000), NOW);
    expect(verdict).toEqual({ ok: true, mark: { issuedAt: NOW - 1000, refreshedAt: NOW - 1000 } });
  });

  test("граница TTL: 44 999 мс от освежения — ещё жива", () => {
    expect(validateMark(mark(NOW - 50_000, NOW - (PENDING_TTL_MS - 1)), NOW)?.ok).toBe(true);
  });

  test("граница TTL: 45 001 мс от освежения — протухла", () => {
    const verdict = validateMark(mark(NOW - 50_000, NOW - (PENDING_TTL_MS + 1)), NOW);
    expect(verdict).toEqual({ ok: false, reason: "expired" });
  });

  test("TTL скользит от refreshedAt, а НЕ от issuedAt", () => {
    // Ядро RQ-4: эпизод старше 45 с, но условие живо и освежалось — метка
    // обязана работать. Проверка от issuedAt вернула бы старую поломку.
    const verdict = validateMark(mark(NOW - 120_000, NOW - 5_000), NOW);
    expect(verdict?.ok).toBe(true);
  });

  test("потолок эпизода: свежее освежение НЕ спасает метку старше hard cap", () => {
    const verdict = validateMark(mark(NOW - PENDING_HARD_CAP_MS - 1, NOW - 1000), NOW);
    expect(verdict).toEqual({ ok: false, reason: "capped" });
  });

  test("метка из будущего отвергается", () => {
    expect(validateMark(mark(NOW + 60_000, NOW + 60_000), NOW)).toEqual({
      ok: false,
      reason: "future",
    });
    // Достаточно ОДНОГО поля из будущего.
    expect(validateMark(mark(NOW - 1000, NOW + 60_000), NOW)).toEqual({
      ok: false,
      reason: "future",
    });
  });

  test("перепутанные issuedAt/refreshedAt — порча, не эпизод", () => {
    // Освежение не может опережать выпуск; такое значение мы не писали.
    expect(validateMark(mark(NOW - 1000, NOW - 2000), NOW)).toEqual({
      ok: false,
      reason: "corrupt",
    });
  });

  test.each([
    ["мусор", "{oops"],
    ["массив", "[1,2]"],
    ["NaN в поле", '{"issuedAt":null,"refreshedAt":1}'],
    ["строка в поле", '{"issuedAt":"1","refreshedAt":1}'],
    ["Infinity через строку", '{"issuedAt":1e999,"refreshedAt":1}'],
    ["нет поля", '{"issuedAt":1}'],
  ])("порча: %s", (_name, raw) => {
    expect(validateMark(raw, NOW)).toEqual({ ok: false, reason: "corrupt" });
  });

  test("отсутствие метки — не эпизод: null без причины", () => {
    // RQ-8: «missing» на каждом тике — не событие и не строка лога.
    expect(validateMark(null, NOW)).toBeNull();
    expect(validateMark("", NOW)).toBeNull();
  });

  test("наследие 9.2.x: голое число принимается как issuedAt=refreshedAt", () => {
    // sessionStorage переживает reload: сразу после обновления расширения в
    // живой вкладке может лежать метка старого формата.
    const verdict = validateMark(String(NOW - 1000), NOW);
    expect(verdict).toEqual({
      ok: true,
      mark: { issuedAt: NOW - 1000, refreshedAt: NOW - 1000 },
    });
  });
});

describe("refreshMark: эпизод и освежение", () => {
  test("освежение сохраняет issuedAt и двигает refreshedAt", () => {
    const first = refreshMark(null, NOW - 60_000);
    const later = refreshMark(first, NOW);
    expect(later).toEqual({ issuedAt: NOW - 60_000, refreshedAt: NOW });
  });

  test("issuedAt из будущего не наследуется — эпизод начинается заново", () => {
    // Иначе подделанный issuedAt отравил бы hard cap до конца сессии.
    const later = refreshMark({ issuedAt: NOW + 999, refreshedAt: NOW + 999 }, NOW);
    expect(later).toEqual({ issuedAt: NOW, refreshedAt: NOW });
  });

  test("serialize → parse — без потерь", () => {
    const mark = { issuedAt: NOW - 5, refreshedAt: NOW };
    expect(parseMark(serializeMark(mark))).toEqual(mark);
  });
});
