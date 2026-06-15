/**
 * Пауза игры по F8: открыть меню настроек → найти кнопку паузы → клик → закрыть меню.
 * Порт pause-hotkey.js на единый keyboard-роутер. (Мёртвый autoJoinLobby не переносится.)
 */
import { keyboard } from "@core/keyboard";
import { isVisible } from "@core/dom";
import type { Feature } from "@core/feature";

const TEXT = {
  settingsRu: "настро",
  pauseRu: "пауз",
  breakRu: "перерыв",
  closeRu: "закр",
  notFound: "Не нашёл кнопку паузы",
  unavailable: "Пауза сейчас недоступна",
};

const norm = (v: unknown) => (v ?? "").toString().toLowerCase().replace(/\s+/g, " ").trim();

class PauseHotkey {
  private handling = false;

  private clickableFrom(node: Element | null): Element | null {
    if (!node || typeof node.closest !== "function") return node;
    return (
      node.closest(
        'button, [role="button"], [role="menuitem"], li, a, div.button, .button, .button-comp, .base-menu__item',
      ) || node
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
    const label = norm(`${node?.getAttribute?.("aria-label") || ""} ${node?.getAttribute?.("title") || ""}`);
    const cls = norm((node as HTMLElement)?.className?.toString?.() || "");
    return (
      text.includes(TEXT.pauseRu) ||
      text.includes("pause") ||
      text.includes(TEXT.breakRu) ||
      label.includes(TEXT.pauseRu) ||
      label.includes("pause") ||
      cls.includes("pause")
    );
  }

  private notify(message: string) {
    const n = document.createElement("div");
    n.style.cssText =
      "position:fixed;top:20px;right:20px;background:rgba(255,152,0,.9);color:#fff;padding:12px 24px;border-radius:8px;z-index:2147483600;box-shadow:0 4px 6px rgba(0,0,0,.1);font-size:14px";
    n.textContent = message;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 3000);
  }

  private waitFor<T>(check: () => T | null, timeoutMs = 1800, intervalMs = 60): Promise<T | null> {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const r = check();
        if (r) return resolve(r);
        if (Date.now() - start >= timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
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
      if (!c || seen.has(c) || !isVisible(c)) return;
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
    const selectors = [".game-room__settings", ".base-menu", ".base-menu__list", ".base-menu__content", ".dropdown-menu", ".context-menu", '[role="menu"]', '[class*="menu"]'];
    const roots: Element[] = [];
    const seen = new Set<Element>();
    selectors.forEach((s) =>
      document.querySelectorAll(s).forEach((r) => {
        if (!seen.has(r)) {
          seen.add(r);
          roots.push(r);
        }
      }),
    );
    return roots;
  }

  private getPauseButton(onlyMenuRoots = false): Element | null {
    if (!onlyMenuRoots) {
      for (const s of ['use[href*="#pause"]', 'use[xlink\\:href*="#pause"]']) {
        const c = this.clickableFrom(document.querySelector(s));
        if (c) return c;
      }
    }
    const roots = onlyMenuRoots ? this.getMenuRoots() : [...this.getMenuRoots(), document.body];
    const sels = ["button", '[role="button"]', '[role="menuitem"]', "li", "a", "span", "div"];
    for (const root of roots) {
      for (const s of sels) {
        const found = Array.from(root.querySelectorAll(s)).find((n) => this.matchesPause(n));
        if (found) return this.clickableFrom(found);
      }
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

  private getCloseButton(): HTMLElement | null {
    const selectors = [".game-room__settings .close", ".base-menu .close", ".context-menu .close", '[class*="menu"] [aria-label]', '[class*="menu"] button[title]', '[role="menu"] [aria-label]', '[role="menu"] button[title]'];
    for (const s of selectors) {
      const found = Array.from(document.querySelectorAll<HTMLElement>(s)).find((n) => {
        const label = norm(`${n.getAttribute?.("aria-label") || ""} ${n.getAttribute?.("title") || ""}`);
        return label.includes(TEXT.closeRu) || label.includes("close");
      });
      if (found) return found;
    }
    return null;
  }

  private dispatchClick(node: Element | null): boolean {
    const target = this.clickableFrom(node);
    if (!target) return false;
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((name) =>
      target.dispatchEvent(new MouseEvent(name, { view: window, bubbles: true, cancelable: true })),
    );
    return true;
  }

  private async ensureMenuOpen(): Promise<Element | null> {
    const existing = this.getPauseButton(true);
    if (existing) return existing;
    const buttons = this.getSettingsButtons();
    for (const b of buttons) {
      this.dispatchClick(b);
      const pause = await this.waitFor(() => this.getPauseButton(true), 700, 50);
      if (pause) return pause;
    }
    return null;
  }

  async togglePause(): Promise<void> {
    if (this.handling) return;
    this.handling = true;
    try {
      const pause = await this.ensureMenuOpen();
      if (!pause) return this.notify(TEXT.notFound);
      if (this.isPauseDisabled(pause)) {
        this.getCloseButton()?.click();
        return this.notify(TEXT.unavailable);
      }
      this.dispatchClick(pause);
      await new Promise((r) => setTimeout(r, 120));
      this.dispatchClick(this.getCloseButton());
    } finally {
      setTimeout(() => (this.handling = false), 250);
    }
  }
}

let off: (() => void) | null = null;

export const pauseHotkeyFeature: Feature = {
  id: "pause-hotkey",
  settingKey: "pause_hotkey_enabled",
  enable() {
    const hk = new PauseHotkey();
    off = keyboard.register(
      "F8",
      (e) => {
        if (e.repeat) return;
        e.stopPropagation();
        void hk.togglePause();
      },
      { preventDefault: true },
    );
  },
  disable() {
    off?.();
    off = null;
  },
};
