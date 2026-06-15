/**
 * Подмена собственной роли: F/А — следующая роль, E/У — сброс.
 * Пока подмена активна — прячет чужие роли и блокирует клавишу D/В.
 * Порт role-faker.js на единый keyboard-роутер и общий DOM-наблюдатель.
 */
import { keyboard } from "@core/keyboard";
import { onDomChange } from "@core/dom";
import { log } from "@core/log";
import { SITE } from "@core/selectors";
import type { Feature } from "@core/feature";

interface RoleDef {
  name: string;
  icon: string;
}

class RoleFaker {
  private readonly roles: RoleDef[] = [
    { name: "undefined", icon: "player" },
    { name: "Дон", icon: "godfather" },
    { name: "Мафия", icon: "mafia" },
    { name: "Шериф", icon: "sheriff" },
    { name: "Мирный", icon: "civilian" },
  ];
  private currentRoleIndex = 0;
  private isFaked = false;
  private originalRoles = new Map<HTMLElement, { display: string; visibility: string }>();
  private originalStyles = new Map<HTMLElement, { right: string; position: string }>();
  private spriteBase?: string;

  private offDom: (() => void) | null = null;
  private dBlocker: ((e: KeyboardEvent) => void) | null = null;

  onFakeKey = () => {
    this.changeRole();
    this.hideOtherRoles();
    this.fixMenuPositions();
    this.setFaked(true);
  };

  onResetKey = () => {
    this.resetRoles();
  };

  private setFaked(v: boolean) {
    this.isFaked = v;
    if (v) this.attachDBlocker();
    else this.detachDBlocker();
  }

  /** Блокировка D/В пока подмена активна — отдельный capture-листенер (D занят auto-start). */
  private attachDBlocker() {
    if (this.dBlocker) return;
    this.dBlocker = (e: KeyboardEvent) => {
      if (this.isFaked && e.code === "KeyD") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", this.dBlocker, true);
  }
  private detachDBlocker() {
    if (this.dBlocker) window.removeEventListener("keydown", this.dBlocker, true);
    this.dBlocker = null;
  }

  private resolveSpriteBase(): string {
    if (this.spriteBase !== undefined) return this.spriteBase;
    const useEls = document.querySelectorAll(SITE.roleUse);
    const markers = ["#civilian", "#sheriff", "#mafia", "#godfather"];
    if (document.querySelector(SITE.roleSymbols)) return (this.spriteBase = "");
    for (const el of useEls) {
      const href = el.getAttribute("href") || el.getAttribute("xlink:href");
      if (!href) continue;
      if (markers.includes(href)) return (this.spriteBase = "");
      if (!href.includes("/bundle/") || !href.includes(".svg")) continue;
      if (!markers.some((m) => href.includes(m))) continue;
      const base = href.split("#")[0];
      if (base) return (this.spriteBase = base);
    }
    for (const el of useEls) {
      const href = el.getAttribute("href") || el.getAttribute("xlink:href");
      if (!href) continue;
      if (!href.includes("/bundle/") || !href.includes(".svg")) continue;
      const base = href.split("#")[0];
      if (base) return (this.spriteBase = base);
    }
    const prefix = location.pathname.includes("/new-room/") ? "/new-room/bundle/" : "/room/bundle/";
    return (this.spriteBase = `${prefix}f59bacbc2885635c4d91.svg`);
  }

  private fixMenuPositions() {
    document.querySelectorAll<HTMLElement>(SITE.playerMenuWithRole).forEach((menu) => {
      if (menu.closest(".my-role") || menu.closest(".my-player")) return;
      if (!this.originalStyles.has(menu)) {
        this.originalStyles.set(menu, { right: menu.style.right, position: menu.style.position });
      }
      menu.style.right = "0.5rem";
    });
  }

  private resetMenuPositions() {
    this.originalStyles.forEach((s, menu) => {
      menu.style.right = s.right;
      menu.style.position = s.position;
    });
    this.originalStyles.clear();
  }

  private hideOtherRoles() {
    document.querySelectorAll<HTMLElement>(SITE.anyRole).forEach((el) => {
      if (el.closest(".my-role") || el.closest(".my-player")) return;
      if (!this.originalRoles.has(el)) {
        this.originalRoles.set(el, { display: el.style.display, visibility: el.style.visibility });
      }
      el.style.display = "none";
    });
    if (!this.offDom) {
      this.offDom = onDomChange(() => {
        if (!this.isFaked) return;
        document.querySelectorAll<HTMLElement>(SITE.anyRole).forEach((el) => {
          if (!el.closest(".my-role") && !el.closest(".my-player")) el.style.display = "none";
        });
        document.querySelectorAll<HTMLElement>(SITE.playerMenuWithRole).forEach((menu) => {
          if (!menu.closest(".my-role") && !menu.closest(".my-player")) menu.style.right = "0.5rem";
        });
      });
    }
  }

  private resetRoles() {
    this.originalRoles.forEach((s, el) => {
      el.style.display = s.display;
      el.style.visibility = s.visibility;
    });
    this.originalRoles.clear();
    this.resetMenuPositions();
    if (this.offDom) {
      this.offDom();
      this.offDom = null;
    }
    const myRole = document.querySelector<HTMLElement>(SITE.myRole);
    if (myRole) {
      const use = myRole.querySelector("use");
      if (use && myRole.hasAttribute("data-original-role")) {
        const role = myRole.getAttribute("data-original-role");
        const base = myRole.getAttribute("data-original-sprite-base") || this.resolveSpriteBase();
        const href = `${base}#${role}`;
        use.setAttribute("href", href);
        use.setAttribute("xlink:href", href);
      }
      const tip = myRole.querySelector(".tooltip .content span");
      if (tip && myRole.hasAttribute("data-original-role-name")) {
        tip.textContent = `Ваша роль - ${myRole.getAttribute("data-original-role-name")}`;
      }
    }
    this.setFaked(false);
  }

  private changeRole() {
    const el = document.querySelector<HTMLElement>(SITE.myRole);
    if (!el) {
      log.debug("role-faker", "my role element not found");
      return;
    }
    if (!el.hasAttribute("data-original-role")) {
      const use = el.querySelector("use");
      if (use) {
        const raw = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
        const [base, role] = raw.split("#");
        el.setAttribute("data-original-sprite-base", base || this.resolveSpriteBase());
        el.setAttribute("data-original-role", role || "civilian");
      }
      const tip = el.querySelector(".tooltip .content span");
      if (tip) {
        el.setAttribute("data-original-role-name", (tip.textContent || "").replace("Ваша роль - ", ""));
      }
    }
    this.currentRoleIndex = (this.currentRoleIndex + 1) % this.roles.length;
    const role = this.roles[this.currentRoleIndex];
    const use = el.querySelector("use");
    if (use) {
      const base = el.getAttribute("data-original-sprite-base") || this.resolveSpriteBase();
      const href = `${base}#${role.icon}`;
      use.setAttribute("href", href);
      use.setAttribute("xlink:href", href);
    }
    const tip = el.querySelector(".tooltip .content span");
    if (tip) tip.textContent = `Ваша роль - ${role.name}`;
  }

  teardown() {
    if (this.isFaked) this.resetRoles();
    this.detachDBlocker();
    if (this.offDom) {
      this.offDom();
      this.offDom = null;
    }
  }
}

let faker: RoleFaker | null = null;
let offKeys: Array<() => void> = [];

export const roleFakerFeature: Feature = {
  id: "role-faker",
  settingKey: "enable_role_faker",
  enable() {
    faker = new RoleFaker();
    offKeys = [
      keyboard.register("KeyF", () => faker?.onFakeKey()),
      keyboard.register("KeyE", () => faker?.onResetKey()),
    ];
  },
  disable() {
    offKeys.forEach((off) => off());
    offKeys = [];
    faker?.teardown();
    faker = null;
  },
};
