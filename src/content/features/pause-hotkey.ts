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
const PAUSE_EXACT = new Set([
  "пауза",
  "пауза игры",
  "поставить на паузу",
  "снять с паузы",
  "перерыв",
  "pause",
  "pause game",
  "break",
]);
/**
 * Слова снятия паузы. ОТДЕЛЬНО от паузы и под гейтом (resumeAllowedFor):
 * «Продолжить» — типовая кнопка любого диалога сайта (реконнект, туториал,
 * подтверждение) — без гейта F8 кликал бы чужие диалоги (инвариант №2).
 */
const RESUME_EXACT = new Set([
  "продолжить",
  "продолжить игру",
  "возобновить",
  "возобновить игру",
  // Реальные подписи сайта: судья завершает паузу кнопкой «Завершить»
  // (locale end_pause), без судьи игроки голосуют «Продолжить игру»
  // (continue_game_button_not_ready) — обе живут в ИГРОВЫХ контролах, а не
  // в меню настроек (аудит устойчивости 01.08.2026, находка 4).
  "завершить",
  "завершить паузу",
  "end pause",
  "resume",
  "resume game",
]);

/**
 * Контейнеры игровых контролов: там живут кнопки завершения паузы и
 * голосования за продолжение. Меню настроек (где живёт СТАРТ паузы) сюда
 * намеренно не входит.
 */
const GAME_CONTROLS_SELECTOR = ".controls, .game-info-block, .roller";
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
  /** Корни меню, появившиеся ИМЕННО от нашего клика по «Настройкам». */
  private openedRoots: Element[] = [];
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
    const values = [text, ariaLabel, title];
    if (values.some((v) => PAUSE_EXACT.has(v))) return true;
    // Проверенный в бою подстрочный матч: реальный пункт может быть
    // «Пауза (F8)» / с таймером / иконкой с классом pause. Точный набор
    // литералов нигде не сверен с живой вёрсткой — без этой ступени F8
    // рисковал умереть целиком. Гард по длине отсекает абзацы.
    if (text.length <= 32 && values.some((v) => v.includes("пауз") || v.includes("pause") || v.includes("перерыв"))) {
      return true;
    }
    const cls = norm((node as HTMLElement)?.className?.toString?.() || "");
    if (cls.includes("pause")) return true;
    if (this.resumeAllowedFor(node) && values.some((v) => RESUME_EXACT.has(v))) return true;
    return false;
  }

  /** Resume-слова принимаем только в меню настроек игры или в меню, открытом нами. */
  private resumeAllowedFor(candidate: Element): boolean {
    if (candidate.closest('.game-room__settings, [class*="settings"], [class*="pause"]')) {
      return true;
    }
    // Игровые контролы: «Завершить»/«Продолжить игру» рендерятся там, и без
    // этого F8 никогда не мог снять паузу (находка 4).
    if (candidate.closest(GAME_CONTROLS_SELECTOR)) return true;
    if (!this.activeOpener) return false;
    return this.getMenuRoots().some(
      (root) => isVisible(root) && !this.initialVisibleMenus.has(root) && root.contains(candidate),
    );
  }

  private isNavigatingAnchor(node: Element): boolean {
    // Настоящая навигация, а не href="#"/javascript: — типовой markup пунктов
    // меню в SPA; жёсткое исключение всех a[href] убивало легитимные пункты.
    const a = node.closest("a[href]");
    if (!a) return false;
    const href = a.getAttribute("href") || "";
    return href !== "" && href !== "#" && !href.startsWith("javascript:");
  }

  private containsNavigatingAnchor(node: Element): boolean {
    return Array.from(node.querySelectorAll("a[href]")).some((a) => {
      const href = a.getAttribute("href") || "";
      return href !== "" && href !== "#" && !href.startsWith("javascript:");
    });
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
        this.containsNavigatingAnchor(c)
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
          !this.containsNavigatingAnchor(candidate) &&
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

  /**
   * Видимая кнопка снятия паузы в ИГРОВЫХ контролах (не в меню настроек).
   * Возвращает null, если паузы нет или кнопка не найдена.
   */
  private getResumeButton(): Element | null {
    for (const root of Array.from(document.querySelectorAll(GAME_CONTROLS_SELECTOR))) {
      const found = Array.from(root.querySelectorAll(CLICKABLE_SELECTOR)).find((candidate) => {
        if (this.isNavigatingAnchor(candidate) || !isVisible(candidate)) return false;
        if (this.isPauseDisabled(candidate)) return false;
        // У кнопки голосования за продолжение ДВА текстовых span'а:
        // .without-hover («Продолжить игру») и .with-hover («Подтвердить»),
        // между ними нет пробела — textContent слипается в
        // «продолжить игруподтвердить» и точный матч не срабатывал
        // (ревью аудита устойчивости: без этого фикс работал только у
        // судьи, а обычный игрок так и не мог снять паузу).
        const label = candidate.querySelector(".without-hover")?.textContent;
        const values = [
          norm(label ?? candidate.textContent),
          norm(candidate.getAttribute?.("aria-label")),
          norm(candidate.getAttribute?.("title")),
        ];
        // ТОЛЬКО точные подписи: «Продолжить» — типовая кнопка любого
        // диалога сайта, подстрочный матч здесь запрещён (инвариант §4 п.2).
        return values.some((v) => RESUME_EXACT.has(v));
      });
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
    // Только если видимое «наше» меню реально есть. Слепой клик по opener'у
    // при roots=0 ОТКРЫВАЛ меню в момент выключения фичи — и после
    // disposed=true его уже никто не закрыл бы.
    else if (roots.length > 0) this.dispatchClick(this.activeOpener);
  }

  /** Похоже ли на меню настроек игры (а не на всплывший поверх оверлей). */
  private looksLikeSettingsMenu(root: Element): boolean {
    return Array.from(root.querySelectorAll(CLICKABLE_SELECTOR)).some(
      (node) => this.matchesPause(node) || this.matchesSettings(node),
    );
  }

  /**
   * Закрыть меню, которое мы сами открыли ради паузы.
   *
   * Раньше здесь был ОДИН клик по `getCloseButton(menu)`. У меню настроек в
   * игре нет кнопки с aria-label/title «закрыть», поэтому клик уходил в null
   * — пауза включалась, а «Настройки» оставались висеть поверх игры. Фолбэк
   * «кликнуть по opener'у ещё раз» жил только в closeOpenedMenu, куда этот
   * путь не заходил.
   *
   * Меню, открытое самим игроком, по-прежнему закрываем только явной кнопкой
   * и никогда не кликаем opener: чужие окна не наши (инвариант AGENTS.md §4).
   */
  private async closeAfterPause(menu: Element | null): Promise<void> {
    if (!this.activeOpener) {
      // Меню игрок открыл сам — прежнее поведение, без самодеятельности.
      if (menu && isVisible(menu)) this.dispatchClick(this.getCloseButton(menu));
      return;
    }

    let ours = this.openedRoots.filter((root) => root.isConnected && isVisible(root));
    if (ours.length === 0) {
      // Клик по паузе мог заставить Vue перерисовать меню — тогда сохранённые
      // узлы отключены от документа, а на экране висит новый. Ищем заново, но
      // только среди «не бывших изначально» и только настоящие меню настроек.
      ours = this.getMenuRoots().filter(
        (root) =>
          isVisible(root) && !this.initialVisibleMenus.has(root) && this.looksLikeSettingsMenu(root),
      );
    }
    if (ours.length === 0) return; // сайт закрыл меню сам — всё в порядке

    await this.closeOpenedMenu({ opener: this.activeOpener, roots: [...new Set(ours)] });
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
        // Запоминаем ИМЕННО эти корни: закрывать потом будем их, а не всё,
        // что подойдёт под MENU_SELECTOR (он широкий — `[class*="menu"]`,
        // под него легко попадёт оверлей, появившийся уже после паузы).
        this.openedRoots = [...new Set(roots)];
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
      // Снятие паузы ПЕРВЫМ: кнопка живёт в игровых контролах, и открывать
      // ради неё меню настроек не нужно (в меню на паузе пункт «Пауза» ещё и
      // disabled — раньше F8 упирался в него и говорил «недоступна»).
      const resume = this.getResumeButton();
      if (resume) {
        this.dispatchClick(resume);
        return;
      }
      const pause = await this.ensureMenuOpen();
      if (this.disposed) return;
      if (!pause) return this.notify(TEXT.notFound);
      const menu = this.owningMenu(pause);
      if (this.isPauseDisabled(pause)) {
        // Тот же путь закрытия, что и после удачной паузы: иначе на недоступной
        // паузе мы оставляли открытым меню, которое сами же и открыли.
        await this.closeAfterPause(menu);
        return this.notify(TEXT.unavailable);
      }
      this.dispatchClick(pause);
      if (!(await this.sleep(120))) return;
      await this.closeAfterPause(menu);
    } finally {
      if (!this.disposed) await this.sleep(250);
      this.activeOpener = null;
      this.activeMenuObserved = false;
      this.initialVisibleMenus.clear();
      this.openedRoots = [];
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
