// @vitest-environment jsdom
/**
 * История чата поверх перезагрузки (просьба владельца 26.08.2026: «при
 * перезагрузке страницы история стирается»).
 *
 * Парсер восстановления читает sessionStorage СТРАНИЦЫ — источник
 * недоверенный (карта хранилища AGENTS.md §5): цвет уходит в inline-style,
 * бейджи в HTML, поэтому каждое поле пересанитизируется. Битая запись
 * отбрасывается целиком — мутант «почини и пропусти» обязан умирать.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("@core/dom", () => ({ onDomChange: vi.fn(), safeClick: vi.fn(), isVisible: () => true }));
vi.mock("@core/env", () => ({
  browser: { storage: { local: { get: vi.fn(), set: vi.fn() }, sync: { set: vi.fn() } }, runtime: { id: "x" } },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({ onMessage: vi.fn(), sendRuntime: vi.fn() }));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));

import {
  HISTORY_MSG_MAX,
  parseChatHistory,
  serializeChatHistory,
} from "@content/panels/twitch-panel";

type Msg = Parameters<typeof serializeChatHistory>[1][number];

// Метка «минуту назад», не абсолютная: парсер отвергает будущее (+60с), и
// зашитая дата делала сюиту зависимой от часов раннера (adversarial, тест-мина).
const recent = () => new Date(Date.now() - 60_000);
const chat = (over: Partial<Msg> = {}): Msg => ({
  username: "viewer",
  message: "привет",
  timestamp: recent(),
  type: "chat",
  ...over,
});

describe("круговорот сериализация → парсинг", () => {
  test("чат-сообщения переживают перезагрузку с полями и порядком", () => {
    const raw = serializeChatHistory("ch", [
      chat({ username: "a", message: "первое", color: "#FF4500", badges: ["🛡"] }),
      chat({ username: "b", message: "второе", mention: true }),
    ]);
    const out = parseChatHistory(raw, "ch");
    expect(out.map((m) => [m.username, m.message])).toEqual([
      ["a", "первое"],
      ["b", "второе"],
    ]);
    expect(out[0].color).toBe("#FF4500");
    expect(out[0].badges).toEqual(["🛡"]);
    expect(out[1].mention).toBe(true);
    expect(Math.abs(out[0].timestamp.getTime() - recent().getTime())).toBeLessThan(5000);
  });

  test("системные строки не сохраняются: после F5 «Подключились» было бы враньём", () => {
    const raw = serializeChatHistory("ch", [
      { message: "Подключились к чату", timestamp: new Date(), type: "system" },
      chat(),
    ]);
    expect(parseChatHistory(raw, "ch")).toHaveLength(1);
  });

  test("буфер режется до 200 последних", () => {
    const many = Array.from({ length: 250 }, (_, i) => chat({ message: `m${i}` }));
    const out = parseChatHistory(serializeChatHistory("ch", many), "ch");
    expect(out).toHaveLength(200);
    expect(out[0].message).toBe("m50");
  });
});

describe("недоверенный sessionStorage", () => {
  test("чужой канал не подмешивается", () => {
    const raw = serializeChatHistory("old_channel", [chat()]);
    expect(parseChatHistory(raw, "new_channel")).toEqual([]);
  });

  test("мусор на верхнем уровне — пусто, а не исключение", () => {
    for (const raw of [null, "", "не json", "[]", "42", '"str"', JSON.stringify({ channel: "ch" })]) {
      expect(parseChatHistory(raw, "ch")).toEqual([]);
    }
  });

  test("гигантский raw отбрасывается до JSON.parse", () => {
    const raw = `{"channel":"ch","messages":[]}${" ".repeat(500_000)}`;
    expect(parseChatHistory(raw, "ch")).toEqual([]);
  });

  test("цвет — строго #rrggbb: инъекция в inline-style не проходит", () => {
    const hostile = JSON.stringify({
      channel: "ch",
      messages: [
        { username: "x", message: "m", timestamp: 1000, color: "red;background:url(evil)" },
        { username: "y", message: "m", timestamp: 1000, color: "#12345Z" },
      ],
    });
    const out = parseChatHistory(hostile, "ch");
    expect(out).toHaveLength(2);
    expect(out[0].color).toBeUndefined();
    expect(out[1].color).toBeUndefined();
  });

  test("бейджи — только из нашего словаря, чужой HTML не пролезает", () => {
    const hostile = JSON.stringify({
      channel: "ch",
      messages: [
        { username: "x", message: "m", timestamp: 1000, badges: ["<img onerror=1>", "🛡", 5, "💎"] },
      ],
    });
    expect(parseChatHistory(hostile, "ch")[0].badges).toEqual(["🛡", "💎"]);
  });

  test("битая запись выбрасывается целиком, соседние живут", () => {
    const now = Date.now();
    const hostile = JSON.stringify({
      channel: "ch",
      messages: [
        { username: "ok1", message: "m", timestamp: now },
        { username: 7, message: "m", timestamp: now }, // ник не строка
        { username: "x", message: 7, timestamp: now }, // текст не строка
        { username: "x", message: "m", timestamp: "now" }, // метка не число
        { username: "x", message: "m", timestamp: now + 3_600_000 }, // из будущего
        { username: "x", message: "m", timestamp: -5 }, // доисторическая
        { username: "x", message: "m".repeat(HISTORY_MSG_MAX + 1), timestamp: now }, // сверхдлинное
        null,
        "строка",
        { username: "ok2", message: "m", timestamp: now },
      ],
    });
    expect(parseChatHistory(hostile, "ch").map((m) => m.username)).toEqual(["ok1", "ok2"]);
  });

  test("mention — только честный true", () => {
    const raw = JSON.stringify({
      channel: "ch",
      messages: [{ username: "x", message: "m", timestamp: 1000, mention: "true" }],
    });
    expect(parseChatHistory(raw, "ch")[0].mention).toBe(false);
  });

  test("пустое имя канала — ничего не восстанавливаем", () => {
    expect(parseChatHistory(serializeChatHistory("", [chat()]), "")).toEqual([]);
  });

  test("симметрия размеров: спам ctrl-символами не раздувает сохранённое за потолок чтения", () => {
    // JSON экранирует ctrl-байты ×6: 200 сообщений по 600 таких символов
    // раньше писались (~740 КБ), а чтение отказывало целиком (находка №1).
    const spam = Array.from({ length: 200 }, (_, i) =>
      chat({ message: "\u0002".repeat(600) + `хвост${i}` }),
    );
    const raw = serializeChatHistory("ch", spam);
    expect(raw.length).toBeLessThanOrEqual(400_000);
    const out = parseChatHistory(raw, "ch");
    expect(out.length, "что сохранили — то и восстановили").toBeGreaterThan(0);
    expect(out[out.length - 1].message).toContain("хвост199");
    expect(out[0].message, "ctrl-байты выброшены при записи").not.toContain("\u0002");
  });

  test("бейджи дедуплицируются, как в живом IRC-пути", () => {
    const raw = JSON.stringify({
      channel: "ch",
      messages: [{ username: "x", message: "m", timestamp: 1000, badges: ["★", "★", "★", "🛡"] }],
    });
    expect(parseChatHistory(raw, "ch")[0].badges).toEqual(["★", "🛡"]);
  });

  test("пустой и пробельный ник бракуют запись: живой путь таких не рождает", () => {
    const raw = JSON.stringify({
      channel: "ch",
      messages: [
        { username: "", message: "m", timestamp: 1000 },
        { username: "   ", message: "m", timestamp: 1000 },
        { username: "ok", message: "m", timestamp: 1000 },
      ],
    });
    expect(parseChatHistory(raw, "ch").map((m) => m.username)).toEqual(["ok"]);
  });
});
