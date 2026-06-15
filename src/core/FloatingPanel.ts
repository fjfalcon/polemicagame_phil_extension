/**
 * Базовая плавающая панель: перетаскивание за заголовок, ресайз, сохранение
 * позиции/размера в localStorage. OBS- и Twitch-панели наследуют её,
 * убирая ~400 строк дублированного кода.
 */
import { log } from "./log";

export interface FloatingPanelOptions {
  /** Уникальный ключ для localStorage (позиция/размер). */
  storageKey: string;
  title: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
  className?: string;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export abstract class FloatingPanel {
  protected root!: HTMLElement;
  protected header!: HTMLElement;
  protected body!: HTMLElement;
  protected titleEl!: HTMLElement;
  protected readonly opts: Required<FloatingPanelOptions>;
  private cleanup: Array<() => void> = [];
  private mounted = false;

  constructor(opts: FloatingPanelOptions) {
    this.opts = {
      width: 320,
      height: 240,
      minWidth: 200,
      minHeight: 120,
      resizable: true,
      className: "",
      ...opts,
    };
  }

  /** Наследник заполняет тело панели. Вызывается один раз при mount. */
  protected abstract renderBody(body: HTMLElement): void;

  mount(): void {
    if (this.mounted) return;
    this.build();
    document.body.appendChild(this.root);
    this.restoreBox();
    this.renderBody(this.body);
    this.mounted = true;
    log.debug("panel", "mounted", this.opts.storageKey);
  }

  unmount(): void {
    if (!this.mounted) return;
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
    this.root.remove();
    this.mounted = false;
  }

  show(): void {
    this.mount();
    this.root.style.display = "flex";
  }

  hide(): void {
    if (this.mounted) this.root.style.display = "none";
  }

  toggle(): void {
    if (this.mounted && this.root.style.display !== "none") this.hide();
    else this.show();
  }

  get isMounted(): boolean {
    return this.mounted;
  }

  // ───────────────────────── построение ─────────────────────────
  private build(): void {
    const root = document.createElement("div");
    root.className = `fp-panel ${this.opts.className}`.trim();
    Object.assign(root.style, {
      position: "fixed",
      zIndex: "2147483000",
      display: "flex",
      flexDirection: "column",
      width: `${this.opts.width}px`,
      height: `${this.opts.height}px`,
      background: "#1e1f26",
      color: "#fff",
      border: "1px solid rgba(255,255,255,.12)",
      borderRadius: "10px",
      boxShadow: "0 8px 30px rgba(0,0,0,.45)",
      overflow: "hidden",
      font: "13px/1.4 system-ui, sans-serif",
    } as CSSStyleDeclaration);

    const header = document.createElement("div");
    header.className = "fp-header";
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "8px 10px",
      background: "rgba(255,255,255,.06)",
      cursor: "move",
      userSelect: "none",
      flex: "0 0 auto",
    } as CSSStyleDeclaration);

    const titleEl = document.createElement("span");
    titleEl.textContent = this.opts.title;
    titleEl.style.flex = "1";
    titleEl.style.fontWeight = "600";

    header.appendChild(titleEl);

    const body = document.createElement("div");
    body.className = "fp-body";
    Object.assign(body.style, {
      flex: "1 1 auto",
      overflow: "auto",
      padding: "8px 10px",
    } as CSSStyleDeclaration);

    root.append(header, body);

    if (this.opts.resizable) root.appendChild(this.buildResizeHandle(root));

    this.root = root;
    this.header = header;
    this.body = body;
    this.titleEl = titleEl;

    this.enableDrag(header, root);
  }

  /** Добавить кнопку в заголовок (например ✕ или −). */
  protected addHeaderButton(label: string, onClick: () => void, title = ""): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = title;
    Object.assign(btn.style, {
      background: "transparent",
      border: "none",
      color: "inherit",
      cursor: "pointer",
      fontSize: "14px",
      lineHeight: "1",
      padding: "2px 4px",
    } as CSSStyleDeclaration);
    btn.addEventListener("click", onClick);
    this.header.appendChild(btn);
    return btn;
  }

  // ───────────────────────── drag ─────────────────────────
  private enableDrag(handle: HTMLElement, root: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    const onMove = (e: PointerEvent) => {
      root.style.left = `${baseLeft + (e.clientX - startX)}px`;
      root.style.top = `${baseTop + (e.clientY - startY)}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      this.persistBox();
    };
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      const r = root.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      baseLeft = r.left;
      baseTop = r.top;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointerdown", onDown);
    this.cleanup.push(() => handle.removeEventListener("pointerdown", onDown));
  }

  // ───────────────────────── resize ─────────────────────────
  private buildResizeHandle(root: HTMLElement): HTMLElement {
    const h = document.createElement("div");
    h.className = "fp-resize";
    Object.assign(h.style, {
      position: "absolute",
      right: "0",
      bottom: "0",
      width: "14px",
      height: "14px",
      cursor: "nwse-resize",
    } as CSSStyleDeclaration);

    let startX = 0;
    let startY = 0;
    let baseW = 0;
    let baseH = 0;
    const onMove = (e: PointerEvent) => {
      root.style.width = `${Math.max(this.opts.minWidth, baseW + (e.clientX - startX))}px`;
      root.style.height = `${Math.max(this.opts.minHeight, baseH + (e.clientY - startY))}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      this.persistBox();
    };
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      const r = root.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      baseW = r.width;
      baseH = r.height;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    h.addEventListener("pointerdown", onDown);
    this.cleanup.push(() => h.removeEventListener("pointerdown", onDown));
    return h;
  }

  // ───────────────────────── persistence ─────────────────────────
  private get lsKey(): string {
    return `fp:${this.opts.storageKey}`;
  }

  private persistBox(): void {
    const r = this.root.getBoundingClientRect();
    const box: Box = { left: r.left, top: r.top, width: r.width, height: r.height };
    try {
      localStorage.setItem(this.lsKey, JSON.stringify(box));
    } catch {
      /* приватный режим / квота */
    }
  }

  private restoreBox(): void {
    let box: Partial<Box> | null = null;
    try {
      box = JSON.parse(localStorage.getItem(this.lsKey) || "null");
    } catch {
      box = null;
    }
    if (box && typeof box.left === "number") {
      Object.assign(this.root.style, {
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        right: "auto",
        bottom: "auto",
      } as CSSStyleDeclaration);
    } else {
      // дефолт: правый верхний угол
      this.root.style.right = "16px";
      this.root.style.top = "80px";
    }
  }
}
