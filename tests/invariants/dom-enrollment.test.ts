/**
 * Зачисление DOM-подписчиков в fixpoint-контур (ревью доказуемости
 * 26.08.2026): новая подписка onDomChange НЕ проходит молча — файл обязан
 * быть либо покрыт сценарием в dom-fixpoint.test.ts, либо стоять в списке
 * reviewed-исключений с причиной. Список точный: устаревшая запись
 * (файл покрылся/перестал подписываться) тоже роняет тест — как §4.7.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Срезать // и /* … *​/ — упоминание в комментарии не считается кодом. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Файлы src/content/**, реально зовущие onDomChange( в КОДЕ (не в
 * комментариях — adversarial 26.08.2026, обход №2). Известное ограничение:
 * подписку через обёртку с другим именем статический скан не увидит —
 * обёрток сейчас нет, появление новой = правка @core/dom, которую сторожит
 * §4.1-пин единственного MutationObserver.
 */
function domSubscribers(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (
        name.endsWith(".ts") &&
        stripComments(fs.readFileSync(p, "utf8")).includes("onDomChange(")
      ) {
        out.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, "src/content"));
  return out.sort();
}

/**
 * Покрытие — только ЖИВОЙ import-стейтмент в харнесе: закомментированный
 * импорт и vi.mock(«путь») покрытием не считаются (adversarial 26.08.2026,
 * обход №1).
 */
function coveredByFixpoint(): Set<string> {
  const harness = stripComments(
    fs.readFileSync(path.join(ROOT, "tests/invariants/dom-fixpoint.test.ts"), "utf8"),
  );
  const covered = new Set<string>();
  for (const file of domSubscribers()) {
    const moduleName = path.basename(file, ".ts");
    const importRe = new RegExp(`^import[^;]*from "[^"]*/${moduleName}";`, "m");
    if (importRe.test(harness)) covered.add(file);
  }
  return covered;
}

/**
 * Reviewed-исключения: подписчик прочитан, его записи в DOM идемпотентны по
 * построению (маркер/сравнение перед записью) или подписчик в DOM не пишет.
 * Причина обязательна — «потом добавим» здесь не живёт.
 */
const EXEMPT: Record<string, string> = {
  "src/content/features/auto-start.ts":
    "кликает по кнопкам сайта и мутирует стили ролей через applyRolePhase — с латч-гейтами применённого состояния; своих узлов не создаёт",
  "src/content/features/camera-health.ts":
    "бейдж/кнопка пишутся с маркер-гейтами (data-атрибуты), покрыто идемпотентность-тестами файла",
  "src/content/features/controls-safety.ts":
    "держит <style> (сравнение textContent перед записью) и классы-метки с contains-гейтами; узлы не переставляет",
  "src/content/features/hotkey-hints.ts":
    "подпись клавиши пишется только при отличии текста (сравнение перед записью)",
  "src/content/features/match-stats.ts":
    "обогащение таблицы разбора однократное, помечено классом-маркером; route-lifecycle гасит повтор",
  "src/content/features/nick-plate.ts":
    "paintNickEl — эталон идемпотентности §4.1 (сравнение data-маркера перед записью)",
  "src/content/features/player-notes.ts":
    "страховочный проход целиком на маркер-гейтах (data-pn-*); кандидат №1 на сценарий при следующем касании файла",
  "src/content/features/postgame-search.ts":
    "подписчик кликает по кнопкам сайта, собственных узлов не пишет",
  "src/content/features/queue-guard.ts":
    "подписчик читает состояние очереди и шлёт сообщения фону, DOM не пишет",
  "src/content/features/queue-peek.ts":
    "гейты: существование кнопки, позиция у якоря, сравнение style.display перед записью",
  "src/content/features/queue-requeue.ts":
    "подписчик детектит развал лобби и кликает, собственных узлов не пишет",
  "src/content/features/role-faker.ts":
    "оверлей ролей ключуется маркером и пересоздаётся только при смене состояния",
  "src/content/features/role-marker.ts":
    "paintKey-гейт: маркер пишется только при смене ключа вида (роль+режим)",
  "src/content/features/tooltip.ts":
    "чистит свои осиротевшие тултипы + enhanceTooltip пишет removeAttribute(title) под WeakSet-гейтом processed",
  "src/content/panels/obs-panel.ts":
    "детектор фаз читает DOM; записи стилей ролей и показ панели — под латчами (lastAppliedRoleVisibility, isVisible) и дебаунсом 500 мс",
  "src/content/panels/twitch-panel.ts":
    "сверка видимости дебаунсится и вызывает show/hide только на смене состояния (гейт isShown)",
};

describe("зачисление DOM-подписчиков (§4, механика 26.08.2026)", () => {
  test("каждая onDomChange-подписка либо в fixpoint-харнесе, либо в reviewed-исключениях", () => {
    const covered = coveredByFixpoint();
    const unenrolled = domSubscribers().filter((f) => !covered.has(f) && !(f in EXEMPT));
    expect(
      unenrolled,
      "новый DOM-подписчик: добавь сценарий в dom-fixpoint.test.ts или reviewed-исключение с причиной",
    ).toEqual([]);
  });

  test("список исключений точный: покрытые и отписавшиеся файлы из него уходят", () => {
    const covered = coveredByFixpoint();
    const subscribers = new Set(domSubscribers());
    const stale = Object.keys(EXEMPT).filter((f) => covered.has(f) || !subscribers.has(f));
    expect(stale, "устаревшее исключение — убери строку, список должен быть честным").toEqual([]);
  });

  test("харнес реально покрывает хотя бы то, что обещает", () => {
    // Страж стража: если dom-fixpoint переименуют/выпотрошат, «покрытие»
    // не должно молча стать пустым при зелёном зачислении.
    expect([...coveredByFixpoint()]).toEqual([
      "src/content/features/profile-crossover.ts",
      "src/content/features/profile-mmr-chart.ts",
    ]);
  });
});
