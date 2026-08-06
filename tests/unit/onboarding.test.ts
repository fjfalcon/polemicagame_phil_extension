import { describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    runtime: {
      id: "x",
      getManifest: () => ({ version: "9.5.0" }),
      getURL: (p: string) => `chrome-extension://x/${p}`,
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
    },
    tabs: { create: vi.fn(async () => ({})), onRemoved: { addListener: vi.fn() } },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: vi.fn() } },
    notifications: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setPersist: vi.fn() },
}));

import fs from "node:fs";
import {
  handleInstalled,
  isFreshInstall,
  onboardingUpdateDecision,
} from "../../src/background/onboarding";
import { browser } from "@core/env";

/**
 * Онбординг (жалоба 06.08.2026: стримеры не находят настройки). Закрепить
 * иконку ЗА пользователя браузер не позволяет — максимум честного: страница
 * при установке + разовая проверка isOnToolbar при обновлении + точка на
 * иконке. Правило «не наглеть»: не чаще одного раза за жизнь установки.
 */
describe("isFreshInstall", () => {
  test.each([
    ["install", true],
    ["update", false],
    ["chrome_update", false],
    [undefined, false],
  ])("reason=%s → %s", (reason, expected) => {
    expect(isFreshInstall(reason === undefined ? undefined : { reason })).toBe(expected);
  });
});

describe("onboardingUpdateDecision: обновление у живых пользователей", () => {
  test("не закреплено и ещё не показывали — показать (один раз)", () => {
    expect(onboardingUpdateDecision(false, false)).toBe("show");
  });

  test("уже показывали — никогда не навязывать повторно", () => {
    expect(onboardingUpdateDecision(true, false)).toBe("skip");
    expect(onboardingUpdateDecision(true, true)).toBe("skip");
  });

  test("иконка закреплена — запомнить и молчать навсегда", () => {
    expect(onboardingUpdateDecision(false, true)).toBe("remember-pinned");
  });

  test("getUserSettings недоступен (старый браузер) — не наглеем", () => {
    expect(onboardingUpdateDecision(false, undefined)).toBe("skip");
  });
});

describe("handleInstalled: проводка диспетчера", () => {
  // Ревью 06.08: мутант перестановки веток install/update в слушателе
  // проходил всю сюиту — третий подобный случай, поэтому диспетчер вынесен
  // в модуль и сторожится здесь.
  const tabs = () => vi.mocked(browser.tabs.create);
  const storage = () => vi.mocked(browser.storage.local.get);

  test("установка: вкладка открывается АКТИВНОЙ (пользователь в контексте стора)", async () => {
    tabs().mockClear();
    await handleInstalled({ reason: "install" });
    expect(tabs()).toHaveBeenCalledTimes(1);
    expect(tabs().mock.calls[0][0]).toMatchObject({ active: true });
  });

  test("обновление без закрепления: вкладка открывается ФОНОВОЙ — фокус у стримера в эфире красть нельзя", async () => {
    tabs().mockClear();
    storage().mockResolvedValueOnce({ onboarding_shown: false });
    (browser.action as Record<string, unknown>).getUserSettings = vi.fn(async () => ({
      isOnToolbar: false,
    }));
    await handleInstalled({ reason: "update" });
    expect(tabs()).toHaveBeenCalledTimes(1);
    expect(tabs().mock.calls[0][0]).toMatchObject({ active: false });
    delete (browser.action as Record<string, unknown>).getUserSettings;
  });

  test("обновление на старом браузере (нет getUserSettings) — тишина", async () => {
    tabs().mockClear();
    storage().mockResolvedValueOnce({ onboarding_shown: false });
    await handleInstalled({ reason: "update" });
    expect(tabs()).not.toHaveBeenCalled();
  });

  test("chrome_update — тишина", async () => {
    tabs().mockClear();
    await handleInstalled({ reason: "chrome_update" });
    expect(tabs()).not.toHaveBeenCalled();
  });
});

describe("страница онбординга", () => {
  test("существует, без инлайн-скриптов (CSP MV3), со ссылкой на диагностику", () => {
    const html = fs.readFileSync("src/static/onboarding.html", "utf8");
    expect(html).toContain('src="onboarding.js"');
    expect(html, "инлайн-скрипты запрещены CSP страниц расширения").not.toMatch(
      /<script>[^<]/,
    );
    expect(html).toContain("Диагностика");
    expect(fs.existsSync("src/static/onboarding.js")).toBe(true);
  });
});
