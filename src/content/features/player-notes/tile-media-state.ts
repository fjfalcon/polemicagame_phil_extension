/**
 * Что игрок сделал с чужими плитками: мьют, переворот камеры, скрытие видео.
 *
 * Вынесено из player-notes.ts (арх-ревью 28.08.2026) по кластеру владения
 * состоянием: четыре набора ников и ДВА разных хранилища с разными правилами
 * жизни, которые к тому же легко перепутать:
 *
 *  • мьют и скрытие камеры — storage.local, переживают перезагрузку и общие
 *    для вкладок, поэтому пишутся СЛИЯНИЕМ (иначе вкладка со старым списком
 *    затирала бы решения соседней — аудит безопасности 01.08.2026, находка 8).
 *    Скрытие стало персистентным 29.08.2026 по просьбе владельца: «мьют
 *    переживает игру — пусть и камера так же»;
 *  • переворот камеры — sessionStorage вкладки: это «на эту игру», а не
 *    навсегда.
 *
 * Модуль НЕ трогает DOM: он отвечает на вопрос «что игрок решил про этого
 * человека», а красит плитки и кнопки сама фича.
 */
import { browser } from "@core/env";
import { log } from "@core/log";
import { parseFlippedPlayers } from "./flipped-players";

/** storage.local: массив ников (lowercase) с выключенным у нас звуком. */
export const MUTED_PLAYERS_KEY = "pn_muted_players";
/** storage.local: массив ников (lowercase) со скрытой у нас камерой. */
export const HIDDEN_PLAYERS_KEY = "pn_hidden_players";
/** sessionStorage: перевёрнутые камеры — на текущую вкладку, не навсегда. */
export const FLIPPED_PLAYERS_KEY = "pn_flipped_players";

export interface TileMediaContext {
  /** Сообщить пользователю о неудачной записи: мьют иначе молча слетал бы. */
  onPersistError(message: string): void;
  /** Мьюты или скрытия изменились в ДРУГОЙ вкладке — перекрасить плитки. */
  onExternalMediaChange(): void;
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
  /** Ники со скрытой камерой (storage.local, как мьют). */
  private hidden = new Set<string>();
  /** Снятые в ЭТОЙ вкладке скрытия — не воскресают при слиянии с диском. */
  private unhiddenHere = new Set<string>();

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
        // lowercase на входе: свои записи и так в нижнем регистре, но импорт
        // бэкапа мог занести "MixedNick" — lookup его не нашёл бы (SEAM-08).
        for (const u of list) if (typeof u === "string" && u) this.muted.add(u.toLowerCase());
      }
    } catch (e) {
      log.warn("player-notes", "muted players load failed", e);
    }
  }

  /** Список пришёл из другой вкладки (storage.onChanged). */
  adoptExternalMuted(next: unknown): void {
    if (!Array.isArray(next)) return;
    this.muted = new Set(
      next.filter((u): u is string => typeof u === "string" && u !== "").map((u) => u.toLowerCase()),
    );
    this.ctx.onExternalMediaChange();
  }

  private persistMuted(): void {
    this.persistShared(MUTED_PLAYERS_KEY, this.muted, this.unmutedHere, "мьют — он слетит");
  }

  /**
   * Слияние со свежим диском — общее правило мьюта и скрытия: обе вкладки
   * хранят список целиком, «последний писатель побеждает» терял решения
   * соседней вкладки (аудит безопасности 01.08.2026, находка 8). Снятые в
   * ЭТОЙ вкладке записи не воскресают из дискового списка.
   */
  private persistShared(
    key: string,
    mem: ReadonlySet<string>,
    removedHere: ReadonlySet<string>,
    what: string,
  ): void {
    void (async () => {
      try {
        const cur = (await browser.storage.local.get({ [key]: [] })) as Record<string, unknown>;
        const disk = Array.isArray(cur[key]) ? (cur[key] as string[]) : [];
        // Дисковые строки — к lowercase ДО сравнения: память и removedHere
        // в нижнем регистре, а на диске мог лежать «MixedNick» из старого
        // импорта — сырое сравнение не давало его снять никогда: фильтр не
        // ловил, echo storage.onChanged воскрешал в памяти (adversarial
        // 29.08.2026, F1; страховка сверх разовой миграции в фоне).
        const diskNorm = disk
          .filter((n): n is string => typeof n === "string" && n !== "")
          .map((n) => n.toLowerCase());
        const merged = new Set([...diskNorm.filter((n) => !removedHere.has(n))]);
        for (const n of mem) merged.add(n);
        await browser.storage.local.set({ [key]: [...merged] });
      } catch (e) {
        log.warn("player-notes", `${key} save failed`, e);
        this.ctx.onPersistError(`Не удалось сохранить ${what} после перезагрузки`);
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

  // ─────────── скрытие камеры ───────────

  isHidden(username: string): boolean {
    return this.hidden.has(username.toLowerCase());
  }

  /** Переключить скрытие камеры и сохранить. Возвращает новое состояние. */
  toggleHidden(username: string): boolean {
    const key = username.toLowerCase();
    if (this.hidden.has(key)) {
      this.hidden.delete(key);
      this.unhiddenHere.add(key);
    } else {
      this.hidden.add(key);
      this.unhiddenHere.delete(key);
    }
    this.persistShared(HIDDEN_PLAYERS_KEY, this.hidden, this.unhiddenHere, "скрытие камеры — оно слетит");
    return this.hidden.has(key);
  }

  async loadHidden(): Promise<void> {
    try {
      const res = await browser.storage.local.get({ [HIDDEN_PLAYERS_KEY]: [] });
      const list = res[HIDDEN_PLAYERS_KEY];
      if (Array.isArray(list)) {
        for (const u of list) if (typeof u === "string" && u) this.hidden.add(u.toLowerCase());
      }
    } catch (e) {
      log.warn("player-notes", "hidden players load failed", e);
    }
  }

  /** Список пришёл из другой вкладки (storage.onChanged). */
  adoptExternalHidden(next: unknown): void {
    if (!Array.isArray(next)) return;
    this.hidden = new Set(
      next.filter((u): u is string => typeof u === "string" && u !== "").map((u) => u.toLowerCase()),
    );
    this.ctx.onExternalMediaChange();
  }

  // ─────────── жизненный цикл ───────────

  /** Забыть всё, кроме диска: фичу выключили. */
  reset(): void {
    this.muted.clear();
    this.unmutedHere.clear();
    this.hidden.clear();
    this.unhiddenHere.clear();
  }

  clearUnmutedHere(): void {
    this.unmutedHere.clear();
    this.unhiddenHere.clear();
  }
}
