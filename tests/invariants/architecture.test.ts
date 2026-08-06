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
      "src/content/features/player-notes.ts": 1,
      // Reviewed popup import fallback when the background coordinator has no receiver.
      "src/popup/index.ts": 1,
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
    expect(count(notesStore, /browser\.storage\.sync\.get\s*\(/g)).toBe(1);
    expect(count(notesStore, /browser\.storage\.local\.set\s*\(/g)).toBeGreaterThanOrEqual(3);
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
        owners.push(`${file}:${lineOf(source, match.index)}`);
      }
    }
    expect(owners, "§4.1: multiple observers recreate self-sustaining document-wide DOM loops").toEqual([
      "src/core/dom.ts:83",
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

  test("package and base manifest versions match", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const manifest = JSON.parse(read("src/manifest/manifest.base.json")) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.version).toBe(pkg.version);
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
    expect(source).toMatch(/void setSettings\(patch\)/);
    expect(source).not.toMatch(/await setSettings\(settings\)/);
    expect(source).toContain("onSettingsChanged(");
  });
});

describe("§4.7 lifecycle heuristic", () => {
  type Allowance = { listeners?: number; timers?: number; reason: string };
  const allowances: Record<string, Allowance> = {
    // Populated only for reviewed DOM-owned one-shot handlers/timers. Exact deltas make new tails fail.
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
      listeners: 34,
      timers: 1,
      reason: "modal/button handlers are removed with owned nodes; toast removal is a harmless one-shot",
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
