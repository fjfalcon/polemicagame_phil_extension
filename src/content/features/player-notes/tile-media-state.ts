/**
 * Что игрок сделал с чужими плитками: мьют, переворот камеры, скрытие видео.
 *
 * Вынесено из player-notes.ts (арх-ревью 28.08.2026) по кластеру владения
 * состоянием: четыре набора ников и ДВА разных хранилища с разными правилами
 * жизни, которые к тому же легко перепутать:
 *
 *  • мьют — storage.local, переживает перезагрузку и общий для вкладок,
 *    поэтому пишется СЛИЯНИЕМ (иначе вкладка со старым списком затирала бы
 *    мьюты соседней — аудит безопасности 01.08.2026, находка 8);
 *  • переворот камеры — sessionStorage вкладки: это «на эту игру», а не
 *    навсегда;
 *  • скрытие видео — только память: между играми плитки другие.
 *
 * Модуль НЕ трогает DOM: он отвечает на вопрос «что игрок решил про этого
 * человека», а красит плитки и кнопки сама фича.
 */
import { browser } from "@core/env";
import { log } from "@core/log";
import { parseFlippedPlayers } from "./flipped-players";

/** storage.local: массив ников (lowercase) с выключенным у нас звуком. */
export const MUTED_PLAYERS_KEY = "pn_muted_players";
/** sessionStorage: перевёрнутые камеры — на текущую вкладку, не навсегда. */
export const FLIPPED_PLAYERS_KEY = "pn_flipped_players";

export interface TileMediaContext {
  /** Сообщить пользователю о неудачной записи: мьют иначе молча слетал бы. */
  onPersistError(message: string): void;
  /** Мьюты изменились в ДРУГОЙ вкладке — перекрасить плитки здесь. */
  onExternalMuteChange(): void;
}

export class TileMediaState {
  /** Ники (lowercase) с выключённым звуком. */
  private muted = new Set<string>();
  /**
   * Снятые в ЭТОЙ вкладке мьюты: при слиянии с диском они не должны
   * воскресать из чужого списка.
   */
  private unmutedHere = new Set<string>();
  /** Ники с перевёрнутой камерой (sessionStorage вкладки). */
  private flipped = new Set<string>();
  /** Ники со скрытым видео — только в памяти. */
  private hidden = new Set<string>();

  constructor(private readonly ctx: TileMediaContext) {}

  // ─────────── мьют ───────────

  isMuted(username: string): boolean {
    return this.muted.has(username.toLowerCase());
  }

  /** Переключить мьют и сохранить. Возвращает новое состояние. */
  toggleMute(username: string): boolean {
    const key = username.toLowerCase();
    if (this.muted.has(key)) {
      this.muted.delete(key);
      this.unmutedHere.add(key);
    } else {
      this.muted.add(key);
      this.unmutedHere.delete(key);
    }
    this.persistMuted();
    return this.muted.has(key);
  }

  async loadMuted(): Promise<void> {
    try {
      const res = await browser.storage.local.get({ [MUTED_PLAYERS_KEY]: [] });
      const list = res[MUTED_PLAYERS_KEY];
      if (Array.isArray(list)) {
        for (const u of list) if (typeof u === "string" && u) this.muted.add(u);
      }
    } catch (e) {
      log.warn("player-notes", "muted players load failed", e);
    }
  }

  /** Список пришёл из другой вкладки (storage.onChanged). */
  adoptExternalMuted(next: unknown): void {
    if (!Array.isArray(next)) return;
    this.muted = new Set(next.filter((u): u is string => typeof u === "string" && u !== ""));
    this.ctx.onExternalMuteChange();
  }

  private persistMuted(): void {
    void (async () => {
      try {
        const cur = (await browser.storage.local.get({ [MUTED_PLAYERS_KEY]: [] })) as Record<
          string,
          unknown
        >;
        const disk = Array.isArray(cur[MUTED_PLAYERS_KEY])
          ? (cur[MUTED_PLAYERS_KEY] as string[])
          : [];
        // Снятые в ЭТОЙ вкладке мьюты не должны воскресать из дискового списка.
        const merged = new Set([...disk.filter((n) => !this.unmutedHere.has(n))]);
        for (const n of this.muted) merged.add(n);
        await browser.storage.local.set({ [MUTED_PLAYERS_KEY]: [...merged] });
      } catch (e) {
        log.warn("player-notes", "muted players save failed", e);
        this.ctx.onPersistError("Не удалось сохранить мьют — он слетит после перезагрузки");
      }
    })();
  }

  // ─────────── переворот камеры ───────────

  isFlipped(username: string): boolean {
    return this.flipped.has(username.toLowerCase());
  }

  setFlipped(username: string, flipped: boolean): void {
    const key = username.toLowerCase();
    if (flipped) this.flipped.add(key);
    else this.flipped.delete(key);
    this.persistFlipped();
  }

  loadFlipped(): void {
    try {
      // Разбор и cap — в parseFlippedPlayers (источник недоверенный).
      this.flipped = parseFlippedPlayers(sessionStorage.getItem(FLIPPED_PLAYERS_KEY));
    } catch {
      /* sessionStorage недоступен (приватный режим) — начинаем с пустого */
    }
  }

  private persistFlipped(): void {
    try {
      sessionStorage.setItem(FLIPPED_PLAYERS_KEY, JSON.stringify([...this.flipped]));
    } catch {
      /* квота/приватный режим — потеряем только память о перевороте */
    }
  }

  // ─────────── скрытие видео ───────────

  isHidden(username: string): boolean {
    return this.hidden.has(username.toLowerCase());
  }

  /** Переключить скрытие видео. Возвращает новое состояние. */
  toggleHidden(username: string): boolean {
    const key = username.toLowerCase();
    if (this.hidden.has(key)) this.hidden.delete(key);
    else this.hidden.add(key);
    return this.hidden.has(key);
  }

  // ─────────── жизненный цикл ───────────

  /** Забыть всё, кроме диска: фичу выключили. */
  reset(): void {
    this.muted.clear();
    this.unmutedHere.clear();
    this.hidden.clear();
  }

  clearUnmutedHere(): void {
    this.unmutedHere.clear();
  }
}
