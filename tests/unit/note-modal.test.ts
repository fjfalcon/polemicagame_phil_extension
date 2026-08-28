// @vitest-environment jsdom
/**
 * Окно «Заметка об игроке».
 *
 * До сегрегации 28.08.2026 диалог жил внутри четырёхтысячестрочной фичи и не
 * проверялся НИЧЕМ: чтобы дойти до него в тесте, нужен был стол, кнопки и
 * ховер. Теперь это функция от порта — и её можно спросить напрямую про то,
 * что важно: не подставляется ли чужой ввод в разметку сайта, сохраняется ли
 * текст, честно ли ведёт себя отказ записи.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  loadResult: { notes: {} as Record<string, unknown>, customTags: [] as string[], loadFailed: false },
  saved: {} as Record<string, unknown>,
}));

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    },
    runtime: { id: "x" },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));
// Координатор в фоне отвечает успехом и отдаёт свежую карту — как в бою.
vi.mock("@core/messaging", () => ({
  sendRuntime: vi.fn(async (msg: { ops?: Array<{ key: string; record: unknown }> }) => {
    for (const op of msg.ops ?? []) {
      if (op.record === null) delete h.saved[op.key];
      else h.saved[op.key] = op.record;
    }
    return { ok: true, truncated: 0, skipped: 0, notes: h.saved };
  }),
}));
vi.mock("@core/notes-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@core/notes-store")>();
  return { ...real, loadNotes: vi.fn(async () => h.loadResult), saveNotes: vi.fn(async () => true) };
});

import { showNoteModal } from "@content/features/player-notes/note-modal";
import type { ModalPort } from "@content/features/player-notes/modal-port";
import { NotesModel } from "@content/features/player-notes/notes-model";
import type { NotesMap } from "@core/notes-store";

/**
 * Модель НАСТОЯЩАЯ (mock только у хранилища): диалог должен проверяться
 * против тех же правил записи, что работают у пользователя.
 */
function makePort(
  notes: NotesMap = {},
  over: Partial<ModalPort> = {},
): { port: ModalPort; model: NotesModel; toasts: string[] } {
  h.loadResult = { notes, customTags: [], loadFailed: false };
  const toasts: string[] = [];
  const model = new NotesModel({
    isActive: () => true,
    onColorsChanged: () => undefined,
    onIndicatorsChanged: () => undefined,
    onTagsChanged: () => undefined,
    onTooltipsChanged: () => undefined,
    onPlayerTooltips: () => undefined,
    toast: (m) => toasts.push(m),
    lookupId: (lower) => (lower === "аня" ? 42 : undefined),
  });
  const port = {
    model,
    toast: (m: string) => toasts.push(m),
    registerModal: () => undefined,
    closeOpenModal: () => undefined,
    statsOf: () => undefined,
    resolvePlayerInput: async () => null,
    confirmRemoveCustomTag: () => true,
    refreshTiles: () => undefined,
    refreshPlayer: () => undefined,
    ...over,
  } as ModalPort;
  return { port, model, toasts };
}

const modal = () => document.querySelector(".polemica-note-modal") as HTMLElement;
const textarea = () => modal().querySelector("textarea") as HTMLTextAreaElement;
const buttonByText = (text: string) =>
  [...modal().querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  document.body.innerHTML = "";
  h.saved = {};
});
afterEach(() => {
  // Закрываем окно КАК ПОЛЬЗОВАТЕЛЬ: иначе capture-слушатель keydown уезжает
  // в следующий тест, и мутант «close() не снимает слушатель» — тот самый
  // баг, ради которого close() и писался, — становится неуловимым
  // (adversarial 28.08.2026).
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("открытие", () => {
  test("окно появляется, поле уже с текстом заметки", async () => {
    const { port, model } = makePort({ "u:42": { text: "льёт на первого", timestamp: 1 } });
    await model.load();
    showNoteModal(port, "Аня");
    expect(modal(), "окно смонтировано").toBeTruthy();
    expect(textarea().value).toBe("льёт на первого");
  });

  test("ник игрока НЕ подставляется в разметку сырым", () => {
    // Ник приходит со стола — источник недоверенный, и он попадает в HTML
    // страницы САЙТА. Проверяем, что из него не родился УЗЕЛ: экранированный
    // текст «<img …>» в разметке допустим, живой тег — нет.
    const { port } = makePort();
    showNoteModal(port, '<img src=x onerror="alert(1)">');
    expect(modal().querySelector("img"), "тег из ника не создан").toBeNull();
    expect(modal().textContent, "ник виден как текст").toContain("<img src=x");
  });

  test("длина заметки ограничена — потолок стоит на самом поле", () => {
    const { port } = makePort();
    showNoteModal(port, "Аня");
    expect(textarea().maxLength).toBeGreaterThan(0);
  });

  test("предыдущее окно закрывается: модалка в проекте одна", () => {
    let closes = 0;
    const { port } = makePort({}, { closeOpenModal: () => closes++ });
    showNoteModal(port, "Аня");
    expect(closes).toBe(1);
  });
});

describe("сохранение", () => {
  test("«Сохранить» пишет заметку по ВЕЧНОМУ ключу игрока", async () => {
    // id резолвится (статистика знает игрока) — значит заметка обязана лечь
    // на u:-ключ: он переживает смену ника и не путает тёзок.
    const { port, model } = makePort({ "u:42": { text: "старое", timestamp: 1 } });
    await model.load();
    showNoteModal(port, "Аня");
    textarea().value = "новое наблюдение";
    buttonByText("Сохранить")?.click();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect((h.saved["u:42"] as { text: string }).text).toBe("новое наблюдение");
  });

  test("Esc закрывает окно, ничего не сохраняя", async () => {
    const { port, model } = makePort();
    await model.load();
    showNoteModal(port, "Аня");
    textarea().value = "не сохранять";
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(h.saved, "молчаливого сохранения по Esc быть не должно").toEqual({});
    expect(modal(), "окно закрылось").toBeNull();
  });
});

describe("закрытие снимает за собой", () => {
  test("после Esc клавиатура больше не перехватывается", () => {
    const { port } = makePort();
    showNoteModal(port, "Аня");
    let seen = 0;
    const probe = (): void => {
      seen++;
    };
    document.addEventListener("keydown", probe);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(modal(), "окно закрылось").toBeNull();
    // Второй Escape уже не должен ни за что цепляться: слушатель модалки снят,
    // до нашего зонда событие доходит.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.removeEventListener("keydown", probe);
    // Первый Escape окно съедает (stopPropagation) — это его работа. Второй
    // обязан дойти до страницы: если бы close() не снял capture-слушатель,
    // мёртвое окно глотало бы Escape и дальше, и счётчик остался бы нулём.
    expect(seen, "второй Escape дошёл до страницы").toBe(1);
  });

  test("окно снимает СВОЮ регистрацию, а не чужую", () => {
    // Закрытие старого окна не имеет права разрегистрировать уже открытое
    // новое: иначе disable() не позовёт его close() (adversarial 28.08.2026).
    const registered: Array<() => void> = [];
    const { port } = makePort(
      {},
      {
        registerModal: (close) => registered.push(close),
        unregisterModal: (close) => {
          const i = registered.indexOf(close);
          if (i >= 0) registered.splice(i, 1);
        },
      },
    );
    showNoteModal(port, "Аня");
    const first = registered[0];
    showNoteModal(port, "Боря"); // второе окно поверх первого
    expect(registered).toHaveLength(2);
    first?.(); // закрываем ПЕРВОЕ
    expect(registered, "регистрация второго окна цела").toHaveLength(1);
  });
});
