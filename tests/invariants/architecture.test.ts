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
    // Разбор ДЕРЕВА, а не текста. У этого правила уже дважды оказывалось, что
    // регулярка видит не то: сначала она считала строку ИНТЕРФЕЙСА за
    // писателя, потом не видела настоящего писателя через внедрённую
    // зависимость (adversarial 28.08.2026). AST различает вызов и объявление
    // по построению, и ему всё равно, как записан вызов.
    //
    // Прямой писатель ВСЕЙ карты — это два пути:
    //   1) вызов функции, импортированной из @core/notes-store (под любым
    //      именем: обычно `saveNotes as saveNotesToStore`);
    //   2) вызов через ВНЕДРЁННУЮ зависимость — `deps.saveNotes(map)`.
    // Метод модели (`this.model.saveNotes`, `port.model.saveNotes`) под
    // правило не подпадает: он пишет ПОИМЁННО через координатора.
    const directCalls: string[] = [];
    for (const file of sourceFiles()) {
      if (file === "src/core/notes-store.ts") continue;
      const sf = parseTs(file);

      // Локальные имена, под которыми импортирован saveNotes из хранилища.
      const storeAliases = new Set<string>();
      for (const st of sf.statements) {
        if (
          !ts.isImportDeclaration(st) ||
          !ts.isStringLiteral(st.moduleSpecifier) ||
          !st.moduleSpecifier.text.includes("notes-store")
        ) {
          continue;
        }
        const named = st.importClause?.namedBindings;
        if (!named || !ts.isNamedImports(named)) continue;
        for (const el of named.elements) {
          if ((el.propertyName ?? el.name).text === "saveNotes") storeAliases.add(el.name.text);
        }
      }

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const direct = ts.isIdentifier(callee) && storeAliases.has(callee.text);
          // Получатель — простой идентификатор (deps), а не цепочка
          // (this.model / port.model): такой вызов идёт мимо владельца карты.
          const injected =
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "saveNotes" &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text !== "this";
          if (direct || injected) directCalls.push(file);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
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
      // Фолбэк импорта: единственная запись всей карты через внедрённую
      // зависимость. Reviewed-путь на случай, когда координатор в фоне не
      // отвечает; закрыт своими тестами.
      "src/popup/import-fallback.ts": 1,
    };
    expect(counted, "§4.3: new whole-map writer bypasses the single background queue").toEqual(allowed);
  });

  test("§4.3: палитру меток тоже пишет ТОЛЬКО координатор", () => {
    // У палитры с 28.08.2026 та же модель согласованности, что у карты
    // заметок: интент в единственную очередь. Но стража у неё не было —
    // новый писатель прошёл бы ревью бесшумно (adversarial 28.08.2026,
    // проверено диверсией: saveCustomTags из history-store не уронил ничего).
    //
    // Ловим оба способа записи: функцию хранилища и прямую запись элемента.
    const writers: string[] = [];
    for (const file of sourceFiles()) {
      if (file === "src/core/notes-store.ts") continue;
      const sf = parseTs(file);
      const aliases = new Set<string>();
      for (const st of sf.statements) {
        if (
          !ts.isImportDeclaration(st) ||
          !ts.isStringLiteral(st.moduleSpecifier) ||
          !st.moduleSpecifier.text.includes("notes-store")
        ) {
          continue;
        }
        const named = st.importClause?.namedBindings;
        if (!named || !ts.isNamedImports(named)) continue;
        for (const el of named.elements) {
          if ((el.propertyName ?? el.name).text === "saveCustomTags") aliases.add(el.name.text);
        }
      }
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (ts.isIdentifier(callee) && aliases.has(callee.text)) writers.push(file);
          // Прямая запись элемента хранилища: storage.local.set({ tagCustomColors })
          // или set(patch), где patch содержит ключ палитры.
          if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "set" &&
            /storage\.(local|sync)/.test(callee.expression.getText(sf))
          ) {
            const arg = node.arguments[0];
            const text = arg ? arg.getText(sf) : "";
            if (/TAGS_KEY|tagCustomColors/.test(text)) writers.push(file);
            // Запись через собранный ПАТЧ: `patch[TAGS_KEY] = …; set(patch)`.
            // Прямого упоминания ключа в аргументе нет, но писатель настоящий.
            if (
              arg &&
              ts.isIdentifier(arg) &&
              new RegExp(`${arg.text}\\[(?:TAGS_KEY|"tagCustomColors")\\]\\s*=`).test(
                sf.getFullText(),
              )
            ) {
              writers.push(file);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    const counted = writers.reduce<Record<string, number>>((acc, file) => {
      acc[file] = (acc[file] ?? 0) + 1;
      return acc;
    }, {});
    expect(counted, "новый писатель палитры мимо координатора").toEqual({
      "src/background/notes-coordinator.ts": 1,
      // Фолбэк осиротевшей вкладки: фон не ответил (MV3 выгружает воркер).
      // Санитайзер и потолок там те же, что у координатора.
      "src/content/features/player-notes/notes-model.ts": 1,
      // Импорт бэкапа в попапе: пишет патч настроек целиком, вместе с
      // палитрой. ЗНАЕМ и держим как reviewed-путь — карта заметок из того
      // же обработчика уже ходит через координатор (notes_merge).
      "src/popup/index.ts": 1,
    });
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
    // вынесла бы креды («ws://user:pass@host») в облачную синхронизацию.
    //
    // Разбор ДЕРЕВА, а не текста: прежняя регулярка видела только литеральный
    // объект прямо в вызове (`set({ obs_host: x })`) и была слепа к
    // `const patch = { obs_host: x }; set(patch)`. Хуже — амнистия давалась по
    // ТЕКСТОВОЙ БЛИЗОСТИ слова «sanitizeObsHost» в ±400 символах: годился
    // комментарий или чужой соседний вызов. Это одно из двух мест, где промах
    // = утечка кредов, поэтому здесь строгие правила (внешний аудит
    // 28.08.2026).
    //
    // Законно ровно одно: значение, которое ПРЯМО В ЭТОМ выражении прошло
    // sanitizeObsHost(...), либо переменная, присвоенная его результатом.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const sf = parseTs(file);
      const source = read(file);
      // Переменные, чьё значение — результат санитайзера.
      const sanitized = new Set<string>();
      const collect = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer &&
          /sanitizeObsHost\s*\(/.test(node.initializer.getText(sf)) &&
          ts.isIdentifier(node.name)
        ) {
          sanitized.add(node.name.text);
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          /sanitizeObsHost\s*\(/.test(node.right.getText(sf)) &&
          ts.isIdentifier(node.left)
        ) {
          sanitized.add(node.left.text);
        }
        ts.forEachChild(node, collect);
      };
      collect(sf);

      /** Значение под ключом obs_host в объекте — безопасно ли оно. */
      const valueIsSafe = (expr: ts.Expression): boolean => {
        const text = expr.getText(sf);
        if (/sanitizeObsHost\s*\(/.test(text)) return true;
        return ts.isIdentifier(expr) && sanitized.has(expr.text);
      };

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const isStorageSet =
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "set" &&
            /storage\.(sync|local)/.test(callee.expression.getText(sf));
          if (isStorageSet) {
            const arg = node.arguments[0];
            // Литеральный объект: смотрим само значение ключа.
            if (arg && ts.isObjectLiteralExpression(arg)) {
              for (const prop of arg.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  prop.name.getText(sf).replace(/["']/g, "") === "obs_host" &&
                  !valueIsSafe(prop.initializer)
                ) {
                  const { line } = sf.getLineAndCharacterOfPosition(prop.getStart(sf));
                  offenders.push(`${file}:${line + 1} → сырой obs_host в storage.set`);
                }
              }
            }
            // Патч-переменная: ключ мог быть положен в неё выше по файлу.
            if (arg && ts.isIdentifier(arg)) {
              const assign = new RegExp(`${arg.text}(?:\\.obs_host|\\["obs_host"\\])\\s*=\\s*([^;\n]+)`);
              const m = assign.exec(source);
              if (m && !/sanitizeObsHost/.test(m[1]) && !sanitized.has(m[1].trim())) {
                const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
                offenders.push(`${file}:${line + 1} → obs_host в патч-объекте мимо санитайзера`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(offenders, "obs_host мимо setSettings/санитайзера — креды уедут в облако").toEqual([]);
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
    for (const file of sourceFiles("src/content/features/**/*.ts")) {
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
    // резолв ключей, статистику, стили и весь UI сразу. Двенадцать модулей
    // вынесено (4326 → 2381); потолок стоит
    // не ради красивой цифры, а чтобы следующая подсистема заводилась
    // отдельным модулем, а не «ещё одной тысячей строк здесь».
    //
    // Потолок можно ОПУСКАТЬ свободно. Поднимать — только осознанно, вместе
    // с объяснением, почему подсистема неотделима.
    const CAP = 2340;
    const lines = read("src/content/features/player-notes.ts").split("\n").length;
    expect(
      lines,
      `player-notes.ts ${lines} строк при потолке ${CAP}: выдели подсистему в ./player-notes/*`,
    ).toBeLessThanOrEqual(CAP);
  });

  test("селекторы сайта живут ТОЛЬКО в selectors.ts", () => {
    // Обещание selectors.ts: «при редизайне polemicagame.com правится ТОЛЬКО
    // этот файл». Страж трижды оказывался слабее обещания: сначала не видел
    // классы в константах, потом дженерик-вызовы, потом (adversarial
    // 28.08.2026) — шаблонные строки, массивы, поля классов и, главное,
    // ЦЕЛУЮ строку вместо её частей: `".participants-item, .pn-x"` проходил,
    // потому что где-то в конце стоял наш префикс.
    //
    // Поэтому правило смотрит не на форму записи и не на строку целиком, а
    // на КАЖДЫЙ класс в КАЖДОМ строковом литерале файла — включая шаблонные
    // (в них живут CSS-блоки, где знание о чужой вёрстке ровно такое же).
    // «Наше» — не список префиксов на глаз, а РЕЕСТР собственных классов
    // (OWN в selectors.ts) плюс наши префиксы. Реестр читается из исходника:
    // добавили свой элемент — страж узнаёт о нём сам.
    // ТОЛЬКО блок OWN: прежняя регулярка шла по всему файлу и подбирала
    // заодно значения SITE_CLASS — то есть имена классов САЙТА объявлялись
    // «нашими», и страж молчал на них (поймано мутацией при закрытии
    // техдолга 28.08.2026).
    const ownSource = read("src/core/selectors.ts");
    const ownBlock = ownSource.slice(
      ownSource.indexOf("export const OWN = {"),
      ownSource.indexOf("} as const;", ownSource.indexOf("export const OWN = {")),
    );
    const ownNames = new Set(
      [...ownBlock.matchAll(/^\s*(?:\w+): "([a-z][\w-]*)",/gm)].map((m) => m[1]),
    );
    // «Наше» — узкий список НАШИХ префиксов плюс реестр OWN. Раньше сюда
    // входил голый `player`, и он отбеливал классы САЙТА `player__info`,
    // `player__role` (найдено при закрытии техдолга 28.08.2026).
    const OURS = /^(pn|polemica|fp|ss|twitch|obs|enhanced|session-stats)[-_]|^pn$/;
    /** Не селекторы: расширения файлов, домены, свойства промисов. */
    const NOT_SELECTORS = new Set([
      "json", "txt", "zip", "xpi", "css", "html", "js", "ts", "md", "png", "svg", "log",
      "com", "org", "net", "ru", "io", "dev", "local", "then", "catch", "finally",
      "polemicagame", "github", "twitch", "mozilla",
    ]);
    /**
     * Файлы, где мы СТИЛИЗУЕМ разметку сайта своим CSS. Это тоже знание о
     * чужой вёрстке, но живёт оно в правилах стилей, а не в запросах: при
     * редизайне такой блок не бросает исключение, он просто перестаёт
     * применяться. Прятать это в общем правиле нечестно, поэтому список
     * поимённый — он же чек-лист «что проверить после редизайна сайта».
     *
     * Правило остаётся жёстким для ЗАПРОСОВ: querySelector и компания в этих
     * файлах всё равно обязаны ходить через SITE.
     */
    const SITE_CSS = new Set([
      "src/content/features/auto-start.ts", // скрытие ролей на плитках
      "src/content/features/nick-plate.ts", // сворачивание ников
      "src/content/features/match-stats.ts", // таблица разбора матча
      "src/content/features/player-notes.ts", // страница матча
      "src/content/features/tooltip.ts", // тултипы поверх узлов сайта
      "src/content/features/controls-safety.ts", // порядок кнопок в контролах
      "src/content/panels/obs-panel.ts", // подсветка активной сцены
    ]);
    /** Классы САЙТА, которые мы обязаны знать вне реестра — с объяснением. */
    const EXEMPT: Record<string, string[]> = {
      // Наша разметка с общими именами: узлы создаёт сам код расширения.
      "src/content/features/match-stats.ts": [
        "row", "cell", "title", "table", "phase-row", "detail", "header", "sticky",
      ],
      "src/content/features/tooltip.ts": ["player-name", "player-number", "player-info"],
    };

    const offenders: string[] = [];
    for (const file of sourceFiles("src/**/*.ts")) {
      if (file === "src/core/selectors.ts") continue;
      // Попап — НАШ документ (src/static/popup.html), а не страница сайта.
      if (file.startsWith("src/popup/")) continue;
      const sf = parseTs(file);
      const seen = new Set<string>();
      const check = (node: ts.Node, text: string): void => {
        // URL — не селектор: домен в адресе даёт ложные «.polemicagame».
        if (/\w+:\/\//.test(text)) return;
        // Блок CSS в разрешённом файле: знание признано и перечислено выше.
        if (SITE_CSS.has(file) && /\{[^}]*:[^}]*\}/s.test(text)) return;
        // Классы: `.foo-bar` в любом месте строки (селектор, список, CSS).
        for (const m of text.matchAll(/\.([a-zA-Z][\w-]{2,})/g)) {
          const cls = m[1];
          if (NOT_SELECTORS.has(cls.toLowerCase())) continue;
          if (OURS.test(cls) || ownNames.has(cls)) continue;
          if (EXEMPT[file]?.includes(cls)) continue;
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const key = `${file}:${line + 1} → .${cls}`;
          if (seen.has(key)) continue;
          seen.add(key);
          offenders.push(key);
        }
      };
      const visit = (node: ts.Node): void => {
        // ИМЕНА классов в classList: знание о вёрстке без точки, поэтому
        // общий разбор литералов его не видит. Реестр — SITE_CLASS
        // (внешний аудит 28.08.2026: 18 таких мест жили мимо правила).
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          /^(contains|add|remove|toggle)$/.test(node.expression.name.text) &&
          /classList$/.test(node.expression.expression.getText(sf))
        ) {
          for (const arg of node.arguments) {
            if (!ts.isStringLiteral(arg)) continue;
            const cls = arg.text;
            if (OURS.test(cls) || ownNames.has(cls) || EXEMPT[file]?.includes(cls)) continue;
            const { line } = sf.getLineAndCharacterOfPosition(arg.getStart(sf));
            offenders.push(`${file}:${line + 1} → classList «${cls}»`);
          }
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          check(node, node.text);
        } else if (ts.isTemplateExpression(node)) {
          // Шаблон с подстановками: проверяем статические куски — именно в
          // них живут классы (`.player__role[data-x="${id}"]`).
          check(node, node.head.text + node.templateSpans.map((sp) => sp.literal.text).join(" "));
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    // CSS, который едет в дистрибутив: там знание о чужой вёрстке в самом
    // хрупком виде — scoped-хеш Vue-компонента сайта. Файл не сканировался
    // ничем (внешний аудит 28.08.2026), поэтому здесь он хотя бы ПЕРЕЧИСЛЕН:
    // список — чек-лист «что проверить после редизайна».
    const cssKnown: Record<string, string[]> = {
      "src/static/notes.css": [
        // Разметка САЙТА, на которую мы вешаем свои правила.
        "player__video-wrapper",
        "player__info",
        "player__botleftmenu",
        "player",
        // НАША разметка с общими именами: внутри .player-stats / .pn-tooltip.
        "player-icons",
        "mmr",
        "games",
        "winrate",
        "kills",
        "tooltip-text",
      ],
    };
    for (const [file, known] of Object.entries(cssKnown)) {
      const css = read(file);
      // ВСЕ классы файла — по ним же проверяем устаревание списка.
      const all = new Set([...css.matchAll(/\.([a-zA-Z][\w-]{2,})/g)].map((m) => m[1]));
      const unknown = [...all].filter(
        (cls) =>
          !known.includes(cls) && !OURS.test(cls) && !ownNames.has(cls) && !NOT_SELECTORS.has(cls),
      );
      expect(unknown, `${file}: новый класс сайта в CSS дистрибутива — впиши его в список`).toEqual(
        [],
      );
      const stale = known.filter((cls) => !all.has(cls));
      expect(stale, `${file}: класс из списка больше не используется — убери`).toEqual([]);
    }

    expect(
      offenders,
      "класс сайта вне selectors.ts: при редизайне его никто не найдёт — заведи ключ в SITE",
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
    // Файл лога человек пересылает в поддержку — секрет в нём это утечка.
    // Раньше вызов разбирался по AST, а АРГУМЕНТЫ проверялись регуляркой по
    // тексту вызова: `const p = settings.obs_password; log.info("obs", p)` и
    // `const l = log; l.info(…, settings.obs_password)` проходили насквозь
    // (внешний аудит 28.08.2026). Теперь по дереву проверяется и то, и другое.
    const SECRET = /obs_password|authKey|current-user/i;
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      const sf = parseTs(file);
      /** Переменные, в которых лежит секрет. */
      const secretVars = new Set<string>();
      /** Имена, под которыми доступен логгер (`const l = log`). */
      const logNames = new Set(["log"]);
      const collect = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
          const init = node.initializer.getText(sf);
          if (SECRET.test(init)) secretVars.add(node.name.text);
          if (/^log$/.test(init.trim())) logNames.add(node.name.text);
        }
        // Деструктуризация секрета: `const { obs_password } = settings`.
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const name = (el.propertyName ?? el.name).getText(sf);
            if (SECRET.test(name) && ts.isIdentifier(el.name)) secretVars.add(el.name.text);
          }
        }
        ts.forEachChild(node, collect);
      };
      collect(sf);

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          logNames.has(node.expression.expression.text)
        ) {
          const leaks = node.arguments.some((arg) => {
            if (SECRET.test(arg.getText(sf))) return true;
            return ts.isIdentifier(arg) && secretVars.has(arg.text);
          });
          if (leaks) {
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
      // 3 → 2 при переходе на счёт по дереву (28.08.2026): один «таймер»
      // был словом в строке/комментарии, а не вызовом.
      timers: 2,
      reason: "timeline row listeners are removed with nodes; timers are tracked in module sets",
    },
    // Диалоги: обработчики висят на УЗЛАХ САМОГО ОКНА и умирают вместе с
    // overlay.remove() в close(); единственный документный слушатель
    // (keydown capture) снимается там же явно. Числа точные: новый
    // несимметричный слушатель здесь уронит инвариант.
    "src/content/features/player-notes/nick-color-manager.ts": {
      listeners: 17,
      timers: 0,
      reason: "modal handlers die with the overlay; the document keydown capture is removed in close()",
    },
    "src/content/features/player-notes/note-modal.ts": {
      listeners: 7,
      timers: 0,
      reason: "modal handlers die with the overlay; the document keydown capture is removed in close()",
    },
    "src/content/features/player-notes.ts": {
      // 36 → 12 после сегрегации 28.08.2026: обработчики диалогов уехали в
      // ./player-notes/note-modal и ./player-notes/nick-color-manager, и
      // сканируются теперь там же (glob включает подпапки).
      listeners: 12,
      timers: 1,
      reason:
        "button handlers are removed with owned nodes; toast removal is a harmless one-shot; " +
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

  test("§4.7: пауза проходов наблюдателя всегда снимается", () => {
    // suspendDomPasses(true) без парного false «выключает» расширение до
    // перезагрузки страницы: подписчики перестают видеть стол. Симметрия
    // важнее места — считаем по файлу (закрытие техдолга 28.08.2026).
    for (const file of sourceFiles()) {
      const source = read(file);
      const on = count(source, /suspendDomPasses\(true\)/g);
      const off = count(source, /suspendDomPasses\(false\)/g);
      if (on === 0 && off === 0) continue;
      expect(
        off,
        `${file}: пауза проходов ставится ${on} раз, снимается ${off} — жест обязан её отпустить`,
      ).toBeGreaterThanOrEqual(on);
    }
  });

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
    // ** и подпапки: после сегрегации player-notes (28.08.2026) диалоги и
    // сторы живут в features/player-notes/*. Плоский glob их НЕ ВИДЕЛ, и
    // квота «36 → 12» была фиктивной: 24 несимметричных слушателя вышли
    // из-под инварианта не потому, что получили teardown, а потому, что
    // переехали в подпапку (adversarial 28.08.2026, находка 1).
    for (const file of sourceFiles("src/content/features/**/*.ts")) {
      // Счёт по ДЕРЕВУ, а не по тексту: комментарий со словом
      // removeEventListener уменьшал дельту и выдавал бесплатную квоту, а
      // строка в шаблоне могла «добавить» несуществующий слушатель (внешний
      // аудит 28.08.2026). Идентичность колбэка это по-прежнему не
      // доказывает — но считает ровно вызовы, а не буквы.
      const sf = parseTs(file);
      const calls = { add: 0, remove: 0, set: 0, clear: 0 };
      const countCalls = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const name = ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : ts.isIdentifier(callee)
              ? callee.text
              : "";
          if (name === "addEventListener") calls.add++;
          else if (name === "removeEventListener") calls.remove++;
          else if (name === "setTimeout" || name === "setInterval") calls.set++;
          else if (name === "clearTimeout" || name === "clearInterval") calls.clear++;
        }
        ts.forEachChild(node, countCalls);
      };
      countCalls(sf);
      const listenerDelta = Math.max(0, calls.add - calls.remove);
      const timerDelta = Math.max(0, calls.set - calls.clear);
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
