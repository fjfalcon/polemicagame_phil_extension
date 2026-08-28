/**
 * Метки ролей («мой read»). У каждого игрока — квадратик; по клику выпадает список
 * ролей. Выбранная роль красит квадратик.
 *
 * Хранится в storage.local с привязкой к игре (gameKey): переживает перезагрузку
 * страницы (F5) в рамках одной игры и сбрасывается для новой игры.
 * gameKey = id матча/игры (из URL или встроенных данных), иначе подпись состава.
 */
import { browser } from "@core/env";
import { onDomChange } from "@core/dom";
import { log } from "@core/log";
import { showToast } from "@core/toast";
import { SITE, SITE_CLASS } from "@core/selectors";
import { createRoleSvg } from "../role-sprite";
import type { Feature } from "@core/feature";

interface RoleDef {
  id: string;
  label: string;
  abbr: string;
  color: string;
  text: string;
  /** id фрагмента в спрайте сайта; none иконки не имеет. */
  sprite?: string;
}

// Цвета: Мирный — красный, Шериф — жёлтый, Мафия — серый, Дон — фиолетовый.
// «Серый» (по умолчанию) = нейтральный тёмный «?», отличается от серой Мафии.
// В квадратике рисуется ИКОНКА САЙТА (просьба владельца 15.08.2026), abbr
// остался фолбэком на случай, если спрайт не загрузится.
const ROLES: RoleDef[] = [
  { id: "none", label: "Серый (сброс)", abbr: "?", color: "#9ca3af", text: "#111827" },
  { id: "civ", label: "Мирный", abbr: "Мир", color: "#ef4444", text: "#ffffff", sprite: "civilian" },
  { id: "sheriff", label: "Шериф", abbr: "Шер", color: "#eab308", text: "#2b2000", sprite: "sheriff" },
  { id: "mafia", label: "Мафия", abbr: "Маф", color: "#374151", text: "#cbd5e1", sprite: "mafia" },
  // Дон в спрайте сайта зовётся godfather (тот же id, что у истории игр).
  { id: "don", label: "Дон", abbr: "Дон", color: "#9333ea", text: "#ffffff", sprite: "godfather" },
];
const roleById = (id: string) => ROLES.find((r) => r.id === id) || ROLES[0];

const STORAGE_KEY = "roleMarks";
const MAX_GAMES = 50;
const MARKER_CLASS = "pn-role-marker";
const MENU_CLASS = "pn-role-menu";

type Marks = Record<string, string>; // username -> roleId
let storeAll: Record<string, Marks> = {}; // gameKey -> Marks
let gameKey: string | null = null;
let marks: Marks = {};

/** Иконки сайта в метке (настройка role_marker_icons_enabled). */
let useIcons = true;
let offDom: (() => void) | null = null;
let closeMenu: (() => void) | null = null;
/** Отложенная (на тик) подписка меню на клик вне его — гасится вместе с меню. */
let armTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let lastPath = "";
let onStorageChanged:
  | ((changes: Record<string, { newValue?: unknown }>, area: string) => void)
  | null = null;
let onPageHide: (() => void) | null = null;

function usernameOf(player: Element): string | null {
  const name = player.querySelector(SITE.playerName)?.textContent?.trim();
  return name || null;
}

function resolveGameKey(): string | null {
  // 1) id матча/игры в URL. ВАЖНО: у комнаты путь просто "/game", а id
  // приходит query-параметром (сайт сам строит "/game?role=viewer&game_id=N")
  // — без этого ключ падал на подпись состава, и рематч тем же составом
  // наследовал метки прошлой игры (аудит устойчивости 01.08.2026, №8).
  const qId = new URLSearchParams(location.search).get("game_id");
  if (qId && /^\d+$/.test(qId)) return `g:${qId}`;
  const mUrl = location.pathname.match(/\/(?:match|game|room)\/(\d+)/);
  if (mUrl) return `g:${mUrl[1]}`;
  // 2) видимый номер игры в шапке комнаты (.game-info-block .game-id)
  const infoText = document
    .querySelector(SITE.gameIdBlock)
    ?.textContent?.match(/\d+/)?.[0];
  if (infoText) return `g:${infoText}`;
  // 2) data-game-id
  const byAttr = document.querySelector("[data-game-id]")?.getAttribute("data-game-id");
  if (byAttr && /^\d+$/.test(byAttr)) return `g:${byAttr}`;
  // 3) встроенные данные игры (как у match-parser)
  const raw = document.querySelector("[data-game]")?.getAttribute("data-game");
  if (raw) {
    try {
      const id = JSON.parse(raw)?.id;
      if (id) return `g:${id}`;
    } catch {
      /* не JSON */
    }
  }
  // 4) фолбэк: подпись состава (отсортированные ники)
  // Судья рендерится тем же компонентом .player (с классом .judge-player):
  // он не игрок — не должен ни получать метку, ни менять подпись состава.
  const names = Array.from(document.querySelectorAll(SITE.player))
    .filter((p) => !p.classList.contains(SITE_CLASS.judgePlayer))
    .map((p) => p.querySelector(SITE.playerName)?.textContent?.trim())
    .filter((n): n is string => !!n);
  if (names.length >= 4) return "l:" + names.slice().sort().join("|");
  return null;
}

/** Чтение упало — писать нельзя (иначе затрём чужую историю). */
let readOnly = false;
/** Про отказ уже сказали: десять размеченных плиток не должны дать десять
 *  одинаковых строк (тот же приём, что в пакетах C и PN-1). */
let readOnlyLogged = false;
let noGameLogged = false;

/** Немедленная запись (используется и таймером, и flush'ем). */
function writeNow(): void {
  if (readOnly) return;
  // Ограничиваем число хранимых игр.
  const keys = Object.keys(storeAll);
  if (keys.length > MAX_GAMES) {
    for (const k of keys.slice(0, keys.length - MAX_GAMES)) delete storeAll[k];
  }
  // Результат записи проверяем: молчаливый отказ (квота) оставлял метку
  // на экране, но после перезагрузки она исчезала (находка 8).
  void browser.storage.local.set({ [STORAGE_KEY]: storeAll }).catch((e) => {
    log.error("role-marker", "save failed", e);
  });
}

/**
 * Метка — пользовательский ввод, и терять её нельзя.
 *
 * Раньше запись откладывалась на 400 мс, а хвост дописывался по `pagehide`,
 * который «браузерами доставляется НЕнадёжно» (MDN): резкое закрытие вкладки
 * в эти 400 мс теряло метку (аудит lifecycle 01.08.2026, находка 19).
 * Теперь пишем сразу, а дебаунс оставлен только как коалесценция подряд
 * идущих кликов — но первая запись уходит немедленно.
 */
let dirtyMarks = false;

function scheduleSave(): void {
  if (readOnly) return;
  dirtyMarks = true;
  if (saveTimer) {
    // Серия кликов: окно уже открыто — допишем по его истечении.
    clearTimeout(saveTimer);
  } else {
    // Первое изменение пишем НЕМЕДЛЕННО, не дожидаясь окна.
    writeNow();
    dirtyMarks = false;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Без флага одиночный клик писал в storage ДВАЖДЫ (и дважды будил
    // storage.onChanged во всех контекстах) — ревью пакета D.
    if (dirtyMarks) {
      writeNow();
      dirtyMarks = false;
    }
  }, 400);
}

function persist(): void {
  if (readOnly) {
    // Квадрат уже перекрашен, и человек считает метку сохранённой. Раньше
    // отказ был нем в обе стороны — ни в файле, ни на экране (аудит
    // наблюдаемости 02.08.2026, RM-2).
    if (!readOnlyLogged) {
      readOnlyLogged = true;
      log.warn("role-marker", "метка не сохранена: хранилище только для чтения");
    }
    showToast("Метка не сохранится: не удалось прочитать историю меток", {
      key: "role-marker-readonly",
      kind: "warn",
    });
    return;
  }
  if (!gameKey) {
    // Игра ещё не опознана (id/состав не готовы): запись некуда деть.
    if (!noGameLogged) {
      noGameLogged = true;
      log.warn("role-marker", "метка пока не сохранена: игра ещё не опознана");
    }
    showToast("Метка пока не сохранится: игра ещё не опознана, попробуйте через пару секунд", {
      key: "role-marker-no-game",
      kind: "warn",
    });
    return;
  }
  if (Object.keys(marks).length) storeAll[gameKey] = { ...marks };
  else delete storeAll[gameKey];
  scheduleSave();
}

/**
 * Красит квадратик — ТОЛЬКО если роль реально изменилась.
 *
 * Важно: общий наблюдатель следит за атрибутом style и childList. Безусловная
 * запись style/textContent здесь порождала цикл «мутация → scan → мутация»
 * на частоте кадров и подвешивала страницу. Сверяемся с dataset.role и выходим.
 */
export function paintMarker(marker: HTMLElement, roleId: string): void {
  // В ключе идемпотентности и ВИД: смена настройки «иконки/текст» обязана
  // перерисовать метку с той же ролью, а прежний гейт по одной роли её
  // пропускал бы до конца игры.
  const paintKey = `${roleId}|${useIcons ? "icon" : "text"}`;
  if (marker.dataset.role === paintKey) return;
  const r = roleById(roleId);
  marker.dataset.role = paintKey;
  marker.style.background = r.color;
  marker.style.color = r.text;
  // Иконка сайта вместо подписи «Мир/Шер/Дон» — те же фрагменты спрайта, что
  // рисует сама комната. Сброс («?») остаётся текстом: у него иконки нет.
  if (useIcons && r.sprite) marker.innerHTML = createRoleSvg(r.sprite, 14);
  else marker.textContent = r.abbr;
  marker.title = `Мой read: ${r.label}`;
}

/** Тестовый шов и приёмник настройки. */
export function setRoleMarkerIcons(on: boolean): void {
  useIcons = on;
}

function openMenu(marker: HTMLElement, username: string): void {
  closeMenu?.();
  const menu = document.createElement("div");
  menu.className = MENU_CLASS;
  const rect = marker.getBoundingClientRect();
  menu.style.cssText = `
    position: fixed; top: ${rect.bottom + 4}px; left: ${rect.left}px; z-index: 2147483600;
    background: #1e1f26; border: 1px solid rgba(255,255,255,.15); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); padding: 4px; min-width: 130px;
    font: 12px system-ui, sans-serif;
  `;

  for (const r of ROLES) {
    const item = document.createElement("button");
    item.style.cssText = `
      display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
      background: transparent; border: none; color: #e6e9f0; cursor: pointer;
      padding: 6px 8px; border-radius: 6px; font: inherit;
    `;
    item.addEventListener("mouseenter", () => (item.style.background = "rgba(255,255,255,.08)"));
    item.addEventListener("mouseleave", () => (item.style.background = "transparent"));
    // В меню — цветной квадратик С ИКОНКОЙ, ровно как будет выглядеть метка.
    item.innerHTML =
      `<span style="width:16px;height:16px;border-radius:4px;flex:0 0 auto;border:1px solid rgba(0,0,0,.4);` +
      `background:${r.color};display:inline-flex;align-items:center;justify-content:center;color:${r.text}">` +
      `${r.sprite ? createRoleSvg(r.sprite, 11) : r.abbr}</span><span>${r.label}</span>`;
    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (r.id === "none") delete marks[username];
      else marks[username] = r.id;
      paintMarker(marker, r.id);
      persist();
      closeMenu?.();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  const onOutside = (e: Event) => {
    if (!menu.contains(e.target as Node) && e.target !== marker) closeMenu?.();
  };
  closeMenu = () => {
    // Подписка могла ещё не состояться: гасим её вместе с меню, иначе
    // disable() закрывал меню, а через тик мы вешали на document слушатели,
    // которые снять уже некому (§4.7, тест-набор 01.08.2026, №10).
    if (armTimer !== null) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    document.removeEventListener("click", onOutside, true);
    window.removeEventListener("scroll", closeMenu as () => void, true);
    menu.remove();
    closeMenu = null;
  };
  // Тик задержки нужен, чтобы клик, открывший меню, не закрыл его сразу же.
  armTimer = setTimeout(() => {
    armTimer = null;
    document.addEventListener("click", onOutside, true);
    window.addEventListener("scroll", closeMenu as () => void, true);
  }, 0);
}

function ensureMarker(player: HTMLElement): void {
  // Судья — не игрок: метка «мой read» на нём бессмысленна (тот же компонент
  // .player, отличается классом .judge-player).
  if (player.classList.contains(SITE_CLASS.judgePlayer)) return;
  const username = usernameOf(player);
  if (!username) return;
  let marker = player.querySelector<HTMLElement>(`.${MARKER_CLASS}`);
  if (!marker) {
    if (getComputedStyle(player).position === "static") player.style.position = "relative";
    marker = document.createElement("button");
    marker.className = MARKER_CLASS;
    marker.style.cssText = `
      position: absolute; top: 6px; left: 6px; width: 26px; height: 24px;
      border-radius: 6px; border: 1px solid rgba(0,0,0,.45); cursor: pointer; z-index: 6;
      font: 700 10px system-ui, sans-serif; display: flex; align-items: center;
      justify-content: center; padding: 0;
    `;
    marker.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(marker!, usernameOf(player) || username);
    });
    player.appendChild(marker);
  }
  if (marker.dataset.username !== username) marker.dataset.username = username;
  paintMarker(marker, marks[username] || "none");
}

/**
 * Пересчитывать ключ игры на каждый батч мутаций дорого: фолбэк перебирает
 * весь состав и сортирует ники. Стабильный ключ (из URL/атрибута) кэшируем,
 * пока не сменился путь.
 */
function refreshGameKey(): string | null {
  if (gameKey?.startsWith("g:") && location.pathname === lastPath) return gameKey;
  lastPath = location.pathname;
  return resolveGameKey();
}

function scan(): void {
  const key = refreshGameKey();
  if (key && key !== gameKey) {
    const hadResolvedKey = gameKey !== null;
    gameKey = key;
    if (storeAll[key]) {
      marks = { ...storeAll[key] };
    } else if (!hadResolvedKey && Object.keys(marks).length) {
      // Метки сделаны до того, как gameKey определился — привяжем их к игре.
      // Только при ПЕРВОМ резолве: при смене игры (key был и поменялся) эта
      // ветка копировала реды прошлой партии в новую — совпадающие ники
      // получали чужой «мой read».
      storeAll[key] = { ...marks };
      scheduleSave();
    } else {
      marks = {};
    }
  }
  document.querySelectorAll<HTMLElement>(SITE.player).forEach(ensureMarker);
}

export const roleMarkerFeature: Feature = {
  id: "role-marker",
  settingKey: "role_marker_enabled",
  update(ctx) {
    setRoleMarkerIcons(ctx.settings.role_marker_icons_enabled !== false);
    // Перерисовать уже стоящие метки: paintKey сменился, scan закрасит заново.
    scan();
  },
  async enable(ctx) {
    setRoleMarkerIcons(ctx.settings.role_marker_icons_enabled !== false);
    let res: { [STORAGE_KEY]: Record<string, Marks> };
    try {
      res = (await browser.storage.local.get({ [STORAGE_KEY]: {} })) as typeof res;
    } catch (e) {
      // Тот же гейт, что у заметок: пустая карта после СБОЯ чтения — не
      // «истории нет». Без него первая же метка записывала пустой снимок
      // поверх всей истории (до 50 игр) — аудит lifecycle 01.08.2026, №8.
      log.error("role-marker", "load failed", e);
      readOnly = true;
      res = { [STORAGE_KEY]: {} };
    }
    storeAll = res[STORAGE_KEY] || {};
    gameKey = null;
    marks = {};
    scan();
    // Троттлим: разметка игроков не требует реакции на каждый кадр.
    offDom = onDomChange(() => {
      if (scanTimer) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        scan();
      }, 250);
    });
    // Синхронизация между вкладками: раньше снапшот жил до перезагрузки, и
    // вторая вкладка при записи затирала метки, сделанные в первой.
    onStorageChanged = (changes, area) => {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      const next = changes[STORAGE_KEY].newValue as Record<string, Marks> | undefined;
      if (!next) return;
      storeAll = next;
      if (gameKey && storeAll[gameKey]) {
        marks = { ...storeAll[gameKey] };
        document
          .querySelectorAll<HTMLElement>(SITE.player)
          .forEach((p) => {
            const marker = p.querySelector<HTMLElement>(`.${MARKER_CLASS}`);
            const name = usernameOf(p);
            if (marker && name) paintMarker(marker, marks[name] || "none");
          });
      }
    };
    browser.storage.onChanged.addListener(onStorageChanged);
    // Дебаунс 400 мс терял метку при F5/закрытии вкладки — доталкиваем.
    onPageHide = () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        void browser.storage.local.set({ [STORAGE_KEY]: storeAll });
      }
    };
    window.addEventListener("pagehide", onPageHide);
    log.info("role-marker", "enabled", Object.keys(storeAll).length, "games stored");
  },
  disable() {
    readOnly = false;
    readOnlyLogged = false;
    noGameLogged = false;
    offDom?.();
    offDom = null;
    closeMenu?.();
    document.querySelectorAll(`.${MARKER_CLASS}, .${MENU_CLASS}`).forEach((el) => el.remove());
    if (onStorageChanged) {
      browser.storage.onChanged.removeListener(onStorageChanged);
      onStorageChanged = null;
    }
    if (onPageHide) {
      window.removeEventListener("pagehide", onPageHide);
      onPageHide = null;
    }
    if (saveTimer) {
      // Не теряем несохранённое: дебаунс отменяем, но пишем сразу.
      clearTimeout(saveTimer);
      saveTimer = null;
      void browser.storage.local.set({ [STORAGE_KEY]: storeAll });
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    gameKey = null;
    lastPath = "";
    marks = {};
  },
};
