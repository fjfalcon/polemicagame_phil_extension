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

/** Ширина краевых ручек ресайза — и отступ тела, чтобы они не крали скроллбар. */
const EDGE_HANDLE_PX = 6;

/** Сколько панели обязано остаться в окне по горизонтали, чтобы её схватить. */
const EDGE_KEEP_PX = 48;
/** Шапка целиком на экране: за неё панель и таскают. */
const HEADER_KEEP_PX = 32;

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
  /** Идёт перетаскивание или ресайз: кламп в это время не вмешивается. */
  private gestureActive = false;
  /** Ручки ресайза — наследник гасит их в режиме «сквозь клики». */
  protected resizeHandles: HTMLElement[] = [];
  /**
   * Коробка, которую задал ПОЛЬЗОВАТЕЛЬ. Кламп по временно уменьшенному окну
   * меняет только показ: сохранять подрезанный размер нельзя — вернувшись на
   * большой монитор, человек ждёт своё прежнее окно (adversarial 27.08.2026:
   * первый же сдвиг панели закреплял подрезанный размер на диске).
   */
  private desiredBox: Box | null = null;

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
    this.watchViewport();
    this.mounted = true;
    log.debug("panel", "mounted", this.opts.storageKey);
  }

  /**
   * Окно уменьшилось (свернули браузер, сменили разрешение под запись) —
   * панель обязана остаться на экране. Кламп НЕ сохраняем: вернувшись на
   * большой монитор, пользователь получит свою прежнюю коробку, а не
   * подрезанную временным окном.
   */
  private watchViewport(): void {
    let frame: number | null = null;
    const onResize = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        this.clampToViewport();
      });
    };
    window.addEventListener("resize", onResize);
    this.cleanup.push(() => {
      window.removeEventListener("resize", onResize);
      if (frame !== null) cancelAnimationFrame(frame);
    });
  }

  private clampToViewport(): void {
    if (!this.root.isConnected) return;
    // Скрытая панель не измеряется: у display:none нулевой rect, и кламп
    // «поправлял» коробку в минимальный размер в точке (0,0) — стример
    // прятал чат, менял размер окна и получал панель в углу (блокер
    // adversarial 27.08.2026). Скрытую поправим на показе.
    if (this.root.style.display === "none") return;
    // Жест главнее: во время drag/resize человек сам решает, где панель, а
    // наши записи всё равно затрёт следующий pointermove.
    if (this.gestureActive) return;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 720;
    const r = this.root.getBoundingClientRect();
    // Нулевая коробка = панель не отрисована (скрыта родителем, вкладка
    // только просыпается): измерять нечего, поправлять нечего.
    if (r.width <= 0 || r.height <= 0) return;
    const width = Math.min(Math.max(this.opts.minWidth, r.width), vw);
    const height = Math.min(Math.max(this.opts.minHeight, r.height), vh);
    const left = Math.min(Math.max(0, r.left), Math.max(0, vw - width));
    // Заголовок обязан остаться в пределах экрана: за него панель и таскают.
    const top = Math.min(Math.max(0, r.top), Math.max(0, vh - 32));
    const next = {
      width: `${Math.round(width)}px`,
      height: `${Math.round(height)}px`,
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
    };
    // Пишем только изменившееся: общий наблюдатель следит за style, и
    // безусловная запись порождала бы мутацию на каждый resize (§4).
    for (const [k, v] of Object.entries(next) as Array<[keyof typeof next, string]>) {
      if (this.root.style[k] !== v) this.root.style[k] = v;
    }
    if (this.root.style.right !== "auto") this.root.style.right = "auto";
    if (this.root.style.bottom !== "auto") this.root.style.bottom = "auto";
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
    // Пока панель была скрыта, окно могло уменьшиться — правим здесь, когда
    // коробку снова есть чем измерить.
    this.clampToViewport();
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
      // Явный border-box: у корня есть рамка 1px, и при content-box
      // getBoundingClientRect отдавал бы style.width + 2. Кламп пишет
      // измеренное обратно в стиль — панель росла бы на 2px за каждое
      // событие resize, пока не упрётся в экран (adversarial 27.08.2026).
      boxSizing: "border-box",
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
      touchAction: "none",
      // Выше ручек ресайза: иначе правые 6px шапки меняли ширину вместо того,
      // чтобы таскать панель.
      position: "relative",
      zIndex: "5",
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
      // Отступ под ручку правого края: иначе она ложится на собственную
      // полосу прокрутки тела, и попытка проскроллить список сцен OBS
      // меняла ширину панели (adversarial 27.08.2026).
      marginRight: this.opts.resizable ? `${EDGE_HANDLE_PX}px` : "0",
      marginBottom: this.opts.resizable ? `${EDGE_HANDLE_PX}px` : "0",
    } as CSSStyleDeclaration);

    root.append(header, body);

    if (this.opts.resizable) {
      // Ручки хранятся: режим «сквозь клики» гасит их вместе с остальным
      // хромом — видимая насечка на прозрачном оверлее уезжала в эфир.
      this.resizeHandles = [];
      // Три ручки вместо одного невидимого угла 14×14: правый край тянет
      // ширину, нижний — высоту, угол — обе (жалоба владельца 27.08.2026
      // «менять размеры нормально»). Попасть в угол мышью на панели 250px
      // было отдельным упражнением, а край менял обе стороны разом.
      for (const dir of ["e", "s", "se"] as const) {
        const handle = this.buildResizeHandle(root, dir);
        this.resizeHandles.push(handle);
        root.appendChild(handle);
      }
    }

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
      // Границы: pointer capture шлёт события и когда курсор ушёл за окно, и
      // панель утаскивалась ЦЕЛИКОМ за экран — внутри сессии вернуть её было
      // нечем (кламп срабатывал только на resize окна). Оставляем на виду
      // всю шапку по вертикали и заметный край по горизонтали
      // (adversarial 27.08.2026).
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const r = root.getBoundingClientRect();
      const keepX = Math.min(EDGE_KEEP_PX, r.width || EDGE_KEEP_PX);
      const rawLeft = baseLeft + (latestX - startX);
      const rawTop = baseTop + (latestY - startY);
      const left = `${Math.round(Math.min(Math.max(keepX - (r.width || 0), rawLeft), vw - keepX))}px`;
      const top = `${Math.round(Math.min(Math.max(0, rawTop), Math.max(0, vh - HEADER_KEEP_PX)))}px`;
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
      this.gestureActive = false;
      detach();
      try {
        if (handle.hasPointerCapture(finishedPointerId)) {
          handle.releasePointerCapture(finishedPointerId);
        }
      } catch {
        /* UA уже освободил pointer */
      }
      if (persist) this.persistBox(root, "move");
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
      this.gestureActive = true;
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
  private buildResizeHandle(root: HTMLElement, dir: "e" | "s" | "se"): HTMLElement {
    const h = document.createElement("div");
    h.className = `fp-resize fp-resize-${dir}`;
    const common = { position: "absolute", zIndex: "4", touchAction: "none" };
    if (dir === "e") {
      Object.assign(h.style, {
        ...common,
        right: "0",
        top: "0",
        bottom: "16px",
        width: `${EDGE_HANDLE_PX}px`,
        cursor: "ew-resize",
      } as CSSStyleDeclaration);
    } else if (dir === "s") {
      Object.assign(h.style, {
        ...common,
        left: "0",
        right: "16px",
        bottom: "0",
        height: `${EDGE_HANDLE_PX}px`,
        cursor: "ns-resize",
      } as CSSStyleDeclaration);
    } else {
      Object.assign(h.style, {
        ...common,
        right: "0",
        bottom: "0",
        width: "16px",
        height: "16px",
        cursor: "nwse-resize",
        // Видимая насечка: невидимую ручку искали наугад.
        background:
          "linear-gradient(135deg, transparent 0 45%, rgba(255,255,255,.28) 45% 55%," +
          " transparent 55% 70%, rgba(255,255,255,.28) 70% 80%, transparent 80%)",
        borderBottomRightRadius: "10px",
      } as CSSStyleDeclaration);
    }

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
      // Потолок — вьюпорт: панель, растянутая мимо экрана, уносит свой же
      // угол с ручкой за край, и уменьшить её обратно уже нечем.
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const r = root.getBoundingClientRect();
      const maxW = Math.max(this.opts.minWidth, vw - r.left);
      const maxH = Math.max(this.opts.minHeight, vh - r.top);
      if (dir !== "s") {
        const w = Math.min(maxW, Math.max(this.opts.minWidth, baseW + (latestX - startX)));
        const width = `${Math.round(w)}px`;
        if (root.style.width !== width) root.style.width = width;
      }
      if (dir !== "e") {
        const hh = Math.min(maxH, Math.max(this.opts.minHeight, baseH + (latestY - startY)));
        const height = `${Math.round(hh)}px`;
        if (root.style.height !== height) root.style.height = height;
      }
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
      this.gestureActive = false;
      detach();
      try {
        if (h.hasPointerCapture(finishedPointerId)) h.releasePointerCapture(finishedPointerId);
      } catch {
        /* UA уже освободил pointer */
      }
      if (persist) this.persistBox(root, "size");
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
      this.gestureActive = true;
      startX = e.clientX;
      startY = e.clientY;
      latestX = e.clientX;
      latestY = e.clientY;
      baseW = r.width;
      baseH = r.height;
      // Якорь — на левый/верхний край, как это делает перетаскивание. Свежая
      // панель стоит на right:16px без left, и рост ширины расширял бы её
      // ВЛЕВО: правый край на месте, уголок убегает из-под курсора
      // (adversarial 27.08.2026 — половинчатый фикс, ресайз забыли).
      if (root.style.right !== "auto") {
        root.style.left = `${Math.round(r.left)}px`;
        root.style.right = "auto";
      }
      if (root.style.bottom !== "auto") {
        root.style.top = `${Math.round(r.top)}px`;
        root.style.bottom = "auto";
      }
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

  /**
   * Сохранить коробку панели.
   *
   * `mode` отделяет «человек подвинул» от «человек изменил размер»: после
   * перетаскивания на диск едет НОВОЕ положение и ПРЕЖНИЙ размер, даже если
   * панель сейчас показана подрезанной под маленькое окно. Иначе один сдвиг
   * мышью закреплял навязанный временным окном размер навсегда — обход
   * обещания «кламп на диск не едет» (adversarial 27.08.2026).
   */
  private persistBox(root: HTMLElement, mode: "move" | "size"): void {
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
    const box: Box =
      mode === "move" && this.desiredBox
        ? { ...this.desiredBox, left: r.left, top: r.top }
        : { left: r.left, top: r.top, width: r.width, height: r.height };
    this.desiredBox = box;
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
      // Прочитанная коробка — выбор пользователя; на экран она едет
      // подрезанной, но на диске обязана остаться прежней.
      this.desiredBox = {
        left: box.left as number,
        top: box.top as number,
        width: box.width as number,
        height: box.height as number,
      };
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
