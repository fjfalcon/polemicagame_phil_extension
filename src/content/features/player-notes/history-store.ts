/**
 * История игр соперника: пересечения, «последние игры» и их кэши.
 *
 * Вынесено из player-notes.ts (арх-ревью 28.08.2026) по кластеру ВЛАДЕНИЯ
 * СОСТОЯНИЕМ: восемь полей (две карты кэшей, две карты запросов в полёте,
 * время загрузки, подписка на дорисовку, два флага прогрева) не нужны больше
 * никому в фиче. Здесь же живут правила, которые дороже всего дались:
 * ночной прогрев по одному игроку, «мелкая сводка сразу — точная после
 * намерения», кэш неудачи с коротким TTL и «ошибка ≠ игр нет».
 *
 * Наружу отдаются ТОЛЬКО данные. Тултипы, кнопки и разметку рисует фича.
 */
import {
  completeHistory,
  crossGames,
  fetchFirstPage,
  FULL_HISTORY_LIMIT,
  getOwnHistory,
  oldestDate,
  type Crossover,
  type History,
} from "@core/crossover";
import { fetchFirstKilled } from "@core/match-brief";
import { log } from "@core/log";
import { lastGamesLimit } from "@shared/last-games";
import { STATS_TTL_MS } from "./player-stats";

/** Одна строка окна «последние игры». */
export interface LastGameEntry {
  /** Номер матча: по нему добирается признак «первый убитый». */
  id: number;
  role: string;
  isWin: boolean;
  mmrChange: number;
  /**
   * Игрок был первым убитым. `undefined` — НЕ ЗНАЕМ (разбор матча не
   * загрузился или признак выключен настройкой): молчать в этом случае
   * обязательно, «не ПУ» было бы выдумкой.
   */
  firstKilled?: boolean;
}

/** Сводка пересечений живёт полчаса: сыгранные вместе игры не переигрываются. */
export const CROSSOVER_TTL_MS = 30 * 60 * 1000;
/** TTL пустой истории игр: короче обычного, чтобы новые игры подтянулись. */
export const EMPTY_GAMES_TTL_MS = 60 * 1000;
/** Строк истории для ночного прогрева: сводку уточнит живой ховер. */
export const WARM_PAGE_LIMIT = 200;
/** Потолок ожидания списка игр. */
const GAMES_TIMEOUT_MS = 15_000;

interface CrossoverHit {
  at: number;
  ttl: number;
  data: Crossover | null;
  /** Сводка мелкая (прогревочная): ховеру её апгрейдим до полной. */
  shallow?: boolean;
}

export interface HistoryContext {
  /** Настройки нужны для лимита списка, «ПУ» и гейта прогрева. */
  lastGamesCount(): string | number | undefined;
  firstKilledEnabled(): boolean;
  crossoverEnabled(): boolean;
  /** Сейчас ночь: прогрев работает только тогда, днём игрок смотрит на стол. */
  isNight(): boolean;
  /** Свой ник со стола — чтобы не считать «пересечения с собой». */
  ownName(): string | null;
  /** Свой id; null — профиль ещё не известен (это не ошибка сети). */
  myUserId(): Promise<number | string | null>;
  /** id игрока по нику. Бросает, если определить не удалось. */
  resolveUserId(username: string, key: string): Promise<number | string>;
}

export class HistoryStore {
  private readonly crossover = new Map<string, CrossoverHit>();
  private readonly crossoverInFlight = new Map<
    string,
    Promise<Crossover | null | undefined>
  >();
  private readonly lastGames = new Map<string, LastGameEntry[]>();
  private readonly lastGamesFetchedAt = new Map<string, number>();
  private readonly lastGamesInFlight = new Map<string, Promise<LastGameEntry[]>>();
  /** Подписки «список дорисовался пометками ПУ» — по одному ключу на ховер. */
  private readonly progress = new Map<string, (games: LastGameEntry[]) => void>();
  /** Прогрев уже качает одного игрока: второго за тот же проход не берём. */
  private warmBusy = false;
  /** Прогрев отключён до перезагрузки: свой профиль так и не определился. */
  private warmStopped = false;

  constructor(private readonly ctx: HistoryContext) {}

  reset(): void {
    this.crossover.clear();
    this.crossoverInFlight.clear();
    this.lastGames.clear();
    this.lastGamesFetchedAt.clear();
    this.lastGamesInFlight.clear();
    this.progress.clear();
    this.warmBusy = false;
    this.warmStopped = false;
  }

  /**
   * Сбросить ТОЛЬКО списки последних игр. Нужен при смене настроек вида: в
   * кэше лежат старые списки, и «показывать 8» или «показывать ПУ»
   * включались бы лишь через пять минут, когда кэш протухнет сам.
   */
  resetLastGames(): void {
    this.lastGames.clear();
    this.lastGamesFetchedAt.clear();
  }

  /** Подписаться на дорисовку «ПУ» для открытого окна игрока. */
  watchProgress(key: string, cb: (games: LastGameEntry[]) => void): void {
    this.progress.set(key, cb);
  }

  unwatchProgress(key: string): void {
    this.progress.delete(key);
  }

  /**
   * Своя история игр. Общий кэш @core/crossover (PERF26-3): та же история
   * нужна карточке профиля — раньше каждая качала свою копию.
   */
  myHistory(myId: number | string): Promise<History | null> {
    return getOwnHistory(myId);
  }

  /**
   * Готовая ПОЛНАЯ сводка из кэша — синхронно (замер 27.08.2026, п.2):
   * повторное наведение платило фиксированные 350 мс намерения, хотя данные
   * уже лежали. null — нечего показать сразу.
   */
  peekCrossover(username: string): Crossover | null {
    const hit = this.crossover.get(username.toLowerCase());
    if (!hit || Date.now() - hit.at >= hit.ttl || !hit.data) return null;
    return hit.data;
  }

  /** Мелкая (прогревочная) сводка из кэша — её показываем сразу, п.3. */
  peekShallowCrossover(username: string): Crossover | null {
    const hit = this.crossover.get(username.toLowerCase());
    if (!hit || Date.now() - hit.at >= hit.ttl || !hit.data || !hit.shallow) return null;
    return hit.data;
  }

  /** Готовый список последних игр из кэша — синхронно (п.6). */
  peekLastGames(username: string): LastGameEntry[] | null {
    const key = username.toLowerCase();
    const cached = this.lastGames.get(key);
    const at = this.lastGamesFetchedAt.get(key) ?? 0;
    if (!cached || Date.now() - at >= STATS_TTL_MS) return null;
    return cached;
  }

  /**
   * Прогрев пересечений — по ОДНОМУ игроку за проход.
   *
   * Зачем: первая сводка стоит двух историй, и ждать их, уже наведя курсор, —
   * это те самые «очень долго в первый раз». Ночью игроку не до кнопок, зато
   * у расширения есть время: к утру сводки готовы и открываются мгновенно
   * (идея владельца 13.08.2026).
   *
   * Почему по одному и без своего таймера: страховочный проход уже тикает раз
   * в две секунды, и этого ритма хватает, чтобы прогреть стол за ночь. Залп из
   * десяти историй разом был бы и грубее к серверу, и медленнее для того
   * единственного игрока, на которого сейчас смотрят.
   */
  pumpWarm(names: string[]): void {
    if (!this.ctx.crossoverEnabled()) return;
    const mine = this.ctx.ownName()?.toLowerCase();
    const pending = names.filter((name) => {
      const key = name.toLowerCase();
      // Себя пропускаем: «пересечения с собой» — это просто все свои игры.
      return key !== "" && key !== mine && !this.crossover.has(key);
    });
    if (pending.length === 0) {
      // Стол прогрет. Историю НЕ отпускаем вручную: общий кэш живёт своим
      // TTL, а release из 2-секундного прохода выбивал её из-под ховер-
      // апгрейда и профильных карточек (adversarial 26.08.2026, №4/№5).
      return;
    }
    // Прогрев начинается с первой НОЧИ: днём игрок говорит и смотрит на стол,
    // и фоновые запросы ему ни к чему.
    if (this.warmStopped || this.warmBusy || !this.ctx.isNight()) return;
    this.warmBusy = true;
    void this.getCrossover(pending[0], true)
      .then((data) => {
        if (data === undefined) {
          this.warmStopped = true;
          log.info("player-notes", "прогрев пересечений отключён: свой профиль не определился");
        }
      })
      .finally(() => {
        this.warmBusy = false;
      });
  }

  /**
   * Пересечение с игроком: сколько сыграно вместе и кем он в этих играх был.
   *
   * `undefined` — свой id неизвестен (в комнате шапки сайта нет, а на обычные
   * страницы игрок ещё не заходил): это НЕ ошибка сети и говорить о ней надо
   * иначе. `null` — не удалось загрузить историю; пустая сводка читалась бы
   * как «вы никогда не играли вместе», а это другое утверждение.
   */
  getCrossover(
    username: string,
    /** Ночной прогрев: мелкая сводка первой страницей (PERF26-3) — полный
     *  многостраничный заход остаётся живому ховеру. */
    warm = false,
  ): Promise<Crossover | null | undefined> {
    const key = username.toLowerCase();
    const hit = this.crossover.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) {
      // Мелкий прогревочный кэш ховеру не отдаём — апгрейдим до полного.
      if (!(hit.shallow && !warm)) return Promise.resolve(hit.data);
    }
    const inFlight = this.crossoverInFlight.get(key);
    if (inFlight) {
      if (warm) return inFlight;
      // Летит прогрев? Дождаться и перечитать: либо кэш уже полный, либо
      // shallow-хит выше отправит на полный заход (второй виток в кэш
      // не зациклится — non-shallow вернётся сразу).
      return inFlight.then(() => this.getCrossover(username));
    }
    // Промис кладётся в реестр СИНХРОННО, до первого await. Раньше метод
    // успевал сходить за своим id между проверкой реестра и записью в него, и
    // два наведения подряд заводили каждое свою пару историй (замечание
    // владельца 13.08.2026). Повторное наведение обязано ЖДАТЬ первый запрос,
    // а новый запускать только если тот провалился — за это отвечает кэш
    // неудачи с коротким TTL.
    const promise = this.loadCrossover(username, key, warm).finally(() => {
      this.crossoverInFlight.delete(key);
    });
    this.crossoverInFlight.set(key, promise);
    return promise;
  }

  /** Собственно загрузка сводки. Не бросает: ждущие не должны получить reject. */
  private async loadCrossover(
    username: string,
    key: string,
    shallow = false,
  ): Promise<Crossover | null | undefined> {
    const myId = await this.ctx.myUserId();
    // Свой профиль неизвестен — это не результат, кэшировать нечего.
    if (myId === null) return undefined;

    try {
      // Своя история и первая страница чужой едут ОДНОВРЕМЕННО. Раньше чужая
      // ждала свою целиком, потому что глубина зависит от моей самой старой
      // игры, — но от неё зависит только вопрос «нужны ли ещё страницы», а
      // первая нужна всегда. Ожидание было ровно вдвое длиннее необходимого.
      const theirs = (async () => {
        const id = await this.ctx.resolveUserId(username, key);
        // Прогрев — МЕЛКАЯ страница (200 строк). Полный путь берёт всю
        // историю ОДНИМ запросом: прежняя пара «2000 + 8000» выбрасывала
        // первый ответ целиком и была медленнее листания (adversarial
        // 27.08.2026, блокер 2).
        return {
          id,
          first: await fetchFirstPage(id, shallow ? WARM_PAGE_LIMIT : FULL_HISTORY_LIMIT),
        };
      })();
      const [mine, start] = await Promise.all([this.myHistory(myId), theirs]);
      // Первые строки уже скачанной истории — это и есть «последние игры»
      // (замер 27.08.2026, п.5: их выбрасывали, а потом качали заново).
      // Кладём в кэш ТОЛЬКО если там пусто: живой ховер мог уже дополнить
      // список пометками «ПУ», затирать их нельзя.
      // ТОЛЬКО когда «ПУ» выключен (adversarial 27.08.2026): иначе посев
      // отдавал готовый список БЕЗ пометок, markFirstKilled по этому пути не
      // зовётся, и фича молча выключалась на 5 минут кэша.
      if (
        !this.ctx.firstKilledEnabled() &&
        start.first &&
        start.first.rows.length > 0 &&
        !this.peekLastGames(username)
      ) {
        const limit = lastGamesLimit(this.ctx.lastGamesCount());
        this.lastGames.set(
          key,
          start.first.rows.slice(0, limit).map((r) => ({
            id: r.id,
            role: r.role === "don" ? "godfather" : r.role,
            isWin: r.win,
            mmrChange: typeof r.mmrDiff === "number" ? r.mmrDiff : 0,
          })),
        );
        this.lastGamesFetchedAt.set(key, Date.now());
      }
      let data: Crossover | null = null;
      if (mine && start.first) {
        if (shallow) {
          const truncated = start.first.total > start.first.rows.length;
          data = crossGames(mine.rows, start.first.rows, mine.truncated || truncated);
        } else {
          const full = await completeHistory(start.id, start.first, oldestDate(mine.rows));
          data = crossGames(mine.rows, full.rows, mine.truncated || full.truncated);
        }
      }
      // Кэшируем и неудачу: иначе каждый повторный наведённый курсор гнал бы
      // пару историй заново (урок кэша последних игр, находка 7). Но держим
      // её коротко — сеть чинится, а сводка на полчаса «не удалось» нет.
      this.crossover.set(key, {
        at: Date.now(),
        ttl: data ? CROSSOVER_TTL_MS : STATS_TTL_MS,
        data,
        shallow: shallow && data !== null,
      });
      return data;
    } catch (e) {
      log.warn("player-notes", "пересечения не сложились", e);
      this.crossover.set(key, { at: Date.now(), ttl: STATS_TTL_MS, data: null });
      return null;
    }
  }

  /** Список игр; null — загрузить НЕ УДАЛОСЬ (это не «игр нет»). */
  async getLastGames(username: string): Promise<LastGameEntry[] | null> {
    const key = username.toLowerCase();
    const cached = this.lastGames.get(key);
    const fetchedAt = this.lastGamesFetchedAt.get(key) ?? 0;
    if (cached && Date.now() - fetchedAt < STATS_TTL_MS) return cached;
    // Дедупликация: несколько mouseenter до первого ответа (или две плитки
    // одного игрока) запускали одинаковые запросы (аудит 01.08.2026, находка 7).
    const inFlight = this.lastGamesInFlight.get(key);
    // .catch: с честным контрактом (ошибка = throw) общий промис может
    // упасть, и ВТОРОЙ ожидающий получал бы reject мимо обработки ниже —
    // тултип застревал на «Загрузка…» навсегда (ревью аудита устойчивости).
    if (inFlight) return inFlight.catch(() => null);

    const promise = this.fetchLastGames(username, key);
    this.lastGamesInFlight.set(key, promise);
    try {
      return await promise;
    } catch (e) {
      log.warn("player-notes", "last games unavailable", e);
      return null;
    } finally {
      this.lastGamesInFlight.delete(key);
    }
  }

  private async fetchLastGames(username: string, key: string): Promise<LastGameEntry[]> {
    try {
      const dataPromise = (async (): Promise<LastGameEntry[]> => {
        const userId = await this.ctx.resolveUserId(username, key);
        const limit = lastGamesLimit(this.ctx.lastGamesCount());

        try {
          // Настоящий таймаут через AbortSignal вместо Promise.race: race не
          // отменял сам запрос, и он висел в сети после «таймаута».
          const gamesResponse = await fetch(
            `https://polemicagame.com/profile/default/get-games?userId=${userId}&page=1&limit=${limit}`,
            { signal: AbortSignal.timeout(GAMES_TIMEOUT_MS) },
          );
          if (!gamesResponse.ok) {
            log.warn("player-notes", `games API error: ${gamesResponse.status}`);
            // Ошибка ≠ «игр нет»: бросаем, чтобы не закэшировать пустоту и
            // показать честный текст (ревью аудита, мелочь 4).
            throw new Error(`games API ${gamesResponse.status}`);
          }
          const data: any = await gamesResponse.json();
          if (!Array.isArray(data?.rows)) {
            // Сменившееся поле/объект ошибки — не «игр нет»: иначе снова
            // покажем «Нет данных» и закэшируем пустоту (ревью, мелочь 2).
            log.warn("player-notes", "games API: unexpected shape");
            throw new Error("games API: unexpected shape");
          }
          const entries = (data.rows as any[]).map(
            (game): LastGameEntry => ({
              id: Number(game.id) || 0,
              role: game.role?.type === "don" ? "godfather" : game.role?.type || "civilian",
              isWin: game.result?.code === "success",
              mmrChange: parseInt(game.mmr?.mmr_diff, 10) || 0,
            }),
          );
          // ПУ НЕ ждём: список готов уже сейчас (замер 27.08.2026, п.4 —
          // пользователь ждал обе стадии подряд, ~0.57 с лишних). Разборы
          // матчей дорисовывают пометки поверх, когда доедут.
          if (this.ctx.firstKilledEnabled()) {
            void this.markFirstKilled(entries, userId)
              .then(() => {
                this.lastGames.set(key, entries);
                this.progress.get(key)?.(entries);
              })
              .catch(() => undefined);
          }
          return entries;
        } catch (err) {
          log.warn("player-notes", "fetching games history failed", err);
          throw err;
        }
      })();

      const result = await dataPromise;
      // Кэшируем и ПУСТОЙ результат: у нового игрока без сыгранных игр каждый
      // hover заново гнал запрос (аудит 01.08.2026, находка 7). Пустой ответ
      // живёт по короткому TTL — появившиеся игры подтянутся.
      this.lastGames.set(key, result);
      this.lastGamesFetchedAt.set(
        key,
        result.length > 0 ? Date.now() : Date.now() - STATS_TTL_MS + EMPTY_GAMES_TTL_MS,
      );
      return result;
    } catch (e) {
      // Наверх летит ошибка: вызывающий отличит её от «игр нет» и НЕ будет
      // кэшировать пустоту (ревью аудита устойчивости, мелочь 4).
      log.debug("player-notes", "getLastGames failed", e);
      throw e;
    }
  }

  /**
   * Проставить «ПУ» в списке игр.
   *
   * Разборы матчей едут ОДНОВРЕМЕННО: восемь по полсекунды подряд — это
   * четыре секунды на наведение, а разом — те же полсекунды. Матч, который не
   * разобрался, остаётся без пометки вовсе: «не ПУ» по неудаче было бы
   * утверждением, которого мы не проверяли.
   */
  private async markFirstKilled(
    entries: LastGameEntry[],
    userId: number | string,
  ): Promise<void> {
    if (!this.ctx.firstKilledEnabled()) return;
    const mine = Number(userId);
    if (!Number.isSafeInteger(mine) || mine <= 0) return;
    const marks = await Promise.all(
      entries.map((entry) => (entry.id > 0 ? fetchFirstKilled(entry.id) : undefined)),
    );
    entries.forEach((entry, i) => {
      const first = marks[i];
      if (first !== undefined) entry.firstKilled = first === mine;
    });
  }
}
