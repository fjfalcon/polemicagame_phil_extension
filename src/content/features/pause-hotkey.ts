/**
 * Пауза игры по F8: открыть меню настроек → найти кнопку паузы → клик → закрыть меню.
 * Порт pause-hotkey.js на единый keyboard-роутер. (Мёртвый autoJoinLobby не переносится.)
 */
import { keyboard } from "@core/keyboard";
import { isVisible } from "@core/dom";
import { SITE } from "@core/selectors";
import type { Feature, FeatureContext } from "@core/feature";

const TEXT = {
  settingsRu: "настро",
  closeRu: "закр",
  notFound: "Не нашёл кнопку паузы",
  unavailable: "Пауза сейчас недоступна",
};

const norm = (v: unknown) => (v ?? "").toString().toLowerCase().replace(/\s+/g, " ").trim();
const PAUSE_ACTIONS = new Set([
  "пауза",
  "пауза игры",
  "поставить на паузу",
  "снять с паузы",
  "перерыв",
  "pause",
  "pause game",
  "break",
  "продолжить",
  "продолжить игру",
  "возобновить",
  "возобновить игру",
  "resume",
  "resume game",
]);
const CLICKABLE_SELECTOR =
  'button, [role="button"], [role="menuitem"], li, a, div.button, .button, .button-comp, .base-menu__item';
const MENU_SELECTOR =
  '.game-room__settings, .base-menu, .base-menu__list, .base-menu__content, .dropdown-menu, .context-menu, [role="menu"], [class*="menu"]';
const OWNING_MENU_SELECTOR =
  '.game-room__settings, .base-menu, .dropdown-menu, .context-menu, [role="menu"]';

interface OpenedMenu {
  opener: Element;
  roots: Element[];
}

class PauseHotkey {
  private handling = false;
  private disposed = false;
  private sleeps = new Set<{
    id: ReturnType<typeof setTimeout>;
    resolve: (active: boolean) => void;
  }>();
  private notifications = new Set<HTMLElement>();
  private initialVisibleMenus = new Set<Element>();
  private activeOpener: Element | null = null;
  private activeMenuObserved = false;
  private closingMenu = false;

  private clickableFrom(node: Element | null): Element | null {
    if (!node || typeof node.closest !== "function") return node;
    return (
      node.closest(CLICKABLE_SELECTOR) || node
    );
  }

  private iconHref(node: Element | null): string {
    const img = node?.querySelector?.("img.button__icon") as HTMLImageElement | null;
    const use = node?.querySelector?.("use");
    return norm(
      img?.getAttribute?.("src") ||
        img?.src ||
        use?.getAttribute?.("href") ||
        use?.getAttribute?.("xlink:href") ||
        "",
    );
  }

  private matchesSettingsIcon(node: Element): boolean {
    const h = this.iconHref(node);
    if (!h) return false;
    return ["#settings", "#setting", "#gear", "#cog", "#menu", "#more", "#options", "#option", "#dots", "#ellipsis", "e3a7cf4ee64b975985ad.svg"].some(
      (m) => h.includes(m),
    );
  }

  private matchesSettings(node: Element): boolean {
    const text = norm(node?.textContent);
    const label = norm(`${node?.getAttribute?.("aria-label") || ""} ${node?.getAttribute?.("title") || ""}`);
    const cls = norm((node as HTMLElement)?.className?.toString?.() || "");
    return (
      text.includes(TEXT.settingsRu) ||
      label.includes(TEXT.settingsRu) ||
      label.includes("setting") ||
      cls.includes("setting") ||
      cls.includes("settings") ||
      cls.includes("gear") ||
      cls.includes("cog")
    );
  }

  private matchesPause(node: Element): boolean {
    const text = norm(node?.textContent);
    const ariaLabel = norm(node?.getAttribute?.("aria-label"));
    const title = norm(node?.getAttribute?.("title"));
    return (
      PAUSE_ACTIONS.has(text) ||
      PAUSE_ACTIONS.has(ariaLabel) ||
      PAUSE_ACTIONS.has(title)
    );
  }

  private isNavigatingAnchor(node: Element): boolean {
    return node.closest("a[href]") !== null;
  }

  private hasGameContext(): boolean {
    return (
      document.querySelectorAll(SITE.player).length >= 8 &&
      !!document.querySelector(SITE.settingsButton)
    );
  }

  private notify(message: string) {
    if (this.disposed) return;
    const n = document.createElement("div");
    n.style.cssText =
      "position:fixed;top:20px;right:20px;background:rgba(255,152,0,.9);color:#fff;padding:12px 24px;border-radius:8px;z-index:2147483600;box-shadow:0 4px 6px rgba(0,0,0,.1);font-size:14px";
    n.textContent = message;
    document.body.appendChild(n);
    this.notifications.add(n);
    void this.sleep(3000).then(() => {
      n.remove();
      this.notifications.delete(n);
    });
  }

  private sleep(ms: number): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return new Promise((resolve) => {
      let pending: { id: ReturnType<typeof setTimeout>; resolve: (active: boolean) => void };
      const id = setTimeout(() => {
        this.sleeps.delete(pending);
        resolve(!this.disposed);
      }, ms);
      pending = { id, resolve };
      this.sleeps.add(pending);
    });
  }

  private async waitFor<T>(
    check: () => T | null,
    timeoutMs = 1800,
    intervalMs = 60,
  ): Promise<T | null> {
    const start = Date.now();
    while (!this.disposed) {
      const result = check();
      if (result) return result;
      if (Date.now() - start >= timeoutMs || !(await this.sleep(intervalMs))) return null;
    }
    return null;
  }

  private getSettingsButtons(): Element[] {
    const direct = [
      '.button.preset-1.small.desktop-version img.button__icon[src*="e3a7cf4ee64b975985ad.svg"]',
      '.button.preset-1.small.desktop-version svg use[href*="#settings"]',
      '.button.preset-1.small.desktop-version svg use[xlink\\:href*="#settings"]',
      'img.button__icon[src*="e3a7cf4ee64b975985ad.svg"]',
      'use[href*="#settings"]',
      'use[xlink\\:href*="#settings"]',
      '[class*="settings"]',
      '[class*="gear"]',
      '[class*="cog"]',
      'button[aria-label*="setting"]',
      'button[title*="setting"]',
    ];
    const out: Element[] = [];
    const seen = new Set<Element>();
    const push = (node: Element | null) => {
      const c = this.clickableFrom(node);
      if (
        !c ||
        seen.has(c) ||
        !isVisible(c) ||
        this.isNavigatingAnchor(c) ||
        !!c.querySelector("a[href]")
      ) {
        return;
      }
      seen.add(c);
      out.push(c);
    };
    for (const s of direct) push(document.querySelector(s));
    Array.from(document.querySelectorAll('button, [role="button"], .button, .button-comp, li, a, div'))
      .filter((n) => this.matchesSettings(n) || this.matchesSettingsIcon(n))
      .forEach(push);
    Array.from(
      document.querySelectorAll(
        ".button.preset-1.small.desktop-version, button.preset-1.small.desktop-version, div.button.preset-1.small.desktop-version",
      ),
    )
      .filter((n) => this.matchesSettingsIcon(n))
      .forEach(push);
    return out;
  }

  private getMenuRoots(): Element[] {
    return Array.from(document.querySelectorAll(MENU_SELECTOR));
  }

  private getPauseButton(onlyMenuRoots = false): Element | null {
    if (!onlyMenuRoots) {
      for (const s of ['use[href*="#pause"]', 'use[xlink\\:href*="#pause"]']) {
        const c = this.clickableFrom(document.querySelector(s));
        if (c && !this.isNavigatingAnchor(c) && isVisible(c)) return c;
      }
    }
    const roots = onlyMenuRoots ? this.getMenuRoots() : [...this.getMenuRoots(), document.body];
    for (const root of roots) {
      const found = Array.from(root.querySelectorAll(CLICKABLE_SELECTOR)).find(
        (candidate) =>
          !this.isNavigatingAnchor(candidate) &&
          !candidate.querySelector("a[href]") &&
          isVisible(candidate) &&
          this.matchesPause(candidate) &&
          !Array.from(candidate.querySelectorAll(CLICKABLE_SELECTOR)).some(
            (child) =>
              !this.isNavigatingAnchor(child) && isVisible(child) && this.matchesPause(child),
          ),
      );
      if (found) return found;
    }
    return null;
  }

  private isPauseDisabled(button: Element | null): boolean {
    if (!button) return false;
    const c = (this.clickableFrom(button) || button) as HTMLElement;
    return (
      c.classList?.contains("disabled") ||
      c.hasAttribute?.("disabled") ||
      c.getAttribute?.("aria-disabled") === "true" ||
      norm(c.className?.toString?.() || "").includes("disabled")
    );
  }

  private getCloseButton(root?: ParentNode): HTMLElement | null {
    const selectors = [".close", '[aria-label]', "button[title]"];
    const scopes = root ? [root] : this.getMenuRoots().filter((menu) => isVisible(menu));
    for (const scope of scopes) {
      for (const s of selectors) {
        const found = Array.from(scope.querySelectorAll<HTMLElement>(s)).find((n) => {
          const label = norm(`${n.getAttribute?.("aria-label") || ""} ${n.getAttribute?.("title") || ""}`);
          const scopeElement = scope as Element;
          const scopeOwner = scopeElement.matches(OWNING_MENU_SELECTOR)
            ? scopeElement
            : scopeElement.closest(OWNING_MENU_SELECTOR);
          const candidateOwner = n.closest(OWNING_MENU_SELECTOR);
          return (
            (candidateOwner ? candidateOwner === scopeOwner : !scopeOwner) &&
            isVisible(n) &&
            (label.includes(TEXT.closeRu) || label.includes("close"))
          );
        });
        if (found) return found;
      }
    }
    return null;
  }

  private dispatchClick(node: Element | null): boolean {
    if (this.disposed) return false;
    const target = this.clickableFrom(node);
    if (!target) return false;
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((name) =>
      target.dispatchEvent(new MouseEvent(name, { view: window, bubbles: true, cancelable: true })),
    );
    return true;
  }

  private targetedRoot(roots: Element[]): Element | null {
    const innerFirst = [...roots].sort((a, b) => {
      if (a.contains(b)) return 1;
      if (b.contains(a)) return -1;
      return 0;
    });
    return innerFirst.find((root) => this.getCloseButton(root)) || innerFirst[0] || null;
  }

  private owningMenu(node: Element): Element | null {
    return this.targetedRoot(
      this.getMenuRoots().filter((root) => isVisible(root) && root.contains(node)),
    );
  }

  private async closeOpenedMenu(menu: OpenedMenu): Promise<void> {
    const root = this.targetedRoot(menu.roots);
    if (!root || !isVisible(root)) return;
    const close = this.getCloseButton(root);
    this.closingMenu = true;
    if (close) {
      this.dispatchClick(close);
      await this.waitFor(
        () => (menu.roots.every((item) => !isVisible(item)) ? true : null),
        700,
        30,
      );
    } else {
      this.dispatchClick(menu.opener);
      await this.waitFor(
        () => (menu.roots.every((item) => !isVisible(item)) ? true : null),
        300,
        30,
      );
    }
    this.closingMenu = false;
  }

  private closeCurrentAutomatedMenu(): void {
    if (!this.activeOpener || this.closingMenu) return;
    const roots = this.getMenuRoots().filter(
      (root) => isVisible(root) && !this.initialVisibleMenus.has(root),
    );
    const outer = this.targetedRoot(roots);
    const close = outer ? this.getCloseButton(outer) : null;
    if (close) this.dispatchClick(close);
    else if (roots.length > 0 || !this.activeMenuObserved) this.dispatchClick(this.activeOpener);
  }

  private async ensureMenuOpen(): Promise<Element | null> {
    const existing = this.getPauseButton(true);
    if (existing) return existing;
    const buttons = this.getSettingsButtons();
    this.initialVisibleMenus = new Set(this.getMenuRoots().filter((root) => isVisible(root)));
    for (const b of buttons) {
      this.activeOpener = b;
      this.activeMenuObserved = false;
      this.dispatchClick(b);
      const pause = await this.waitFor(() => this.getPauseButton(true), 700, 50);
      if (this.disposed) return null;
      const roots = this.getMenuRoots().filter(
        (root) => isVisible(root) && !this.initialVisibleMenus.has(root),
      );
      if (roots.length > 0) this.activeMenuObserved = true;
      if (pause) {
        return pause;
      }
      if (roots.length > 0) {
        await this.closeOpenedMenu({ opener: b, roots: [...new Set(roots)] });
      }
    }
    this.activeOpener = null;
    return null;
  }

  async togglePause(): Promise<void> {
    if (this.handling || this.disposed) return;
    if (!this.hasGameContext()) return this.notify(TEXT.unavailable);
    this.handling = true;
    try {
      const pause = await this.ensureMenuOpen();
      if (this.disposed) return;
      if (!pause) return this.notify(TEXT.notFound);
      const menu = this.owningMenu(pause);
      if (this.isPauseDisabled(pause)) {
        this.dispatchClick(menu ? this.getCloseButton(menu) : null);
        return this.notify(TEXT.unavailable);
      }
      this.dispatchClick(pause);
      if (!(await this.sleep(120))) return;
      this.dispatchClick(menu && isVisible(menu) ? this.getCloseButton(menu) : null);
    } finally {
      if (!this.disposed) await this.sleep(250);
      this.activeOpener = null;
      this.activeMenuObserved = false;
      this.initialVisibleMenus.clear();
      this.handling = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.closeCurrentAutomatedMenu();
    this.disposed = true;
    for (const pending of this.sleeps) {
      clearTimeout(pending.id);
      pending.resolve(false);
    }
    this.sleeps.clear();
    for (const notification of this.notifications) notification.remove();
    this.notifications.clear();
    this.handling = false;
  }
}

let off: (() => void) | null = null;
let hk: PauseHotkey | null = null;
let boundCode = "";

function bind(code: string) {
  off?.();
  boundCode = code || "F8";
  off = keyboard.register(
    boundCode,
    (e) => {
      if (e.repeat) return;
      e.stopPropagation();
      void hk?.togglePause();
    },
    { preventDefault: true },
  );
}

export const pauseHotkeyFeature: Feature = {
  id: "pause-hotkey",
  settingKey: "pause_hotkey_enabled",
  enable(ctx: FeatureContext) {
    hk = new PauseHotkey();
    bind(ctx.settings.pause_hotkey_code);
  },
  update(ctx: FeatureContext) {
    // Пользователь сменил клавишу в настройках — переустанавливаем хоткей на лету.
    if (ctx.settings.pause_hotkey_code !== boundCode) bind(ctx.settings.pause_hotkey_code);
  },
  disable() {
    off?.();
    off = null;
    hk?.dispose();
    hk = null;
  },
};
