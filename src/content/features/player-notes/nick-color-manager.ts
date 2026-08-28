/**
 * Окно «Цвета ников»: все сохранённые записи одним списком — ник, id, цвет,
 * заметка; ручное добавление игрока по нику или id.
 *
 * Вынесено из player-notes.ts (арх-ревью 28.08.2026) вслед за моделью данных.
 * Список показывает и цветных, и просто «с заметкой»: раньше до нужного
 * игрока надо было ещё дожить в игре, чтобы поправить запись.
 *
 * Пользовательские данные — ники, тексты, сохранённые цвета — попадают в
 * разметку САЙТА, поэтому список строится узлами (textContent/createElement),
 * а не подстановкой в innerHTML.
 */
import { log } from "@core/log";
import { idKey, isIdKey, MAX_OWN_NOTE_TEXT } from "@core/notes-store";
import { redactNick } from "@shared/redact";
import { TAG_PRESETS } from "./tag-palette";
import type { ModalPort } from "./modal-port";

/**
 * Диалог «Цвета ников»: все сохранённые цвета одним списком — ник, id,
 * цвет; смена цвета по палитре и удаление. Открывается из попапа.
 */
export function openNickColorManager(port: ModalPort): void {
  const overlay = document.createElement("div");
  overlay.className = "polemica-note-modal";
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,.6);
    z-index: 10001; display: flex; align-items: center; justify-content: center;
  `;
  const modal = document.createElement("div");
  modal.style.cssText = `
    background: rgba(11, 27, 57, 0.97);
    padding: 20px; border-radius: 8px; min-width: 340px; max-width: 90vw;
    max-height: 80vh; overflow-y: auto;
    border: 1px solid rgba(79, 129, 245, 0.3);
    box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
  `;

  const title = document.createElement("h3");
  title.textContent = "Заметки и цвета игроков";
  title.style.cssText = "margin: 0 0 12px 0; color: white; font-size: 16px;";

  // ── добавление игрока вручную (по нику или id) ──
  const addWrap = document.createElement("div");
  addWrap.style.cssText =
    "margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.12);";
  const addRow = document.createElement("div");
  addRow.style.cssText = "display:flex;gap:8px;";
  const addInput = document.createElement("input");
  addInput.type = "text";
  addInput.placeholder = "Ник или id игрока";
  addInput.style.cssText =
    "flex:1 1 auto;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);" +
    "border-radius:6px;color:#fff;padding:6px 10px;font-size:13px;min-width:0;";
  const addBtn = document.createElement("button");
  addBtn.textContent = "Найти";
  addBtn.style.cssText =
    "padding:6px 14px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
    "font-size:13px;background:rgba(99,102,241,.5);flex:0 0 auto;";
  addRow.append(addInput, addBtn);
  /** Превью найденного игрока + палитра для выбора его цвета. */
  const addResult = document.createElement("div");
  addWrap.append(addRow, addResult);

  const renderAddResult = (found: { key: string; nick: string; id?: string }) => {
    addResult.replaceChildren();
    const info = document.createElement("div");
    info.textContent = found.id
      ? `${found.nick} (id ${found.id}) — выберите цвет или напишите заметку:`
      : `${found.nick} — id не найден, запись привяжется к нику. Выберите цвет или напишите заметку:`;
    info.style.cssText = "color:rgba(255,255,255,.75);font-size:12px;margin:10px 0 6px;";
    const palette = document.createElement("div");
    palette.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
    const options = [
      ...TAG_PRESETS.filter((p) => p.css).map((p) => ({ css: p.css, name: p.name })),
      ...port.model.customTags.map((css) => ({ css, name: "свой цвет" })),
    ];
    for (const opt of options) {
      const sw = document.createElement("button");
      sw.title = opt.name;
      sw.style.cssText = `
        width: 22px; height: 22px; border-radius: 50%; cursor: pointer; padding: 0;
        border: 1px solid rgba(255,255,255,.3); flex: 0 0 auto; background: ${opt.css};
      `;
      sw.addEventListener("click", () => {
        void port.model.setNickColor(found.key, opt.css, found.nick).then((ok) => {
          if (ok) {
            addInput.value = "";
            addResult.replaceChildren();
            flashSaved(found.key);
            render();
          } else showAddError("Не удалось сохранить — попробуй ещё раз.");
        });
      });
      palette.appendChild(sw);
    }

    // Заметка прямо здесь: игрока можно завести и без цвета — например,
    // записать «шумный, играет агрессивно» до первой встречи за столом.
    const area = document.createElement("textarea");
    area.maxLength = MAX_OWN_NOTE_TEXT; // см. выше: ввод не длиннее хранения
    area.placeholder = "Заметка (необязательно)";
    area.style.cssText = `
      width: 100%; min-height: 56px; box-sizing: border-box; resize: vertical;
      margin-top: 10px; background: rgba(255,255,255,.1);
      border: 1px solid rgba(255,255,255,.2); border-radius: 6px; color: #fff;
      padding: 7px; font: 13px/1.4 system-ui, sans-serif;
    `;
    area.addEventListener("keydown", (e) => e.stopPropagation());

    const saveNote = document.createElement("button");
    saveNote.textContent = "Сохранить заметку";
    saveNote.style.cssText =
      "margin-top:8px;padding:5px 12px;color:#fff;border:none;border-radius:6px;" +
      "cursor:pointer;font-size:12px;background:rgba(99,102,241,.6);float:right;";
    saveNote.addEventListener("click", () => {
      const text = area.value.trim();
      if (!text) {
        showAddError("Напишите текст заметки или выберите цвет.");
        return;
      }
      void port.model.setNoteText(found.key, text, found.nick).then((ok) => {
        if (ok) {
          addInput.value = "";
          addResult.replaceChildren();
          flashSaved(found.key);
          render();
        } else showAddError("Не удалось сохранить — попробуйте ещё раз.");
      });
    });

    addResult.append(info, palette, area, saveNote);
  };

  const showAddError = (text: string) => {
    addResult.replaceChildren();
    const err = document.createElement("div");
    err.textContent = text;
    err.style.cssText = "color:#f87171;font-size:12px;margin-top:8px;";
    addResult.appendChild(err);
  };

  const doFind = () => {
    const value = addInput.value.trim();
    if (!value) return;
    addBtn.disabled = true;
    addBtn.textContent = "Ищу…";
    void port.resolvePlayerInput(value)
      .then((found) => {
        if (found) renderAddResult(found);
        else showAddError("Игрок не найден — проверь ник или id.");
      })
      .finally(() => {
        addBtn.disabled = false;
        addBtn.textContent = "Найти";
      });
  };
  addBtn.addEventListener("click", doFind);
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doFind();
    }
    // Диалог живёт поверх страницы игры — хоткеи расширения не должны
    // срабатывать во время набора ника.
    e.stopPropagation();
  });

  const list = document.createElement("div");
  /** Ключ записи с раскрытой палитрой (одна за раз). */
  let expandedKey: string | null = null;
  /**
   * Ключ записи, которую только что сохранили: рядом с ней на пару секунд
   * появляется «Сохранено ✓». Кнопки «Сохранить» здесь нет намеренно —
   * запись уходит на диск сразу по клику, — но без подтверждения это
   * выглядело как «ничего не произошло», и владелец резонно спросил, где
   * же сохранение (жалоба 29.07.2026).
   */
  let savedKey: string | null = null;
  let savedTimer: ReturnType<typeof setTimeout> | null = null;
  const flashSaved = (key: string) => {
    savedKey = key;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedKey = null;
      if (overlay.isConnected) render();
    }, 2000);
  };

  const render = () => {
    list.replaceChildren();
    const entries = port.model.playerEntries();
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.textContent =
        "Пока пусто. Добавьте игрока по нику или id выше — или напишите заметку прямо в игре (кнопка ✎ на плитке).";
      empty.style.cssText = "color: rgba(255,255,255,.6); font-size: 13px; padding: 8px 0;";
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:10px;padding:7px 0;" +
        "border-bottom:1px solid rgba(255,255,255,.08);";

      const openColors = () => {
        expandedKey = expandedKey === `c:${entry.key}` ? null : `c:${entry.key}`;
        render();
      };
      const openNote = () => {
        expandedKey = expandedKey === `n:${entry.key}` ? null : `n:${entry.key}`;
        render();
      };

      const swatch = document.createElement("button");
      swatch.title = entry.color ? "Сменить цвет" : "Назначить цвет";
      swatch.style.cssText = `
        width: 20px; height: 20px; border-radius: 50%; cursor: pointer; padding: 0; flex: 0 0 auto;
        border: 1px ${entry.color ? "solid" : "dashed"} rgba(255,255,255,.35);
        background: ${entry.color || "transparent"};
      `;
      swatch.addEventListener("click", openColors);

      // Ник + превью заметки под ним: видно, кто это, не раскрывая строку.
      const who = document.createElement("div");
      who.style.cssText = "flex:1 1 auto;min-width:0;";
      const nick = document.createElement("div");
      nick.textContent = entry.nick;
      nick.style.cssText =
        "color:#fff;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      who.appendChild(nick);
      if (entry.text) {
        const preview = document.createElement("div");
        preview.textContent = entry.text;
        preview.title = entry.text;
        preview.style.cssText =
          "color:rgba(255,255,255,.5);font-size:11px;margin-top:1px;" +
          "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        who.appendChild(preview);
      }

      const idEl = document.createElement("span");
      idEl.textContent = entry.id ? `id ${entry.id}` : "без id";
      idEl.title = entry.id
        ? "Запись привязана к аккаунту и переживёт смену ника"
        : "Игрок ещё не резолвился в id — запись привязана к нику";
      idEl.style.cssText = "color:rgba(255,255,255,.45);font-size:11px;flex:0 0 auto;";

      const noteBtn = document.createElement("button");
      noteBtn.textContent = entry.text ? "Заметка" : "+ заметка";
      noteBtn.style.cssText =
        "padding:4px 10px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
        "font-size:12px;background:rgba(99,102,241,.3);flex:0 0 auto;";
      noteBtn.addEventListener("click", openNote);

      const colorBtn = document.createElement("button");
      colorBtn.textContent = "Цвет";
      colorBtn.style.cssText =
        "padding:4px 10px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
        "font-size:12px;background:rgba(99,102,241,.3);flex:0 0 auto;";
      colorBtn.addEventListener("click", openColors);

      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Удалить запись игрока целиком";
      del.style.cssText =
        "padding:4px 8px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
        "font-size:12px;background:rgba(239,68,68,.35);flex:0 0 auto;";
      del.addEventListener("click", () => {
        // Подтверждение: удаляется и заметка тоже, а не только цвет.
        const what = entry.text ? "заметку и цвет" : "цвет";
        if (!window.confirm(`Удалить ${what} игрока ${entry.nick}?`)) return;
        void port.model.deleteEntry(entry.key).then((ok) => {
          if (ok) {
            if (expandedKey?.endsWith(entry.key)) expandedKey = null;
            render();
          } else del.textContent = "ошибка";
        });
      });

      row.append(swatch, who, idEl);
      if (savedKey === entry.key) {
        const saved = document.createElement("span");
        saved.textContent = "Сохранено ✓";
        saved.style.cssText = "color:#22c55e;font-size:11px;flex:0 0 auto;";
        row.appendChild(saved);
      }
      row.append(noteBtn, colorBtn, del);
      list.appendChild(row);

      // ── раскрытая палитра ──
      if (expandedKey === `c:${entry.key}`) {
        const palette = document.createElement("div");
        palette.style.cssText =
          "display:flex;gap:8px;padding:8px 0 10px;flex-wrap:wrap;" +
          "border-bottom:1px solid rgba(255,255,255,.08);";
        const options = [
          { css: "", name: "без цвета" },
          ...TAG_PRESETS.filter((p) => p.css).map((p) => ({ css: p.css, name: p.name })),
          ...port.model.customTags.map((css) => ({ css, name: "свой цвет" })),
        ];
        for (const opt of options) {
          const sw = document.createElement("button");
          sw.title = opt.name;
          sw.style.cssText = `
            width: 22px; height: 22px; border-radius: 50%; cursor: pointer; padding: 0;
            border: 1px ${opt.css ? "solid" : "dashed"} rgba(255,255,255,.35); flex: 0 0 auto;
            background: ${opt.css || "transparent"}; color: rgba(255,255,255,.6);
            display: grid; place-items: center; font-size: 11px;
            outline: ${opt.css === entry.color ? "2px solid #fff" : "2px solid transparent"};
            outline-offset: 2px;
          `;
          if (!opt.css) sw.textContent = "✕";
          sw.addEventListener("click", () => {
            void port.model.setNickColor(entry.key, opt.css).then((ok) => {
              if (ok) {
                expandedKey = null;
                flashSaved(entry.key);
                render();
              }
            });
          });
          palette.appendChild(sw);
        }
        list.appendChild(palette);
      }

      // ── раскрытый редактор заметки ──
      if (expandedKey === `n:${entry.key}`) {
        const editor = document.createElement("div");
        editor.style.cssText =
          "padding:8px 0 12px;border-bottom:1px solid rgba(255,255,255,.08);";
        const area = document.createElement("textarea");
        area.maxLength = MAX_OWN_NOTE_TEXT;
        area.value = entry.text;
        area.placeholder = "Что важно помнить об этом игроке";
        area.style.cssText = `
          width: 100%; min-height: 70px; box-sizing: border-box; resize: vertical;
          background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2);
          border-radius: 6px; color: #fff; padding: 8px; font: 13px/1.4 system-ui, sans-serif;
        `;
        // Хоткеи расширения не должны срабатывать при наборе текста.
        area.addEventListener("keydown", (e) => e.stopPropagation());

        const bar = document.createElement("div");
        bar.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:8px;";
        const cancel = document.createElement("button");
        cancel.textContent = "Отмена";
        cancel.style.cssText =
          "padding:5px 12px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
          "font-size:12px;background:rgba(255,255,255,.12);";
        cancel.addEventListener("click", () => {
          expandedKey = null;
          render();
        });
        const save = document.createElement("button");
        save.textContent = "Сохранить";
        save.style.cssText =
          "padding:5px 12px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
          "font-size:12px;background:rgba(99,102,241,.6);";
        const doSave = () => {
          void port.model.setNoteText(entry.key, area.value.trim()).then((ok) => {
            if (ok) {
              expandedKey = null;
              flashSaved(entry.key);
              render();
            } else save.textContent = "не сохранилось";
          });
        };
        save.addEventListener("click", doSave);
        area.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            doSave();
          }
        });
        bar.append(cancel, save);
        editor.append(area, bar);
        list.appendChild(editor);
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      }
    }
  };
  render();

  /**
   * Блок «Мои цвета» — управление собственной палитрой.
   * Раньше свой цвет удалялся только правой кнопкой по кружку в диалоге
   * заметки: об этом знал лишь тот, кто читал подсказку, и делалось это
   * без подтверждения.
   */
  const myColors = document.createElement("div");
  myColors.style.cssText = "margin-top:14px;";
  const renderMyColors = () => {
    myColors.replaceChildren();
    if (port.model.customTags.length === 0) return;
    const label = document.createElement("div");
    label.textContent = "Мои цвета";
    label.style.cssText = "color:rgba(255,255,255,.7);font-size:12px;margin-bottom:6px;";
    const rowEl = document.createElement("div");
    rowEl.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;";
    for (const css of port.model.customTags) {
      const item = document.createElement("span");
      item.style.cssText = "position:relative;width:24px;height:24px;flex:0 0 auto;";
      const dot = document.createElement("span");
      dot.style.cssText = `
        position:absolute; inset:0; border-radius:50%; background:${css};
        border:1px solid rgba(255,255,255,.3);
      `;
      const kill = document.createElement("button");
      kill.textContent = "✕";
      kill.title = "Удалить этот цвет из палитры";
      kill.style.cssText = `
        position:absolute; top:-6px; right:-6px; width:16px; height:16px;
        border:none; border-radius:50%; cursor:pointer; padding:0;
        background:rgba(239,68,68,.9); color:#fff; font-size:10px; line-height:1;
        display:grid; place-items:center;
      `;
      kill.addEventListener("click", () => {
        if (!port.confirmRemoveCustomTag(css)) return;
        port.model.removeCustomTag(css);
        renderMyColors();
        // Раскрытая палитра игрока строится из тех же customTags —
        // перерисовываем список, иначе удалённый цвет ещё виден в ней.
        render();
      });
      item.append(dot, kill);
      rowEl.appendChild(item);
    }
    myColors.append(label, rowEl);
  };
  renderMyColors();

  const hint = document.createElement("div");
  hint.textContent =
    "Цвет применяется сразу; заметка — по кнопке «Сохранить» (или Ctrl+Enter). " +
    "То же самое можно делать прямо в игре — кнопка ✎ на плитке игрока.";
  hint.style.cssText = "color:rgba(255,255,255,.45);font-size:11px;margin:10px 0 12px;";

  const closeBtn = document.createElement("button");
  // «Готово», а не «Закрыть»: закрытие ничего не отменяет и не сохраняет —
  // всё уже на диске, кнопка просто убирает окно.
  closeBtn.textContent = "Готово";
  closeBtn.style.cssText =
    "padding:8px 16px;color:#fff;border:none;border-radius:8px;cursor:pointer;" +
    "font-size:13px;background:rgba(255,255,255,.12);display:block;margin-left:auto;";

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    port.unregisterModal(close);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  port.closeOpenModal();
  port.registerModal(close);
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  modal.append(title, addWrap, list, myColors, hint, closeBtn);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}
