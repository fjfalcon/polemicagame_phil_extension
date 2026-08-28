/**
 * Окно «Заметка об игроке»: текст, метка, цвет ника и раскрытая палитра.
 *
 * Вынесено из player-notes.ts (арх-ревью 28.08.2026) после того, как данные
 * получили своего владельца (./notes-model) — до этого диалогу пришлось бы
 * отдавать два десятка методов менеджера.
 *
 * Всё пользовательское проходит через escapeHtml/cssAttr: и текст заметки, и
 * ник, и сохранённый цвет попадают в разметку САЙТА.
 */
import { escapeHtml } from "@core/escape";
import { log } from "@core/log";
import {
  idKey,
  isIdKey,
  isSafeNoteKey,
  MAX_OWN_NOTE_TEXT,
  NOTES_VERSION,
  withNickHistory,
  type NoteRecord,
} from "@core/notes-store";
import { TAG_PRESETS } from "./tag-palette";

const VERSION = NOTES_VERSION;
import { redactNick } from "@shared/redact";
import { cssAttr } from "./styles";
import type { ModalPort } from "./modal-port";

export function showNoteModal(port: ModalPort, username: string): void {
  // Оверлей (затемнение + клик мимо окна закрывает). Класс нужен для очистки в disable().
  const overlay = document.createElement("div");
  overlay.className = "polemica-note-modal";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 10000;
    background: rgba(0, 0, 0, 0.5);
    display: flex; align-items: center; justify-content: center;
  `;

  const modal = document.createElement("div");
  /**
   * max-height + overflow ОБЯЗАТЕЛЬНЫ. С 8.1.49 в окне две строки палитры
   * (метка и цвет ника), и на невысоком экране кнопки «Сохранить» уезжали
   * за нижний край без всякой возможности доскроллить: со стороны это
   * выглядело как «кнопки сохранения нет вообще» (жалоба 29.07.2026).
   */
  modal.style.cssText = `
    background: rgba(11, 27, 57, 0.97);
    padding: 20px; border-radius: 8px; min-width: 320px; max-width: 90vw;
    max-height: 90vh; overflow-y: auto;
    border: 1px solid rgba(79, 129, 245, 0.3);
    box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
  `;

  const title = document.createElement("h3");
  title.textContent = `Заметка для игрока ${username}`;
  title.style.cssText = "margin: 0 0 15px 0; color: white; font-size: 16px;";

  // Прежние ники: заметка живёт на вечном id, а человек мог переименоваться
  // — без этой строки узнать его было бы не по чему.
  const formerNicks = port.model.keys.formerNicks(username);
  const former = document.createElement("div");
  if (formerNicks.length > 0) {
    former.textContent = `Раньше играл как: ${formerNicks.join(", ")}`;
    former.style.cssText =
      "margin: -8px 0 12px 0; color: rgba(255,255,255,.65); font-size: 12px;";
  }

  const textarea = document.createElement("textarea");
  // Потолок ввода = потолок хранения (ревью 27.08.2026): раньше поле
  // принимало сколько угодно, а координатор молча резал при записи.
  textarea.maxLength = MAX_OWN_NOTE_TEXT;
  textarea.value = port.model.keys.text(username);
  textarea.style.cssText = `
    width: 100%;
    min-height: 100px;
    margin-bottom: 15px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: white;
    padding: 8px;
    resize: vertical;
    box-sizing: border-box;
  `;

  // ── выбор цветной метки и цвета ника (общая палитра) ──
  let selectedTag = port.model.keys.tag(username);
  // Цвет читаем сырым (мимо nick_colors_enabled): в диалоге видно и
  // редактируется то, что реально лежит в записи.
  let selectedNickColor = port.model.keys.rawNickColor(username);

  const mkLabel = (text: string): HTMLDivElement => {
    const label = document.createElement("div");
    label.textContent = text;
    label.style.cssText = "color: rgba(255,255,255,.7); font-size: 12px; margin-bottom: 6px;";
    return label;
  };
  const tagLabel = mkLabel("Метка (рамка плитки)");
  const nickColorLabel = mkLabel("Цвет ника");

  // Обе строки делят одну палитру (пресеты + свои цвета): удаление своего
  // цвета ПКМ обязано перерисовать обе, поэтому rebuild-ы собраны в список.
  const paletteRebuilds: Array<() => void> = [];
  const rebuildAll = () => paletteRebuilds.forEach((r) => r());

  const makePaletteRow = (
    getSel: () => string,
    setSel: (css: string) => void,
  ): HTMLDivElement => {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 8px; margin-bottom: 15px; flex-wrap: wrap;";

    const makeSwatch = (css: string, name: string, custom: boolean): HTMLButtonElement => {
      const sw = document.createElement("button");
      sw.dataset.css = css;
      sw.title = custom ? `${name} (ПКМ — удалить)` : name;
      sw.style.cssText = `
        width: 24px; height: 24px; border-radius: 50%; cursor: pointer; padding: 0;
        border: 1px solid rgba(255,255,255,.3); flex: 0 0 auto;
        background: ${css || "transparent"};
        outline: ${css === getSel() ? "2px solid #fff" : "2px solid transparent"};
        outline-offset: 2px; display: flex; align-items: center; justify-content: center;
      `;
      if (!css) {
        sw.textContent = "✕"; // «нет»
        sw.style.color = "rgba(255,255,255,.6)";
      }
      sw.addEventListener("click", () => {
        setSel(css);
        rebuildAll();
      });
      if (custom) {
        sw.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          // Подтверждение обязательно: ПКМ легко нажать случайно, а свой
          // цвет потом не восстановить — его нет в пресетах.
          if (!port.confirmRemoveCustomTag(css)) return;
          port.model.removeCustomTag(css);
          if (selectedTag === css) selectedTag = "";
          if (selectedNickColor === css) selectedNickColor = "";
          rebuildAll();
        });
      }
      return sw;
    };

    const rebuild = () => {
      row.replaceChildren();
      for (const { css, name } of TAG_PRESETS) row.appendChild(makeSwatch(css, name, false));
      for (const css of port.model.customTags) row.appendChild(makeSwatch(css, "свой цвет", true));

      /**
       * Кнопка «+» — выбрать свой цвет и сохранить в палитру.
       *
       * Инпут лежит ПОВЕРХ кнопки (прозрачный, во всю её площадь), клик
       * попадает прямо в него. Раньше кнопка звала `picker.click()` у
       * инпута размером 0×0 с pointer-events:none — Firefox считает такой
       * элемент невидимым и системную палитру для него не открывает:
       * кнопка нажималась, а окно выбора цвета не появлялось.
       */
      const wrap = document.createElement("span");
      wrap.style.cssText =
        "position: relative; width: 24px; height: 24px; flex: 0 0 auto; display: inline-block;";
      wrap.title = "Добавить свой цвет";

      const add = document.createElement("span");
      add.textContent = "+";
      add.style.cssText = `
        position: absolute; inset: 0; border-radius: 50%;
        border: 1px dashed rgba(255,255,255,.4); background: transparent; color: #fff;
        font-size: 15px; line-height: 1; display: grid; place-items: center;
        pointer-events: none;
      `;

      const picker = document.createElement("input");
      picker.type = "color";
      picker.value = "#3b82f6";
      // Инпут кликабелен и «видим» для браузера (нулевой прозрачности, но
      // с реальными размерами) — рисует его собой лежащая под ним кнопка.
      picker.style.cssText = `
        position: absolute; inset: 0; width: 100%; height: 100%;
        opacity: 0; cursor: pointer; padding: 0; border: none; background: none;
      `;
      picker.addEventListener("change", () => {
        const c = picker.value;
        if (c && !port.model.customTags.includes(c) && !TAG_PRESETS.some((p) => p.css === c)) {
          port.model.customTags.push(c);
          port.model.removedThisSession.delete(c);
          void port.model.saveCustomTags().then((ok) => {
            // Молчаливый провал записи оставлял цвет только в памяти: после
            // перезагрузки он исчезал (аудит безопасности, находка 8).
            if (!ok) port.toast("Не удалось сохранить цвет в палитру", true);
          });
        }
        setSel(c);
        rebuildAll();
      });
      wrap.append(add, picker);
      row.append(wrap);
    };
    paletteRebuilds.push(rebuild);
    rebuild();
    return row;
  };

  const tagRow = makePaletteRow(
    () => selectedTag,
    (css) => {
      selectedTag = css;
    },
  );
  const nickColorRow = makePaletteRow(
    () => selectedNickColor,
    (css) => {
      selectedNickColor = css;
    },
  );

  // ── общие действия ──
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    port.registerModal(() => undefined);
  };
  // disable() раньше сносил оверлей через remove() мимо close() — capture-слушатель
  // keydown оставался жить и продолжал глотать Escape и сохранять в отсоединённую форму.
  port.closeOpenModal();
  port.registerModal(close);

  // Что пользователь РЕАЛЬНО видел при открытии: если за время набора текста
  // статистика резолвила id и под u:-ключом появилась/жила запись, которую
  // он не видел, — не даём слепо перезаписать или удалить её.
  // let: после успешного сохранения под новым ключом ОН становится
  // «виденным» — иначе повторные «Сохранить» в живущей модалке считали бы
  // собственную запись чужой (удаление/снятие метки молча не работали бы).
  let openedKey = port.model.keys.keyFor(username);

  /** true — заметка записана; false — запись не удалась, окно закрывать нельзя. */
  const save = (): Promise<boolean> => port.model.enqueue(async (): Promise<boolean> => {
    if (!isSafeNoteKey(username)) {
      log.warn("player-notes", "unsafe username, note not saved", redactNick(username));
      return false;
    }
    const value = textarea.value.trim();
    // Пишем по id-ключу, если статистика уже резолвила игрока: такая заметка
    // переживёт смену ника и не перепутает тёзок. Если id не резолвлен, но
    // модалка открылась на id-записи, найденной по нику (фолбэк noteKeyFor),
    // пишем в неё же — иначе рядом рождался дубль под ником, который при
    // миграции побеждал по времени и стирал цвет игрока.
    const id = port.model.keys.userId(username);
    const key =
      id !== undefined ? idKey(id) : isIdKey(openedKey) ? openedKey : username;
    // Снапшот ВСЕХ затрагиваемых ключей для отката (id + ник-варианты).
    const touched = new Map<string, NoteRecord | string | undefined>();
    touched.set(key, port.model.notes[key]);
    const staleNickKeys = id !== undefined ? port.model.keys.nickKeys(username) : [];
    for (const nk of staleNickKeys) touched.set(nk, port.model.notes[nk]);

    const unseen = key !== openedKey ? port.model.notes[key] : undefined;
    if (value || selectedTag || selectedNickColor) {
      // Метка/цвет невидённой записи сохраняются, если пользователь свои не ставил.
      const unseenTag = unseen && typeof unseen !== "string" ? unseen.tag : undefined;
      const unseenColor = unseen && typeof unseen !== "string" ? unseen.nickColor : undefined;
      port.model.notes[key] = {
        text: value,
        timestamp: Date.now(),
        version: VERSION,
        tag: selectedTag || unseenTag || undefined,
        nickColor: selectedNickColor || unseenColor || undefined,
        // nick обязателен у ЛЮБОЙ id-записи (в т.ч. при записи в openedKey
        // без резолвленного id) — по нему работает фолбэк-поиск.
        ...(isIdKey(key) ? withNickHistory(port.model.notes[key], username) : {}),
      };
    } else if (unseen === undefined) {
      delete port.model.notes[key];
    }
    // else: пустое сохранение удаляет только то, что пользователь ВИДЕЛ
    // (ник-ключи ниже); невидённая u:-запись переживает.

    // Запись по id-ключу поглощает легаси-ники этого игрока.
    for (const nk of staleNickKeys) delete port.model.notes[nk];

    if (!(await port.model.saveNotes([key, ...staleNickKeys]))) {
      // Откатываем память под состояние хранилища, иначе интерфейс будет
      // показывать заметку, которой на диске нет.
      for (const [k, v] of touched) {
        if (v === undefined) delete port.model.notes[k];
        else port.model.notes[k] = v;
      }
      return false;
    }
    // Обе плитки игрока (десктоп/мобайл) + открытый тултип в портале.
    port.refreshPlayer(username);
    port.refreshTiles();
    port.refreshTiles();
    port.refreshTiles();
    // Сохранённый ключ теперь «виден» пользователю — следующие сохранения
    // в этой же модалке работают с ним как со своим.
    openedKey = key;
    return true;
  });

  // ── кнопки ──
  const mkBtn = (text: string, bg: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.textContent = text;
    b.style.cssText = `
      padding: 8px 16px; color: white; border: none; border-radius: 8px;
      cursor: pointer; font-size: 13px; background: ${bg};
    `;
    return b;
  };
  const saveBtn = mkBtn("Сохранить", "rgba(99, 102, 241, 0.3)");
  const saveCloseBtn = mkBtn("Сохранить и закрыть", "rgba(99, 102, 241, 0.6)");
  const closeBtn = mkBtn("Закрыть", "rgba(255, 255, 255, 0.12)");

  let savedHint: ReturnType<typeof setTimeout> | null = null;
  /** Фидбек по РЕАЛЬНОМУ результату записи: раньше «Сохранено ✓» рисовалось всегда. */
  const showResult = (btn: HTMLButtonElement, ok: boolean, label: string, bg: string) => {
    btn.textContent = ok ? "Сохранено ✓" : "Не сохранено!";
    btn.style.background = ok ? bg : "rgba(239, 68, 68, 0.7)";
    if (savedHint) clearTimeout(savedHint);
    savedHint = setTimeout(
      () => {
        btn.textContent = label;
        btn.style.background = bg;
      },
      ok ? 1200 : 4000,
    );
  };
  saveBtn.addEventListener("click", () => {
    void save().then((ok) =>
      showResult(saveBtn, ok, "Сохранить", "rgba(99, 102, 241, 0.3)"),
    );
  });
  saveCloseBtn.addEventListener("click", () => {
    // При неудачной записи окно НЕ закрываем — иначе текст заметки пропадёт.
    void save().then((ok) => {
      if (ok) close();
      else showResult(saveCloseBtn, false, "Сохранить и закрыть", "rgba(99, 102, 241, 0.6)");
    });
  });
  closeBtn.addEventListener("click", close);

  const buttons = document.createElement("div");
  // sticky: кнопки видны всегда, даже когда содержимое окна прокручивается.
  // bottom: -20px компенсирует padding модалки, чтобы полоса кнопок липла
  // ровно к её нижнему краю.
  buttons.style.cssText = `
    display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;
    position: sticky; bottom: -20px; padding: 12px 0 0;
    background: rgba(11, 27, 57, 0.97);
  `;
  buttons.append(closeBtn, saveBtn, saveCloseBtn);

  // ── закрытие по Esc / Ctrl+Enter сохранить-и-закрыть / клик мимо окна ──
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save().then((ok) => {
        if (ok) close();
      });
    }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  modal.append(title, former, textarea, tagLabel, tagRow, nickColorLabel, nickColorRow, buttons);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Фокус в поле, курсор в конец текста.
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}
