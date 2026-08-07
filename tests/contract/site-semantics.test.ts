import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import siteFixture from "../fixtures/site-contract.json";
import {
  gameSearchProbes,
  roomProbes,
  ruLocaleProbes,
  runProbes,
  siteCssProbes,
  siteRollerAnimationMs,
  missingIconHashes,
} from "./semantic-probes";
import { TransientNetworkError, download } from "./fetch";

/**
 * Живая половина семантического контракта (аудит хрупкости 06.08.2026).
 *
 * site-contract.test.ts отвечает на вопрос «строка/класс ещё существуют»;
 * этот файл — на вопрос недели всех жалоб: «означают ли они всё ещё те
 * СОСТОЯНИЯ, которые мы им приписываем». Пробы чистые и мутационно
 * проверены офлайн (tests/unit/semantic-probes.test.ts) на реальных
 * фрагментах — здесь они применяются к свежескачанным бандлам.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("живые семантические контракты бандлов", () => {
  test("состояния, ветки и матрицы кнопок означают то, что мы им приписываем", async ({
    skip,
  }) => {
    let gs: string, room: string, ru: string, css: string;
    try {
      [gs, room, ru, css] = (
        await Promise.all([
          download(siteFixture.bundles.gameSearch.url),
          download(siteFixture.bundles.roomMain.url),
          download(siteFixture.bundles.localeRu.url),
          // Стили — такой же внешний контракт, как бандл: раскладка нашей
          // таблицы фаз держится на scoped-правилах сайта (жалоба 07.08.2026).
          download(siteFixture.bundles.mainCss.url),
        ])
      ).map((d) => d.text);
    } catch (error) {
      if (error instanceof TransientNetworkError) skip(`site unavailable: ${error}`);
      throw error;
    }

    const failed = [
      ...runProbes(gameSearchProbes, gs).map((r) => ({ ...r, bundle: "game-search" })),
      ...runProbes(roomProbes, room).map((r) => ({ ...r, bundle: "room-main" })),
      ...runProbes(ruLocaleProbes, ru).map((r) => ({ ...r, bundle: "RU" })),
      ...runProbes(siteCssProbes, css).map((r) => ({ ...r, bundle: "main.css" })),
    ].filter((r) => !r.ok);
    expect(
      failed,
      "Семантика сайта уехала:\n" + failed.map((f) => `${f.bundle}/${f.name}: ${f.detail}`).join("\n"),
    ).toEqual([]);

    // Тайминг: подтверждение фазы OBS обязано быть ДЛИННЕЕ анимации перехода
    // роллера — иначе confirm ловит переходный DOM (аудит, раздел 7).
    const siteMs = siteRollerAnimationMs(room);
    expect(siteMs, "длительность анимации роллера не извлеклась").not.toBeNull();
    const obsSource = fs.readFileSync(
      path.join(ROOT, "src/content/panels/obs-panel.ts"),
      "utf8",
    );
    // Литерал подтверждения пригвождён к исходнику: если constant уедет, эта
    // сверка перестанет отражать реальность и обязана упасть.
    const EXT_CONFIRM_MS = 350;
    expect(
      obsSource.includes(`}, ${EXT_CONFIRM_MS});`),
      `в obs-panel.ts не найден литерал подтверждения ${EXT_CONFIRM_MS} — обнови сверку`,
    ).toBe(true);
    expect(EXT_CONFIRM_MS, "confirm OBS должен переживать анимацию роллера").toBeGreaterThan(
      (siteMs as number) + 50,
    );

    // Хэши иконок камеры/микрофона/настроек из auto-start обязаны существовать
    // в живом бандле: пропавший хэш = позиционный fallback = риск клика не по
    // той кнопке (аудит, P0 «Camera/F8»).
    const autoStart = fs.readFileSync(
      path.join(ROOT, "src/content/features/auto-start.ts"),
      "utf8",
    );
    const hashes = [...autoStart.matchAll(/"([0-9a-f]{20})"/g)].map((m) => m[1]);
    expect(hashes.length, "в auto-start.ts не нашлись хэши иконок").toBeGreaterThanOrEqual(5);
    expect(
      missingIconHashes(room, hashes),
      "хэш иконки пропал из бандла комнаты — сверь назначение кнопок",
    ).toEqual([]);
  });
});
