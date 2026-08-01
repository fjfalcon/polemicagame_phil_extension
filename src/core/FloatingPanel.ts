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

  // show/hide идемпотентны: их зовут из подписчиков onDomChange на каждый
  // батч мутаций, а общий наблюдатель следит за атрибутом style — безусловная
  // запись здесь порождала бы новую мутацию и новый вызов.
  show(): void {
    this.mount();
    if (this.root.style.display !== "flex") this.root.style.display = "flex";
  }

  hide(): void {
    if (this.mounted && this.root.style.display !== "none") this.root.style.display = "none";
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
  /** protected: наследник может навесить перетаскивание на свой элемент
   *  (twitch-панель таскается за hover-полоску при скрытом заголовке). */
  protected enableDrag(handle: HTMLElement, root: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;
    let pointerId: number | null = null;
    let latestX = 0;
    let latestY = 0;
    let frameId: number | null = null;

    const applyPosition = () => {
      frameId = null;
      if (pointerId === null || !root.isConnected) return;
      const left = `${baseLeft + (latestX - startX)}px`;
      const top = `${baseTop + (latestY - startY)}px`;
      if (root.style.left !== left) root.style.left = left;
      if (root.style.top !== top) root.style.top = top;
    };
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const finish = (e: PointerEvent | null, persist: boolean) => {
      if (pointerId === null || (e && e.pointerId !== pointerId)) return;
      const finishedPointerId = pointerId;
      if (e) {
        latestX = e.clientX;
        latestY = e.clientY;
      }
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
      applyPosition();
      pointerId = null;
      detach();
      try {
        if (handle.hasPointerCapture(finishedPointerId)) {
          handle.releasePointerCapture(finishedPointerId);
        }
      } catch {
        /* UA уже освободил pointer */
      }
      if (persist) this.persistBox(root);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      latestX = e.clientX;
      latestY = e.clientY;
      if (frameId === null) frameId = requestAnimationFrame(applyPosition);
    };
    const onUp = (e: PointerEvent) => finish(e, true);
    const onCancel = (e: PointerEvent) => finish(e, false);
    const onLostCapture = (e: PointerEvent) => finish(e, false);
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      finish(null, false);
      const r = root.getBoundingClientRect();
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      latestX = e.clientX;
      latestY = e.clientY;
      baseLeft = r.left;
      baseTop = r.top;
      if (root.style.right !== "auto") root.style.right = "auto";
      if (root.style.bottom !== "auto") root.style.bottom = "auto";
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* pointer уже завершён */
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };
    handle.addEventListener("pointerdown", onDown);
    handle.addEventListener("lostpointercapture", onLostCapture);
    this.cleanup.push(() => {
      handle.removeEventListener("pointerdown", onDown);
      handle.removeEventListener("lostpointercapture", onLostCapture);
      finish(null, false);
    });
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
    let pointerId: number | null = null;
    let latestX = 0;
    let latestY = 0;
    let frameId: number | null = null;
    const applySize = () => {
      frameId = null;
      if (pointerId === null || !root.isConnected) return;
      const width = `${Math.max(this.opts.minWidth, baseW + (latestX - startX))}px`;
      const height = `${Math.max(this.opts.minHeight, baseH + (latestY - startY))}px`;
      if (root.style.width !== width) root.style.width = width;
      if (root.style.height !== height) root.style.height = height;
    };
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const finish = (e: PointerEvent | null, persist: boolean) => {
      if (pointerId === null || (e && e.pointerId !== pointerId)) return;
      const finishedPointerId = pointerId;
      if (e) {
        latestX = e.clientX;
        latestY = e.clientY;
      }
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
      applySize();
      pointerId = null;
      detach();
      try {
        if (h.hasPointerCapture(finishedPointerId)) h.releasePointerCapture(finishedPointerId);
      } catch {
        /* UA уже освободил pointer */
      }
      if (persist) this.persistBox(root);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      latestX = e.clientX;
      latestY = e.clientY;
      if (frameId === null) frameId = requestAnimationFrame(applySize);
    };
    const onUp = (e: PointerEvent) => finish(e, true);
    const onCancel = (e: PointerEvent) => finish(e, false);
    const onLostCapture = (e: PointerEvent) => finish(e, false);
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      finish(null, false);
      const r = root.getBoundingClientRect();
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      latestX = e.clientX;
      latestY = e.clientY;
      baseW = r.width;
      baseH = r.height;
      try {
        h.setPointerCapture(e.pointerId);
      } catch {
        /* pointer уже завершён */
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };
    h.addEventListener("pointerdown", onDown);
    h.addEventListener("lostpointercapture", onLostCapture);
    this.cleanup.push(() => {
      h.removeEventListener("pointerdown", onDown);
      h.removeEventListener("lostpointercapture", onLostCapture);
      finish(null, false);
    });
    return h;
  }

  // ───────────────────────── persistence ─────────────────────────
  private get lsKey(): string {
    return `fp:${this.opts.storageKey}`;
  }

  private persistBox(root: HTMLElement): void {
    if (!root.isConnected) return;
    const r = root.getBoundingClientRect();
    if (
      !Number.isFinite(r.left) ||
      !Number.isFinite(r.top) ||
      !Number.isFinite(r.width) ||
      !Number.isFinite(r.height) ||
      r.width <= 0 ||
      r.height <= 0
    ) {
      return;
    }
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
    if (
      box &&
      Number.isFinite(box.left) &&
      Number.isFinite(box.top) &&
      Number.isFinite(box.width) &&
      Number.isFinite(box.height) &&
      (box.width as number) > 0 &&
      (box.height as number) > 0
    ) {
      // Кламп по вьюпорту: localStorage принадлежит САЙТУ (AGENTS.md §5), и
      // сохранённая им коробка вида {left: 1e9, width: 1e9} навсегда уносила
      // панель за экран (аудит безопасности 01.08.2026, №16). Заодно чинит
      // честный кейс «панель осталась от большого монитора».
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const width = Math.min(Math.max(this.opts.minWidth, box.width as number), vw);
      const height = Math.min(Math.max(this.opts.minHeight, box.height as number), vh);
      // Заголовок обязан остаться доступным: не даём уехать за края.
      const left = Math.min(Math.max(0, box.left as number), Math.max(0, vw - width));
      const top = Math.min(Math.max(0, box.top as number), Math.max(0, vh - 32));
      Object.assign(this.root.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
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
