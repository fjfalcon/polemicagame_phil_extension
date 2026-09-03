/**
 * Фича: плавающая панель «Мой вечер» — трекер игровой сессии в духе
 * HS-трекеров (просьба владельца 26.08.2026): последние игры сессии с ролью
 * и ±MMR, сумма за вечер, MMR старта и текущий.
 *
 * Сессия и её якорь (граница 04:00 + ручной «начать заново») — чистая
 * логика в @core/session-stats. Здесь только сеть, хранение якоря и DOM.
 *
 * Данные — первая страница собственной истории игр (@core/crossover,
 * fetchFirstPage: 2000 игр за ~2 с — на любой вечер хватит с запасом).
 * Свой id — @core/own-user; пока он не известен (свежая установка, зашли
 * сразу в комнату), панель честно просит заглянуть на страницу поиска.
 *
 * Обновление: при показе, по кнопке ⟳ и раз в 3 минуты при видимой вкладке —
 * итог игры появляется в истории после её конца, сокетов у нас нет (решение
 * 09.08.2026), а лишние опросы жгут чужой сервер.
 */
import { browser } from "@core/env";
import { FloatingPanel } from "@core/FloatingPanel";
import { escapeHtml } from "@core/escape";
import { log } from "@core/log";
import { fetchFirstPage, type GameRow } from "@core/crossover";
import { getOwnUserId } from "@core/own-user";
import {
  pickSessionGames,
  sessionAnchor,
  summarizeSession,
} from "@core/session-stats";
import { createRoleSvg } from "../role-sprite";
import {
  applyChrome,
  buildGearMenu,
  buildHoverStrip,
  buildUnlockChip,
  CHROME_DEFAULTS,
  FONT_SCALE,
  menuCheck,
  menuHint,
  menuRange,
  menuRow,
  menuSegmented,
  menuSelect,
  ownField,
  readPanelPrefsRaw,
  sanitizeChromePrefs,
  savePanelPrefs,
  type ChromePrefs,
} from "@core/panel-chrome";
import type { Feature } from "@core/feature";

const SCOPE = "session";

/** Момент ручного «начать сессию заново». Не настройка — техсостояние. */
export const SESSION_RESET_KEY = "pn_session_reset";
/** Период фонового обновления при видимой вкладке. */
const REFRESH_MS = 3 * 60_000;
/** Сколько последних игр сессии показываем по умолчанию (остальное — счётчиком). */
const DEFAULT_ROWS_LIMIT = 12;
const ROWS_VARIANTS = [5, 10, 12, 25, 50] as const;
/** Базовый кегль тела панели; s/m/l масштабируют именно его. */
const BASE_FONT_PX = 12;

/** Настройки вида — как у чата: фон, заголовок, шрифт, сквозь клики. */
interface SessionPrefs extends ChromePrefs {
  /** Сколько строк игр видно. */
  rowsLimit: number;
}

const PREFS_KEY = "fp:session-stats:prefs";
const DEFAULT_PREFS: SessionPrefs = { ...CHROME_DEFAULTS, rowsLimit: DEFAULT_ROWS_LIMIT };

/**
 * Экспорт — шов для property-тестов враждебного localStorage страницы
 * (AGENTS.md §5): панель обязана пережить любую подстановку сайта.
 */
export function loadPrefs(): SessionPrefs {
  const raw = readPanelPrefsRaw(PREFS_KEY);
  const rowsLimit = ownField(raw, "rowsLimit");
  return {
    ...sanitizeChromePrefs(raw, DEFAULT_PREFS),
    rowsLimit: (ROWS_VARIANTS as readonly number[]).includes(rowsLimit as number)
      ? (rowsLimit as number)
      : DEFAULT_PREFS.rowsLimit,
  };
}
/** Строк истории за запрос: сессия — десятки игр, не тысячи (~65 КБ vs 660). */
const SESSION_PAGE_LIMIT = 200;

/**
 * Роль сайта → фрагмент спрайта. API отдаёт дона как `godfather` (живой
 * матч: role.type === "godfather"), а карта знала только `don` — дон
 * рисовался МИРНЫМ через молчаливый фолбэк (жалоба с profile/210,
 * 03.09.2026: «написано, что я был мирным»). BLACK_ROLES в crossover.ts
 * обе формы знал давно — карта спрайтов отстала.
 */
const ROLE_SPRITE: Record<string, string> = {
  civilian: "civilian",
  sheriff: "sheriff",
  mafia: "mafia",
  don: "godfather",
  godfather: "godfather",
};

function fmtDelta(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Насколько сводка свежая. Сводка трёхчасовой давности выглядела ровно как
 * только что полученная: обновление стоит в фоновой вкладке, а сетевая
 * ошибка молча оставляет прошлые данные (adversarial 27.08.2026).
 */
function freshness(at: number): string {
  if (!at) return "";
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return "обновлено только что";
  if (mins < 60) return `обновлено ${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  return `обновлено ${hours} ч назад`;
}

function deltaColor(n: number): string {
  if (n > 0) return "#4ade80";
  if (n < 0) return "#f87171";
  return "rgba(255,255,255,.65)";
}

class SessionStatsPanel extends FloatingPanel {
  private bodyEl: HTMLElement | null = null;
  private prefs: SessionPrefs = loadPrefs();
  private gearMenu: HTMLElement | null = null;
  private hoverStrip: HTMLElement | null = null;
  private unlockChip: HTMLElement | null = null;
  /** Последняя сводка — для перерисовки при смене шрифта/числа строк. */
  private lastRows: GameRow[] | null = null;
  /** Когда сводка получена: панель обязана честно говорить о своей давности. */
  private lastUpdatedAt = 0;

  /** Когда получена показанная сводка (0 — сводки ещё не было). */
  get updatedAt(): number {
    return this.lastUpdatedAt;
  }

  get isShown(): boolean {
    return this.isMounted && this.root.style.display !== "none";
  }

  constructor() {
    super({
      storageKey: "session-stats",
      title: "Мой вечер",
      width: 250,
      height: 320,
      minWidth: 210,
      minHeight: 160,
      resizable: true,
      className: "session-stats-panel",
    });
  }

  protected renderBody(body: HTMLElement): void {
    this.addHeaderButton("⟳", () => void refresh("кнопка"), "Обновить");
    this.addHeaderButton(
      "↺",
      () => void startNewSession(),
      "Начать сессию заново (счёт с нуля)",
    );
    this.addHeaderButton("⚙", () => this.toggleGearMenu(), "Настройки панели");
    this.addHeaderButton("×", () => sessionStatsFeature.requestClose(), "Закрыть");

    const el = document.createElement("div");
    Object.assign(el.style, {
      height: "100%",
      overflowY: "auto",
      padding: "6px",
      font: "12px/1.5 system-ui, sans-serif",
      color: "#fff",
    } as CSSStyleDeclaration);
    // Ховер строк — классом, не инлайновыми обработчиками: их исполнял бы
    // мир страницы под её CSP.
    const style = document.createElement("style");
    style.textContent =
      ".session-stats-panel .ss-row{display:flex;align-items:center;gap:6px;padding:3px 4px;" +
      "border-radius:6px;text-decoration:none;color:#fff;}" +
      ".session-stats-panel .ss-row:hover{background:rgba(255,255,255,.08);}" +
      ".session-stats-panel .ss-head{background:rgba(0,0,0,.25);border-radius:8px;" +
      "padding:6px 8px;margin-bottom:6px;}" +
      // Прозрачный режим: ни подложки сводки, ни подсветки строк.
      '.session-stats-panel[data-pn-dim="true"] .ss-head{background:transparent;' +
      "text-shadow:0 1px 3px rgba(0,0,0,.9);}" +
      '.session-stats-panel[data-pn-dim="true"] .ss-row{text-shadow:0 1px 3px rgba(0,0,0,.9);}' +
      '.session-stats-panel[data-pn-dim="true"] .ss-row:hover{background:transparent;}';
    body.appendChild(style);
    body.appendChild(el);
    this.bodyEl = el;

    this.gearMenu = buildGearMenu(this.root);
    this.hoverStrip = buildHoverStrip({
      root: this.root,
      onGear: () => this.toggleGearMenu(),
      onShowHeader: () => this.setPrefs({ headerHidden: false }),
      // Со скрытым заголовком уезжали три действия из четырёх, включая
      // «начать сессию заново» — главное действие фичи (adversarial
      // 27.08.2026).
      extra: [
        { label: "⟳", title: "Обновить", onClick: () => void refresh("кнопка") },
        { label: "↺", title: "Начать сессию заново", onClick: () => void startNewSession() },
        { label: "×", title: "Закрыть", onClick: () => sessionStatsFeature.requestClose() },
      ],
    });
    // Полоска — ручка перетаскивания, когда заголовка нет.
    this.enableDrag(this.hoverStrip, this.root);
    this.unlockChip = buildUnlockChip(
      this.root,
      "«Мой вечер» в режиме «сквозь клики». Нажмите, чтобы вернуть управление панелью",
      () => this.setPrefs({ clickThrough: false }),
    );
    this.applyPrefs();
    this.renderMessage("Загрузка…");
  }

  // ─────────────── настройки вида ───────────────

  private setPrefs(patch: Partial<SessionPrefs>, rerender = false): void {
    this.prefs = { ...this.prefs, ...patch };
    savePanelPrefs(PREFS_KEY, this.prefs);
    this.applyPrefs();
    if (rerender) this.rerender();
  }

  private applyPrefs(): void {
    applyChrome(this.prefs, {
      root: this.root,
      header: this.header,
      hoverStrip: this.hoverStrip,
      unlockChip: this.unlockChip,
      gearMenu: this.gearMenu,
      resizeHandles: this.resizeHandles,
    });
    if (this.bodyEl) {
      const font = `${(BASE_FONT_PX * FONT_SCALE[this.prefs.fontSize]).toFixed(1)}px/1.5 system-ui, sans-serif`;
      if (this.bodyEl.style.font !== font) this.bodyEl.style.font = font;
    }
    // «Фон 0%» обязан убирать фон ВЕСЬ, а не только рамку: на прозрачном
    // оверлее оставался тёмный прямоугольник сводки и подсветка строк
    // (adversarial 27.08.2026 — у чата этот ход был, у нас нет).
    const dim = this.prefs.bgOpacity / 100 < 0.3;
    if (this.root.dataset.pnDim !== String(dim)) this.root.dataset.pnDim = String(dim);
  }

  /** Перерисовать то, что уже показано (смена шрифта/числа строк). */
  private rerender(): void {
    if (this.lastRows) this.renderSession(this.lastRows, this.lastUpdatedAt);
  }

  private toggleGearMenu(): void {
    const menu = this.gearMenu;
    if (!menu) return;
    const opening = menu.style.display === "none";
    // Пересобираем при КАЖДОМ открытии: prefs меняются и мимо меню (чип-замок,
    // «▾» на полоске), и чекбоксы иначе врали бы.
    if (opening) this.populateGearMenu(menu);
    menu.style.display = opening ? "block" : "none";
  }

  private populateGearMenu(menu: HTMLElement): void {
    menu.replaceChildren();
    menu.appendChild(
      menuRow(
        "Фон",
        menuRange(
          this.prefs.bgOpacity,
          (v) => {
            // Живой предпросмотр без записи на диск; сохранение — по отпусканию.
            this.prefs = { ...this.prefs, bgOpacity: v };
            this.applyPrefs();
          },
          () => savePanelPrefs(PREFS_KEY, this.prefs),
        ),
      ),
    );
    menu.appendChild(
      menuRow(
        "Шрифт",
        menuSegmented(
          ["s", "m", "l"] as const,
          this.prefs.fontSize,
          (v) => v.toUpperCase(),
          (v) => this.setPrefs({ fontSize: v }, true),
        ),
      ),
    );
    menu.appendChild(
      menuRow(
        "Игр в списке",
        menuSelect(ROWS_VARIANTS, this.prefs.rowsLimit, (v) =>
          this.setPrefs({ rowsLimit: v }, true),
        ),
      ),
    );
    menu.appendChild(
      menuRow(
        "Заголовок",
        menuCheck(!this.prefs.headerHidden, (v) => this.setPrefs({ headerHidden: !v })),
      ),
    );
    menu.appendChild(
      menuRow(
        "Сквозь клики",
        menuCheck(this.prefs.clickThrough, (v) => this.setPrefs({ clickThrough: v })),
      ),
    );
    menu.appendChild(
      menuHint(
        "«Сквозь клики»: панель перестаёт ловить мышь; выход — замок в углу. " +
          "Размер тянется за правый край, нижний край и уголок.",
      ),
    );
  }

  renderMessage(text: string): void {
    if (!this.bodyEl) return;
    // Сводки больше нет — смена шрифта не должна воскресить старую.
    this.lastRows = null;
    this.bodyEl.innerHTML = `<div style="text-align:center;color:rgba(255,255,255,.6);padding:16px 6px;font-style:italic;">${escapeHtml(text)}</div>`;
  }

  /** Полная перерисовка сводки. Всё динамическое — через escapeHtml. */
  renderSession(rows: GameRow[], updatedAt = Date.now()): void {
    const el = this.bodyEl;
    if (!el) return;
    this.lastRows = rows;
    this.lastUpdatedAt = updatedAt;
    const limit = this.prefs.rowsLimit;
    const iconPx = Math.round(18 * FONT_SCALE[this.prefs.fontSize]);
    const s = summarizeSession(rows);
    const mmrLine =
      s.startMmr !== null && s.currentMmr !== null
        ? `<div style="display:flex;justify-content:space-between;margin-bottom:2px;">
             <span style="color:rgba(255,255,255,.6);">MMR</span>
             <span>${s.startMmr} → <b>${s.currentMmr}</b></span>
           </div>`
        : "";
    const head = `
      <div class="ss-head">
        ${mmrLine}
        <div style="display:flex;justify-content:space-between;">
          <span style="color:rgba(255,255,255,.6);">Игр: ${s.games} · Побед: ${s.wins}</span>
          <b style="color:${deltaColor(s.delta)};">${fmtDelta(s.delta)}</b>
        </div>
        <div style="color:rgba(255,255,255,.45);font-size:.85em;text-align:right;"
             title="Обновляется раз в 3 минуты при видимой вкладке; ⟳ — вручную">${escapeHtml(freshness(updatedAt))}</div>
      </div>`;
    if (rows.length === 0) {
      el.innerHTML = `${head}<div style="text-align:center;color:rgba(255,255,255,.6);padding:10px;font-style:italic;">Сессия пока пуста — удачной первой!</div>`;
      return;
    }
    const items = rows.slice(0, limit).map((r) => {
      const sprite = ROLE_SPRITE[r.role] ?? "civilian";
      const diff =
        typeof r.mmrDiff === "number"
          ? `<b style="color:${deltaColor(r.mmrDiff)};min-width:34px;text-align:right;">${fmtDelta(r.mmrDiff)}</b>`
          : `<span style="color:rgba(255,255,255,.4);min-width:34px;text-align:right;">—</span>`;
      const result = r.win
        ? `<span style="color:#4ade80;">победа</span>`
        : `<span style="color:#f87171;">поражение</span>`;
      return `
        <a href="/match/${r.id}" target="_blank" rel="noopener" class="ss-row"
           title="Открыть разбор матча №${r.id}${r.mode && r.mode !== "league" ? ` · режим: ${r.mode.replace(/[^a-z0-9_-]/gi, "")}` : ""}">
          <span style="width:${iconPx}px;height:${iconPx}px;flex:none;display:grid;place-items:center;">${createRoleSvg(sprite, iconPx)}</span>
          <span style="flex:1;">${result}</span>
          ${diff}
        </a>`;
    });
    const tail =
      rows.length > limit
        ? `<div style="text-align:center;color:rgba(255,255,255,.45);padding:4px;">…и ещё ${rows.length - limit}</div>`
        : "";
    el.innerHTML = head + items.join("") + tail;
  }
}

// ─────────────────────────── фича ───────────────────────────

interface SessionStatsFeature extends Feature {
  requestClose(): void;
}

let panel: SessionStatsPanel | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let manualResetMs: number | null = null;
/** Запрос уже в полёте — второй не шлём (кнопка + таймер могут совпасть). */
let inFlight = false;
/** Эпоха жизненного цикла: disable её инкрементирует, и висящий refresh
 *  прошлой жизни не трогает ни панель новой, ни дедуп (adversarial №4). */
let lifecycle = 0;
/** Сводка уже показана — фоновая ошибка сети её не стирает (adversarial №3). */
let hasRendered = false;
let unsubResetWatch: (() => void) | null = null;

async function loadManualReset(): Promise<void> {
  try {
    const res = (await browser.storage.local.get({ [SESSION_RESET_KEY]: null })) as Record<
      string,
      unknown
    >;
    const v = res[SESSION_RESET_KEY];
    manualResetMs = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    manualResetMs = null;
  }
}

async function startNewSession(): Promise<void> {
  manualResetMs = Date.now();
  try {
    await browser.storage.local.set({ [SESSION_RESET_KEY]: manualResetMs });
  } catch {
    /* хранилище недоступно — сброс проживёт вкладку */
  }
  log.info(SCOPE, "сессия начата заново");
  await refresh("новая сессия");
}

async function refresh(reason: string): Promise<void> {
  const p = panel;
  if (!p || !p.isShown || inFlight) return;
  const epoch = lifecycle;
  inFlight = true;
  try {
    const userId = await getOwnUserId();
    if (lifecycle !== epoch) return; // фичу выключили, пока ждали
    if (userId === null) {
      p.renderMessage("Профиль ещё не определён — зайдите на страницу поиска игры");
      return;
    }
    const page = await fetchFirstPage(userId, SESSION_PAGE_LIMIT);
    if (lifecycle !== epoch) return;
    if (!page) {
      // Показанную сводку сетевая икота не стирает: старые данные полезнее
      // таблички об ошибке, а следующий тик сам починит.
      if (!hasRendered) p.renderMessage("История игр не ответила — попробуйте обновить позже");
      else log.info(SCOPE, "обновление не удалось — оставлена прошлая сводка");
      return;
    }
    const games = pickSessionGames(page.rows, sessionAnchor(Date.now(), manualResetMs));
    p.renderSession(games);
    hasRendered = true;
    log.debug(SCOPE, "обновлено:", reason, `игр в сессии: ${games.length}`);
  } catch (e) {
    log.warn(SCOPE, "обновление не удалось", e);
    if (lifecycle === epoch && !hasRendered) {
      p.renderMessage("История игр не ответила — попробуйте обновить позже");
    }
  } finally {
    // Дедуп чужой жизни не трогаем: его уже сбросил disable.
    if (lifecycle === epoch) inFlight = false;
  }
}

export const sessionStatsFeature: SessionStatsFeature = {
  id: "session-stats",
  settingKey: "session_stats_enabled",

  enable() {
    panel = new SessionStatsPanel();
    panel.show();
    void loadManualReset().then(() => refresh("включение"));
    refreshTimer = setInterval(() => {
      // Скрытая вкладка не опрашивает чужой сервер впустую.
      if (!document.hidden) void refresh("таймер");
    }, REFRESH_MS);
    // «Начать заново» в ДРУГОЙ вкладке: якорь общий (storage.local), и обе
    // панели обязаны считать один и тот же вечер (adversarial №2).
    const onChanged = (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ): void => {
      if (area !== "local" || !(SESSION_RESET_KEY in changes)) return;
      const v = changes[SESSION_RESET_KEY]?.newValue;
      manualResetMs = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
      void refresh("сброс из другой вкладки");
    };
    // Возврат на вкладку будит обновление: фоновая вкладка не опрашивает
    // сервер, и стример, отвлёкшийся на Twitch, возвращался к сводке
    // трёхчасовой давности (adversarial 27.08.2026). Ждать ближайший тик
    // (до 3 минут) — ровно та ложь, ради которой панель и открыта.
    const onVisible = (): void => {
      if (document.hidden) return;
      // Частые alt-tab не должны стучаться в чужой сервер: свежую сводку
      // (моложе минуты) перезапрашивать незачем.
      if (panel && Date.now() - panel.updatedAt < 60_000) return;
      void refresh("вкладка снова видима");
    };
    document.addEventListener("visibilitychange", onVisible);
    const unsubVisibility = () => document.removeEventListener("visibilitychange", onVisible);
    browser.storage.onChanged.addListener(onChanged);
    unsubResetWatch = () => {
      browser.storage.onChanged.removeListener(onChanged);
      unsubVisibility();
    };
  },

  disable() {
    lifecycle++; // висящие refresh прошлой жизни отваливаются на гейте эпохи
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (unsubResetWatch) {
      unsubResetWatch();
      unsubResetWatch = null;
    }
    panel?.unmount();
    panel = null;
    inFlight = false;
    hasRendered = false;
  },

  requestClose() {
    // Прячем сразу: закрытие не должно ждать storage (и его отказа).
    panel?.hide();
    // Выключаем тумблер — FeatureManager затем вызовет disable().
    browser.storage.sync.set({ session_stats_enabled: false }).catch((e: unknown) => {
      log.warn(SCOPE, "не удалось сохранить закрытие панели", e);
    });
  },
};
