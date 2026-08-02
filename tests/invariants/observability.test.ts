import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Терминальные исходы обязаны быть видны в файле поддержки.
 *
 * Повод — две жалобы за день, обе неразбираемые: решения фич жили на `debug`,
 * а в файл идёт только `info` и выше. Проверяем не «есть ли лог вообще», а
 * что КОНКРЕТНЫЕ тупики объявляют себя: именно на них упирался разбор.
 */
describe("терминальные исходы автовозврата (QR-1..3)", () => {
  const source = read("src/content/features/queue-requeue.ts");

  test.each([
    ["окно вышло, кнопки не было", /автовозврат остановлен: за/],
    ["кнопка недоступна", /автовозврат остановлен: кнопка «Играть» недоступна/],
    ["уступили игроку", /автовозврат отложен: игрок только что действовал сам/],
    ["успех подтверждён секундомером", /поиск возобновлён: секундомер очереди подтверждён/],
    ["мост не сохранился", /не удалось сохранить мост автовозврата/],
    ["мост протух или побит", /мост автовозврата пропущен:/],
  ])("%s", (_name, pattern) => {
    expect(source).toMatch(pattern);
  });

  test("«лобби стартует» объявляется: эта ветка сбрасывает окно", () => {
    // Терминального warn тут не будет никогда — окно обнуляется, — поэтому
    // молчание означало бы, что подвисший лоадер вообще не виден в файле.
    expect(source).toMatch(/лобби стартует — не вмешиваемся/);
  });

  test("у каждой причины отсрочки свой латч", () => {
    // Общий латч глушил бы две другие причины до конца жизни страницы, и в
    // файле оставалась бы не та причина.
    expect(source).toMatch(/roomExitDeferLogged\.hidden/);
    expect(source).toMatch(/roomExitDeferLogged\.userInput/);
    expect(source).toMatch(/roomExitDeferLogged\.retryScreen/);
  });

  test("отсрочки объявляются по фронту, а не на каждый тик", () => {
    // Тики идут ~4 раза в секунду: без латча эти строки затопили бы кольцо и
    // вытеснили первопричину — ровно то, с чем боролись в пакете A.
    expect(source).toMatch(/backoffLogged/);
    expect(source).toMatch(/roomExitDeferLogged/);
  });
});

describe("терминальные исходы автопринятия и стартового окна (AS-1..2)", () => {
  const source = read("src/content/features/auto-start.ts");

  test.each([
    ["бюджет кликов исчерпан", /автопринятие остановлено:/],
    ["подавление разведкой", /автопринятие приостановлено: идёт разведка очереди/],
    ["окно есть, кнопки нет", /стартовое окно найдено, но кнопка запуска не распознана/],
    ["камера не распознана", /кнопка камеры не распознана/],
    ["камера сдалась", /камера не переключилась за/],
  ])("%s", (_name, pattern) => {
    expect(source).toMatch(pattern);
  });

  test("клик автопринятия логируется с потолком: одна строка на узел", () => {
    // Бюджет живёт на экземпляр узла, а сайт пересоздаёт блок принятия —
    // без гейта у строки не было потолка (до пяти в секунду).
    expect(source).toMatch(/used === 0\) log\.info/);
  });

  test("подписи кнопок сайта в лог не пишем", () => {
    // Текст сайта сигнала не добавляет, а строку раздувает.
    expect(source).not.toMatch(/log\.(info|warn)\([^)]*textContent/);
  });
});

describe("предупреждение о фоновой очереди (QG-1..2)", () => {
  const guard = read("src/content/features/queue-guard.ts");
  const background = read("src/background/index.ts");

  test("«взведено» объявляется только после подтверждения фона", () => {
    // Раньше строка утверждала успех, которого могло не быть: sendRuntime
    // гасит отказ и возвращает undefined, а фон отвечал ok даже без id вкладки.
    expect(guard).toMatch(/res\?\.ok[\s\S]{0,200}?будильник подтверждён/);
    expect(guard).toMatch(/НЕ взведено/);
  });

  test("фон не отвечает успехом, когда взводить нечего", () => {
    // Две половины одной защиты: сам armQueueGuard обязан отказать без id
    // вкладки, а обработчик — передать этот отказ дальше. Раньше он молча
    // ничего не делал и возвращал ok:true.
    expect(background).toMatch(/armQueueGuard\(sender\.tab\?\.id\)[\s\S]{0,200}?ok: false/);
    expect(background, "armQueueGuard обязан вернуть false без id вкладки").toMatch(
      /async function armQueueGuard\([\s\S]{0,300}?tabId === undefined\) return false/,
    );
  });

  test("переарм ограничен потолком и объявляется по фронту", () => {
    // Иначе отказ превращался в поток warn со скоростью мутаций DOM — ровно
    // в осиротевшей вкладке, которую пакет A научился распознавать.
    expect(guard).toMatch(/MAX_ARM_ATTEMPTS/);
    expect(guard).toMatch(/armFailureLogged/);
  });

  test.each([
    ["снятие", /предупреждение о фоновой очереди снято:/],
    ["вкладка не ответила", /уведомление об очереди не показано: вкладка не ответила/],
    ["уведомление создано", /уведомление об очереди создано/],
    ["просроченный будильник", /просроченный будильник очереди пропущен/],
  ])("%s объявляется", (_name, pattern) => {
    expect(background + guard).toMatch(pattern);
  });
});

describe("разведка очереди (QP-1)", () => {
  const source = read("src/content/features/queue-peek.ts");

  test.each([
    ["нет данных пользователя", /на странице нет данных пользователя/],
    ["нет id или ключа", /нет id или ключа/],
    ["код ответа", /код ответа/],
    ["нет поля queues", /в ответе нет поля queues/],
  ])("причина «%s» различима", (_name, pattern) => {
    expect(source).toMatch(pattern);
  });
});

describe("твич-чат: транспорт ≠ готовность (TW-1..2)", () => {
  const source = read("src/content/panels/twitch-panel.ts");

  test.each([
    ["сокет открыт", /twitch: сокет открыт/],
    ["чат готов", /twitch: чат готов — вход в канал подтверждён/],
    ["вход отклонён", /twitch: сервис отклонил вход в канал/],
    ["соединение закрыто", /twitch: соединение закрыто, код/],
    ["переподключение", /twitch: переподключение, попытка/],
    ["бюджет исчерпан", /twitch: переподключение прекращено/],
  ])("%s объявляется", (_name, pattern) => {
    expect(source).toMatch(pattern);
  });

  test("бюджет попыток обнуляет ГОТОВНОСТЬ чата, а не открытие сокета", () => {
    // Раньше reconnectAttempts = 0 стояло в onopen: у «дёрганья» транспорта
    // не было верхнего предела, и поштучные строки могли сами забить кольцо.
    expect(source).toMatch(/ircReady = true;[\s\S]{0,120}?reconnectAttempts = 0/);
    const onopen = source.slice(source.indexOf("ws.onopen"), source.indexOf("ws.onmessage"));
    expect(onopen, "обнуление в onopen возвращает неограниченный бюджет").not.toMatch(
      /reconnectAttempts = 0/,
    );
  });

  test("объект события ошибки в лог не пишем", () => {
    // Он сериализуется в «{}» и в файле бесполезен.
    expect(source).not.toMatch(/log\.error\([^)]*"IRC websocket error", err/);
  });
});

describe("честный ответ пользователю (раздел «Ответ пользователю»)", () => {
  test.each([
    ["метка ролей: только чтение", "src/content/features/role-marker.ts", /showToast\(/],
    ["подмена роли не сработала", "src/content/features/role-faker.ts", /showToast\(/],
    ["заметки не загрузились", "src/content/features/player-notes.ts", /showToast\(/],
  ])("%s — человеку говорят вслух", (_name, file, pattern) => {
    // Лог отвечает на вопрос «что случилось» ПОТОМ; но в этих трёх случаях
    // человек прямо сейчас видит успех, которого не было.
    expect(read(file)).toMatch(pattern);
  });

  test("повторы тостов подавляются", () => {
    // Иначе на каждый клик по метке в read-only режиме вылезала бы плашка.
    expect(read("src/core/toast.ts")).toMatch(/DEDUPE_MS/);
  });
});

describe("заметки: повторяющаяся ошибка не вытесняет первопричину (PN-1)", () => {
  const source = read("src/content/features/player-notes.ts");

  test("устойчивая поломка прохода пишется один раз, а не каждые 2 секунды", () => {
    expect(source).toMatch(/passFailed/);
    expect(source).toMatch(/обновление заметок упало/);
    expect(source).toMatch(/обновление заметок восстановилось/);
  });
});

describe("панель твича не объявляет успех раньше времени (№8)", () => {
  const source = read("src/content/panels/twitch-panel.ts");

  test("«Подключились» — только после подтверждённого входа в канал", () => {
    // Для несуществующего канала Twitch молча игнорирует JOIN, и человек
    // шесть минут видел ложное «Подключились к чату».
    const onopen = source.slice(source.indexOf("ws.onopen"), source.indexOf("ws.onmessage"));
    expect(onopen).not.toMatch(/addSystemMessage\("Подключились/);
    expect(source).toMatch(/ircReady = true;[\s\S]{0,300}?addSystemMessage\("Подключились/);
  });

  test("неподтверждённый вход объявляется таймером, а не шестиминутным простоем", () => {
    // Проверяем ВЫЗОВ, а не наличие функции: объявление без вызова — ровно
    // тот вакуумный тест, который ловит только сам себя (ревью 02.08.2026).
    const connect = source.slice(
      source.indexOf("function connectToTwitch"),
      source.indexOf("function disconnect("),
    );
    expect(connect).toContain("startJoinWatchdog()");
    expect(connect, "таймер прошлого подключения обязан гаснуть до замены сокета").toContain(
      "clearJoinWatchdog()",
    );
    expect(source).toMatch(/имя набрано с ошибкой/);
  });
});

describe("тост не мешает игре", () => {
  const source = read("src/core/toast.ts");

  test("плашка не перехватывает клики", () => {
    // Правый нижний угол в комнате занят игровыми контролами. Ищем стиль
    // САМОЙ плашки: контейнер тоже имеет pointer-events: none, и поиск по
    // всему файлу проходил бы при любой реализации.
    // Якорь — className самой плашки: `el.style.cssText` есть и у
    // контейнера, и срез по нему брал чужой стиль (моя же ошибка).
    const style = source.slice(
      source.indexOf("el.className = TOAST_CLASS;"),
      source.indexOf("ensureContainer().appendChild"),
    );
    expect(style).toMatch(/pointer-events: none/);
  });

  test("тост в проекте один: две системы наложились бы друг на друга", () => {
    const requeue = read("src/content/features/queue-requeue.ts");
    expect(requeue, "queue-requeue обязан пользоваться общим модулем").toMatch(
      /from "@core\/toast"/,
    );
    expect(requeue).not.toMatch(/function showToast\(/);
  });
});
