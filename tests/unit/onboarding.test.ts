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
import { isFreshInstall, onboardingUpdateDecision } from "../../src/background/onboarding";

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
