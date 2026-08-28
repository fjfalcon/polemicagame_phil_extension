import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function sourceFiles(pattern = "src/**/*.ts"): string[] {
  return fg.sync(pattern, { cwd: ROOT, absolute: false }).sort();
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/**
 * Тело функции по имени — через AST, а не регэкспом по файлу: проверка
 * «teardown стоит внутри disableAutoAccept» иначе проходила бы и когда
 * clearTimeout уехал в любую функцию ниже по файлу.
 */
function functionBody(source: string, name: string): string {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let body: string | null = null;
  const visit = (node: ts.Node) => {
    if (body !== null) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) {
      body = node.body.getText(sf);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (body === null) throw new Error(`function ${name} not found; invariant test cannot run`);
  return body;
}

function parseTs(relative: string): ts.SourceFile {
  return ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function propertyNames(node: ts.ObjectLiteralExpression | ts.InterfaceDeclaration): string[] {
  const members = ts.isObjectLiteralExpression(node) ? node.properties : node.members;
  return members.flatMap((member) => {
    const name = member.name;
    if (!name) return [];
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return [name.text];
    return [];
  });
}

function findInterface(relative: string, name: string): ts.InterfaceDeclaration {
  const sf = parseTs(relative);
  const found = sf.statements.find(
    (node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === name,
  );
  if (!found) throw new Error(`${relative}: interface ${name} not found; invariant test cannot run`);
  return found;
}

function findObject(relative: string, name: string): ts.ObjectLiteralExpression {
  const sf = parseTs(relative);
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== name || !decl.initializer) continue;
      if (ts.isObjectLiteralExpression(decl.initializer)) return decl.initializer;
      if (
        ts.isAsExpression(decl.initializer) &&
        ts.isObjectLiteralExpression(decl.initializer.expression)
      ) return decl.initializer.expression;
    }
  }
  throw new Error(`${relative}: object ${name} not found; invariant test cannot run`);
}

describe("AGENTS §4 storage and data ownership", () => {
  test("§4.3: direct whole-map saveNotes calls stay in the coordinator or reviewed fallbacks", () => {
    const directCalls: string[] = [];
    for (const file of sourceFiles()) {
      if (file === "src/core/notes-store.ts") continue;
      const source = read(file);
      for (const match of source.matchAll(/(?<![.\w])(saveNotes|saveNotesToStore)\s*\(/g)) {
        const line = source.split("\n")[lineOf(source, match.index) - 1];
        if (/\b(private|public|protected)\b/.test(line)) continue;
        // ОБЪЯВЛЕНИЕ, а не вызов: публичный метод модели заметок и член
        // интерфейса в import-fallback выглядят как вызов для регулярки, но
        // записи не делают. Признак — аннотация возвращаемого типа
        // (арх-ревью 28.08.2026: до этого инвариант считал строку
        // интерфейса за «прямого писателя» и держал под неё квоту).
        if (/^\s*(async\s+)?saveNotes\s*\([^)]*\)\s*:\s*Promise/.test(line)) continue;
        directCalls.push(file);
      }
    }

    // Файл + КОЛИЧЕСТВО, а не file:line: пин на номера строк ломался от любой
    // правки выше по файлу (трижды за сутки) и приучал «просто обновить
    // число» — при этом новый прямой писатель В ТОМ ЖЕ файле всё равно
    // ловится, потому что растёт счётчик.
    const counted = directCalls.reduce<Record<string, number>>((acc, file) => {
      acc[file] = (acc[file] ?? 0) + 1;
      return acc;
    }, {});
    const allowed = {
      "src/background/notes-coordinator.ts": 2,
      // Reviewed compatibility fallback for a stale live content realm after update.
      // Данные заметок живут в модели (арх-ревью 28.08.2026) — фолбэк уехал с ними.
      "src/content/features/player-notes/notes-model.ts": 1,
      // Фолбэк импорта пишет карту ЧЕРЕЗ ВНЕДРЁННУЮ зависимость
      // (deps.saveNotes) — прямым писателем он не является и под этот
      // счётчик не попадает; его путь закрыт своими тестами.
    };
    expect(counted, "§4.3: new whole-map writer bypasses the single background queue").toEqual(allowed);
  });

  test("§4.3/§4.11: frozen note bridge is read-only in storage.sync", () => {
    const violations: string[] = [];
    const protectedTokens = /NOTES_KEY|TAGS_KEY|LEGACY_KEY|playerNotes|tagCustomColors/;
    for (const file of sourceFiles()) {
      const source = read(file);
      for (const match of source.matchAll(/browser\.storage\.sync\.(set|remove|clear)\s*\(([^;]*)/g)) {
        if (protectedTokens.test(match[2])) violations.push(`${file}:${lineOf(source, match.index)}`);
      }
    }
    expect(violations, "§4.3: notes belong in storage.local; sync is a frozen read-only bridge").toEqual([]);

    const notesStore = read("src/core/notes-store.ts");
    // 2 чтения (оба read-only): migrateFromSync (координатор, с записью в
    // local) и migratedView (вид в памяти для не-координаторов, SEC26-5).
    expect(count(notesStore, /browser\.storage\.sync\.get\s*\(/g)).toBe(2);
    expect(count(notesStore, /browser\.storage\.local\.set\s*\(/g)).toBeGreaterThanOrEqual(3);
  });

  test("obs_host пишется только через границу settings (ревью 27.08.2026)", () => {
    // Санитайзер стоит в setSettings; прямая запись ключа мимо него снова
    // вынесла бы креды в облако. Исключения — записи ФОНА, которые сами
    // нормализуют значение: разовое самолечение и транзакция endpoint
    // (она владеет обеими частями пары, ревью 27.08.2026).
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = read(file);
      for (const m of source.matchAll(/storage\.sync\.set\(\{[^}]*obs_host/g)) {
        const line = lineOf(source, m.index);
        const around = source.slice(Math.max(0, (m.index ?? 0) - 400), (m.index ?? 0) + 200);
        if (/sanitizeObsHost/.test(around)) continue; // самолечение фона
        // Транзакция: host уже прошёл sanitizeObsHost в начале обработчика.
        if (/OBS: адрес не записался|storage\.sync\.set\(\{ obs_host: host \}\)/.test(around)) continue;
        offenders.push(`${file}:${line}`);
      }
    }
    expect(offenders, "obs_host мимо setSettings/санитайзера").toEqual([]);
  });

  test("§4.11: notes migration commits data and completion flag atomically", () => {
    const source = read("src/core/notes-store.ts");
    expect(source).toMatch(/storage\.local\.set\(\{[\s\S]*?\[MIGRATED_KEY\]: true[\s\S]*?\}\)/);
    expect(source).not.toMatch(/storage\.sync\.remove\([^)]*(NOTES_KEY|LEGACY_KEY|TAGS_KEY)/);
  });
});

describe("AGENTS §4 source safety", () => {
  test("§4.1/§4.2: feature scans never use querySelectorAll('*')", () => {
    const violations: string[] = [];
    for (const file of sourceFiles("src/content/features/*.ts")) {
      const sf = parseTs(file);
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "querySelectorAll" &&
          node.arguments.length === 1 &&
          (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
          node.arguments[0].text === "*"
        ) {
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push(`${file}:${pos.line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(violations, "§4.1/§4.2: wildcard scans amplify MutationObserver loops and inherited text").toEqual([]);
  });

  test("§4.2: every text-matched click list is deepest-only and visibility-gated", () => {
    const source = read("src/content/features/auto-start.ts");
    expect(source).toContain("START_CANDIDATE_SELECTOR");
    expect(
      count(source, /el\.contains\(other\)/g),
      "§4.2: text filters match parent and child alike without a deepest-only pass",
    ).toBe(3); // accept buttons, accept cards, start-game fallback
    const startFallback = functionBody(source, "clickStartGameButton");
    expect(startFallback, "§4.2: only visible elements may be clicked").toMatch(
      /isVisible\([\s\S]{0,40}?\)[\s\S]{0,200}?safeClick\(/,
    );
  });

  test("§4.1: SharedDomObserver remains the only production MutationObserver", () => {
    const owners: string[] = [];
    for (const file of sourceFiles()) {
      const source = read(file);
      for (const match of source.matchAll(/new\s+MutationObserver\s*\(/g)) {
        void match;
        owners.push(file);
      }
    }
    // Пин ФАЙЛА, не номера строки: точный номер смещался трижды за день
    // 26.08.2026 и тренировал рефлекс «поправь число» (adversarial №5) —
    // единственность наблюдателя это не защищало лучше, чем список файлов.
    expect(owners, "§4.1: multiple observers recreate self-sustaining document-wide DOM loops").toEqual([
      "src/core/dom.ts",
    ]);
  });

  test("§4.1: the shared observer watches childList + class/style only, without characterData", () => {
    // Набор опций — осознанное решение (комментарий у observe() в dom.ts):
    // characterData ловил бы каждый текстовый тик таймеров сайта и затопил бы
    // очередь мутаций; атрибуты сужены до class/style, по которым сайт
    // переключает фазы. Расширение набора — только через ревью.
    const source = read("src/core/dom.ts");
    const observed = source.match(/\.observe\(document\.documentElement,\s*\{([\s\S]*?)\}\s*\)/);
    expect(observed, "§4.1: the shared observer must observe document.documentElement").not.toBeNull();
    const options = observed![1];
    expect(options).toMatch(/childList:\s*true/);
    expect(options).toMatch(/subtree:\s*true/);
    expect(options).toMatch(/attributes:\s*true/);
    expect(options).toMatch(/attributeFilter:\s*\["class",\s*"style"\]/);
    expect(options, "§4.1: characterData floods the queue with per-second text ticks").not.toMatch(
      /characterData/,
    );
    expect(count(source, /\.observe\s*\(/g), "§4.1: a second observe() call widens the watched set").toBe(1);
  });

  test("§4.5: central hotkey router keeps code/typing/modifier/repeat gates", () => {
    const source = read("src/core/keyboard.ts");
    for (const required of ["e.code", "isTypingContext(e)", "e.ctrlKey", "e.metaKey", "e.altKey", "e.repeat"]) {
      expect(source, `§4.5: keyboard router lost required gate ${required}`).toContain(required);
    }
  });

  test("§4.5: role-faker's separate blocker keeps its gates in one tested predicate", () => {
    const source = read("src/content/features/role-faker.ts");
    for (const required of ["e.code !== hideKeyCode", "isTypingContext(e)", "e.ctrlKey", "e.metaKey", "e.altKey"]) {
      expect(source, `§4.5: role-faker blocker lost required gate ${required}`).toContain(required);
    }
    // Сама политика (в т.ч. осознанно инвертированный repeat) проверяется
    // поведением в tests/unit/role-faker.test.ts. Здесь — только то, что
    // блокировщик не завёл вторую копию гейтов в обход предиката.
    expect(source, "§4.5: the blocker must delegate to shouldSwallowRoleKey").toMatch(
      /this\.dBlocker = \([^)]*\) => \{[\s\S]{0,200}?shouldSwallowRoleKey\(/,
    );
  });

  test("§4.6: reconnecting sockets detach all four old handlers", () => {
    for (const file of ["src/background/obs-client.ts", "src/content/panels/twitch-panel.ts"]) {
      const source = read(file);
      for (const handler of ["onopen", "onmessage", "onclose", "onerror"]) {
        expect(source, `§4.6: ${file} does not detach ${handler} before socket replacement`).toMatch(
          new RegExp(`\\.${handler}\\s*=\\s*null`),
        );
      }
    }
  });

  test("§4.8/§4.9: match parser prefers game-data and parses before entity decoding", () => {
    const source = read("src/content/match-data.ts");
    const gameData = source.indexOf("text.match(/game-data=");
    const legacyDataGame = source.indexOf("text.match(/data-game=");
    const parseRaw = source.indexOf("JSON.parse(m[1])");
    const decode = source.indexOf("JSON.parse(decodeHtmlEntities(m[1]))");
    expect(gameData).toBeGreaterThan(-1);
    expect(gameData).toBeLessThan(legacyDataGame);
    expect(parseRaw).toBeGreaterThan(-1);
    expect(parseRaw).toBeLessThan(decode);
  });

  test("§4.8: lift ballots without num remain explicitly separated", () => {
    // Логика переехала в чистый src/content/match-outcome.ts: это
    // единственное место, где расширение делает ВЫВОД о матче, а не
    // пересказывает данные сайта — и теперь оно проверяется поведением.
    const source = read("src/content/match-outcome.ts");
    expect(source).toMatch(/vote\.num\s*===\s*undefined\s*\|\|\s*vote\.num\s*===\s*null/);
    expect(source).toMatch(/yes\s*>\s*no/);
    expect(source).toMatch(/departed:\s*number\[\]/);
    // Рендерер обязан пользоваться модулем, а не заводить свою копию правил.
    const renderer = read("src/content/features/match-stats.ts");
    expect(renderer).toMatch(/from "\.\.\/match-outcome"/);
    expect(renderer, "вторая копия правила исхода дня разъедется с первой").not.toMatch(
      /function resolveDayOutcome/,
    );
  });
});

describe("settings, release and manifest consistency", () => {
  test("§4.12: Settings and DEFAULT_SETTINGS have exactly the same keys", () => {
    const settings = propertyNames(findInterface("src/shared/types.ts", "Settings")).sort();
    const defaults = propertyNames(findObject("src/core/settings.ts", "DEFAULT_SETTINGS")).sort();
    expect(settings.length).toBeGreaterThan(40);
    expect(defaults, "§4.12: a setting without a default changes upgrade behavior unpredictably").toEqual(settings);
  });

  test("player-notes не растёт обратно: новая подсистема — новый модуль", () => {
    // Арх-ревью 28.08.2026: файл дорос до 4326 строк и держал сеть, кэши,
    // резолв ключей, статистику, стили и весь UI сразу. Семь слоёв
    // вынесены (4326 → 3176); потолок стоит
    // не ради красивой цифры, а чтобы следующая подсистема заводилась
    // отдельным модулем, а не «ещё одной тысячей строк здесь».
    //
    // Потолок можно ОПУСКАТЬ свободно. Поднимать — только осознанно, вместе
    // с объяснением, почему подсистема неотделима.
    const CAP = 3200;
    const lines = read("src/content/features/player-notes.ts").split("\n").length;
    expect(
      lines,
      `player-notes.ts ${lines} строк при потолке ${CAP}: выдели подсистему в ./player-notes/*`,
    ).toBeLessThanOrEqual(CAP);
  });

  test("селекторы сайта живут ТОЛЬКО в selectors.ts", () => {
    // Обещание selectors.ts: «при редизайне polemicagame.com правится ТОЛЬКО
    // этот файл». Арх-ревью 28.08.2026 показало, что обещание стало
    // пожеланием — сырые классы сайта расползлись по девяти файлам. Правило
    // без стража живёт ровно до следующей спешки, поэтому оно исполняемое.
    //
    // Разрешено: НАША собственная разметка (префиксы pn-/fp-/ss-/twitch-/
    // polemica-, data-pn-*), теги, атрибуты и #app — это не знание о вёрстке
    // сайта, а наше собственное.
    const OURS =
      /^[\s\S]*(pn-|polemica-|fp-|ss-|twitch-|obs-|scene-item|data-pn|#app|#tag-|#note-)/;
    const CALL = /(?:querySelector|querySelectorAll|closest|matches)\(\s*"([^"]+)"/g;
    const offenders: string[] = [];
    for (const file of sourceFiles("src/**/*.ts")) {
      if (file === "src/core/selectors.ts") continue;
      const source = read(file);
      for (const m of source.matchAll(CALL)) {
        const selector = m[1];
        // Классы сайта — это литералы с точкой, которых нет в нашем префиксе.
        if (!selector.includes(".")) continue;
        if (OURS.test(selector)) continue;
        offenders.push(`${file}:${lineOf(source, m.index ?? 0)} → ${selector}`);
      }
    }
    expect(
      offenders,
      "селектор сайта вне selectors.ts: при редизайне его никто не найдёт — заведи ключ в SITE",
    ).toEqual([]);
  });

  test("AGENTS не врёт про минификацию бандла", () => {
    // Внешнее арх-ревью 28.08.2026 поймало расхождение: AGENTS обещал «без
    // минификации», а tsup минифицирует с 01.08.2026. Для человека это
    // мелочь, для агента — источник решений по несуществующей архитектуре,
    // поэтому автоматически выводимый факт обязан проверяться, а не
    // пересказываться. Правило шире одного факта: если в AGENTS появляется
    // утверждение о конфиге — ему нужен такой же страж.
    const minifies = /^\s*minify:\s*true\s*,/m.test(read("tsup.config.ts"));
    const doc = read("AGENTS.md");
    const claimsMinified = /минифицированный/.test(doc);
    const claimsPlain = /без минификации/.test(doc);
    expect(claimsPlain, "AGENTS утверждает «без минификации»").toBe(false);
    expect(claimsMinified, "AGENTS обязан описывать реальную сборку").toBe(minifies);
  });

  test("package and base manifest versions match", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const manifest = JSON.parse(read("src/manifest/manifest.base.json")) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.version).toBe(pkg.version);
  });

  test("Firefox manifest declares data collection (AMO requirement)", () => {
    // AMO предупреждает о пропущенном ключе на каждой заливке и обещает
    // сделать его обязательным. Расширение НИЧЕГО не собирает: заметки и
    // логи лежат в браузере пользователя, наружу уходят только запросы к
    // самому сайту игры, к GitHub за номером версии и к локальному OBS.
    // Поэтому «none»; появится сбор — этот тест придётся осознанно менять.
    const ff = JSON.parse(read("src/manifest/manifest.firefox.json")) as {
      browser_specific_settings: {
        gecko: { data_collection_permissions?: { required?: string[] } };
      };
    };
    expect(ff.browser_specific_settings.gecko.data_collection_permissions?.required).toEqual([
      "none",
    ]);
    // Ключ — только у Firefox: Chrome такого не знает и ругается на лишнее.
    expect(read("src/manifest/manifest.base.json")).not.toContain("data_collection_permissions");
    expect(read("src/manifest/manifest.chrome.json")).not.toContain(
      "data_collection_permissions",
    );
  });

  test("manifest permissions exactly match privileged browser API usage", () => {
    const manifest = JSON.parse(read("src/manifest/manifest.base.json")) as { permissions: string[] };
    const apiNamespaces = new Set<string>();
    for (const file of sourceFiles()) {
      for (const match of read(file).matchAll(/\bbrowser\.([a-zA-Z]+)\b/g)) apiNamespaces.add(match[1]);
    }
    const permissionByApi: Record<string, string | null> = {
      alarms: "alarms",
      notifications: "notifications",
      storage: "storage",
      runtime: null,
      tabs: null,
      windows: null,
      // Бейдж/getUserSettings онбординга (06.08.2026): API доступно через
      // ключ "action" манифеста, записи в permissions не требует.
      action: null,
    };
    const unknown = [...apiNamespaces].filter((name) => !(name in permissionByApi)).sort();
    expect(unknown, "New browser API namespace needs an explicit permission review").toEqual([]);
    const required = [...apiNamespaces]
      .map((name) => permissionByApi[name])
      .filter((value): value is string => value !== null)
      .sort();
    expect([...manifest.permissions].sort()).toEqual(required);
    expect(manifest.permissions).not.toContain("scripting");
  });

  test("Chrome/Firefox minimums and dual background forms remain intact", () => {
    const chrome = JSON.parse(read("src/manifest/manifest.chrome.json"));
    const firefox = JSON.parse(read("src/manifest/manifest.firefox.json"));
    expect(chrome).toMatchObject({
      background: { service_worker: "background.js" },
      minimum_chrome_version: "116",
    });
    expect(firefox).toMatchObject({
      background: { scripts: ["background.js"] },
      browser_specific_settings: { gecko: { strict_min_version: "121.0" } },
    });
  });
});

describe("logging and popup invariants", () => {
  test("secrets are not passed directly to log calls", () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      const sf = parseTs(file);
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "log"
        ) {
          const call = node.getText(sf);
          if (/obs_password|authKey|current-user/i.test(call)) {
            const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(`${file}:${pos.line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(violations, "Secrets in support logs violate AGENTS §4 and site-api authKey rules").toEqual([]);
  });

  test("OBS auto-scene decisions are logged at info, not debug", () => {
    // В файл лога попадает только info. Весь путь автосмены сцен был на
    // debug — жалоба «сцены перестали переключаться» приходила с логом, в
    // котором об этом НИ СЛОВА (разбор 02.08.2026). Каждая ветка, которая
    // решает «переключаю» / «не переключаю», обязана быть видимой.
    const body = functionBody(read("src/content/panels/obs-panel.ts"), "autoSwitchScene");
    const decisions = body.split("\n").filter((line) => /log\.(info|debug)\(/.test(line));
    expect(decisions.length).toBeGreaterThanOrEqual(3);
    const debugOnly = decisions.filter((line) => line.includes("log.debug("));
    // Единственный допустимый debug — «сцена и так уже нужная»: это не
    // решение, а отсутствие работы, и оно повторяется на каждой фазе.
    expect(debugOnly.length, "OBS auto-scene branch logs below info are invisible in support logs").toBeLessThanOrEqual(1);

    const owner = read("src/background/index.ts");
    expect(owner, "отказ по владению автосценой обязан быть виден в логе").toMatch(
      /log\.info\([^)]*"background",\s*\n?\s*"смена сцены пропущена/,
    );
  });

  test("итог попытки переподключения и решение при закрытии видны в файле", () => {
    // Обе строки — терминальные исходы, ради которых пакет и делался: без них
    // «OBS не подключается» неразбираемо (OC-1, OC-4). Уровень ниже info в
    // файл не попадает вовсе.
    const source = read("src/background/obs-client.ts");
    expect(source, "итог КАЖДОЙ попытки обязан быть виден").toMatch(
      /log\.warn\(\s*"obs",\s*`переподключение не удалось/,
    );
    expect(source, "строка закрытия обязана сообщать принятое решение").toMatch(
      /log\.info\([\s\S]{0,400}?"соединение закрыто:[\s\S]{0,400}?дальше:/,
    );
  });

  test("OBS не логирует сырой адрес и текст причины от сервера", () => {
    // Проводка санитизации, а не сами функции: `safeEndpoint`/`closeCategory`
    // проверены отдельно, но вызов мимо них не поймала бы ни одна их проверка
    // — тот же разрыв «функция протестирована, а её место вызова нет».
    const source = read("src/background/obs-client.ts");
    const logCalls = [...source.matchAll(/log\.(?:info|warn|error|debug)\(([\s\S]{0,200}?)\);/g)].map(
      (m) => m[1],
    );
    const withRawReason = logCalls.filter((call) => /event\.reason/.test(call));
    expect(withRawReason, "текст причины присылает сервер — в файл поддержки он не идёт").toEqual([]);
    const withRawUrl = logCalls.filter((call) => /\burl\b/.test(call) && !/safeEndpoint/.test(call));
    expect(withRawUrl, "в obs_host бывает ws://user:pass@host — только safeEndpoint()").toEqual([]);
  });

  test("§4.4: popup save path writes the diff patch, not a full DOM snapshot", () => {
    const source = read("src/popup/index.ts");
    expect(source).toContain("if (!lastKnown) return");
    expect(source).toMatch(/const patch:\s*Partial<Settings>\s*=\s*\{\}/);
    expect(source).// saveSettings стал асинхронным (ревью 27.08.2026: ручной connect его
    // ЖДЁТ) — вызов через return, а не void.
    toMatch(/return setSettings\(patch\)/);
    expect(source).not.toMatch(/await setSettings\(settings\)/);
    expect(source).toContain("onSettingsChanged(");
  });
});

describe("§4.7 lifecycle heuristic", () => {
  type Allowance = { listeners?: number; timers?: number; reason: string };
  const allowances: Record<string, Allowance> = {
    // Populated only for reviewed DOM-owned one-shot handlers/timers. Exact deltas make new tails fail.
    "src/content/features/camera-health.ts": {
      listeners: 1,
      timers: 1,
      reason:
        "click-обработчик живёт на кнопке #pn-camera-reload и удаляется вместе с её узлом в disable(); " +
        "+1 таймер (9.23.1) — шаги лесенки ставят setTimeout трижды при одном clearTimeout-поле verdictTimer, " +
        "каждый прежний таймер снимается перед новым и в disable()",
    },
    "src/content/features/contract-watch.ts": {
      listeners: 0,
      timers: 1,
      reason:
        "два setTimeout (роут и enable-в-комнате) пишут ОДИН хендл settleTimer, " +
        "который гасится общим cancelSettle в disable() и на каждом переходе (9.33.0)",
    },
    "src/content/features/profile-crossover.ts": {
      listeners: 0,
      timers: 1,
      reason:
        "await-слип 350 мс перед загрузкой историй (9.32.1, anti-листание): промис всегда " +
        "резолвится сам, после него стоит гейт routeId/isConnected — переживать disable нечему",
    },
    "src/content/features/profile-mmr-chart.ts": {
      listeners: 0,
      timers: 1,
      reason: "тот же await-слип 350 мс, что у profile-crossover (9.32.1)",
    },
    "src/content/features/connection-diag.ts": {
      listeners: 1,
      timers: 1,
      reason: "page probe load/error listeners and one-shot injection timeout are DOM-owned",
    },
    "src/content/features/match-stats.ts": {
      listeners: 2,
      timers: 3,
      reason: "timeline row listeners are removed with nodes; timers are tracked in module sets",
    },
    "src/content/features/player-notes.ts": {
      listeners: 36,
      timers: 1,
      reason:
        "modal/button handlers are removed with owned nodes; toast removal is a harmless one-shot; " +
        "+2 (9.13.0) — hover-обработчики кнопки пересечений живут на её же узле, а таймер намерения гасится в mouseleave",
    },
    "src/content/features/postgame-search.ts": {
      listeners: 2,
      timers: 0,
      reason:
        "click handler is owned by the removable «В поиск» button node; " +
        "+1 (9.16.0) — «обновить» у панели очередей живёт на её же узле и снимается вместе с ним",
    },
    "src/content/features/queue-peek.ts": {
      listeners: 4,
      timers: 2,
      reason: "temporary button/socket listeners and request deadlines are closed by local done/finally",
    },
    "src/content/features/role-marker.ts": {
      listeners: 4,
      timers: 0,
      reason: "menu-node handlers are removed with the menu; the delayed arm timer is cleared by closeMenu",
    },
    "src/content/features/tooltip.ts": {
      listeners: 3,
      timers: 0,
      reason: "tooltip handlers are owned by and removed with the tooltip node",
    },
    "src/content/features/update-notify.ts": {
      listeners: 1,
      timers: 0,
      reason: "dismiss handler is owned by the removable update banner",
    },
  };

  test("§4.7: delayed tails are held in named handles and cleared on teardown", () => {
    const roleMarker = read("src/content/features/role-marker.ts");
    expect(roleMarker, "§4.7: menu arm timer must be cancellable").toMatch(
      /armTimer = setTimeout\(/,
    );
    expect(roleMarker, "§4.7: closeMenu must cancel the pending arm timer").toMatch(
      /closeMenu = \(\) => \{[\s\S]*?clearTimeout\(armTimer\)/,
    );

    const autoStart = read("src/content/features/auto-start.ts");
    expect(autoStart, "§4.7: webcam autoclick must be cancellable").toMatch(
      /webcamClickTimer = setTimeout\(/,
    );
    expect(
      functionBody(autoStart, "disableAutoAccept"),
      "§4.7: disableAutoAccept must cancel the webcam autoclick",
    ).toContain("clearTimeout(webcamClickTimer)");
  });

  test("feature acquisitions have matching teardown or an exact reviewed allowance", () => {
    const problems: string[] = [];
    const seenAllowances = new Set<string>();
    for (const file of sourceFiles("src/content/features/*.ts")) {
      const source = read(file);
      const listenerDelta = Math.max(
        0,
        count(source, /\.addEventListener\s*\(/g) - count(source, /\.removeEventListener\s*\(/g),
      );
      const timerDelta = Math.max(
        0,
        count(source, /\bset(?:Timeout|Interval)\s*\(/g) -
          count(source, /\bclear(?:Timeout|Interval)\s*\(/g),
      );
      if (!listenerDelta && !timerDelta) continue;
      const allowed = allowances[file];
      if (allowed) seenAllowances.add(file);
      if (allowed?.listeners !== listenerDelta || allowed?.timers !== timerDelta) {
        problems.push(
          `${file}: unmatched listeners=${listenerDelta}, timers=${timerDelta}; ` +
            `expected ${allowed ? `${allowed.listeners ?? 0}/${allowed.timers ?? 0} (${allowed.reason})` : "no allowance"}`,
        );
      }
    }
    const stale = Object.keys(allowances).filter((file) => !seenAllowances.has(file));
    expect(stale, "Remove stale lifecycle allowances instead of letting the whitelist grow").toEqual([]);
    expect(
      problems,
      "AGENTS §4.7: every global acquisition/tail timer needs symmetric teardown; DOM-owned exceptions require review",
    ).toEqual([]);
  });
});
