/**
 * Чистая логика исхода игрового дня — то, что расширение УТВЕРЖДАЕТ игроку.
 *
 * Вынесено из match-stats отдельным модулем не ради красоты: это единственное
 * место, где мы делаем ВЫВОД (кто покинул стол), а не пересказываем данные
 * сайта. Ошибка здесь — не «неудобно», а «мы показали неправду о матче», и
 * заметить её по интерфейсу почти невозможно. Внутри рендерера на 1700 строк
 * проверить это было нечем.
 *
 * Семантика туров (сверено с legacy/match_314446.json и AGENTS §4.8):
 *   num 0 — выставление (заявки кандидатур в речах);
 *   num 1 — голосование;
 *   num 2 — повторное голосование (перевес).
 */

/** Голос в данных матча. Поля именно такие, как их шлёт сайт. */
export interface MatchVote {
  day: number;
  /** Номер тура. ОТСУТСТВИЕ поля = запись бюллетеня «поднимаем всех?». */
  num?: number | null;
  voter?: number;
  candidate: number;
}

export interface DayOutcome {
  /** Номер финального тура голосования этого дня. */
  finalNum: number;
  /** [кандидат, число голосов] финального тура, по убыванию. */
  counts: Array<[number, number]>;
  /** Ничья в финальном туре. */
  tied: boolean;
  /**
   * Кто покинул стол. МАССИВ, а не один игрок: при ничьей в подъёме уходят
   * ВСЕ ничейные кандидаты сразу («попил»).
   */
  departed: number[];
}

/**
 * Бюллетень «поднимаем всех?» — записи голосов БЕЗ поля num.
 *
 * Отличать по отсутствию поля, а не по `!vote.num`: у тура выставления
 * `num === 0`, и проверка на ложность сложила бы выставление с бюллетенем.
 */
export function isLiftBallot(vote: MatchVote): boolean {
  return vote.num === undefined || vote.num === null;
}

/**
 * Исход дня по финальному туру голосования.
 *
 * Ничья в подъёме решается БЮЛЛЕТЕНЕМ: `candidate: 1` = «за». Голосов «за»
 * СТРОГО больше, чем «против», — попил состоялся, уходят все ничейные
 * кандидаты. Правило равенства подтверждено владельцем: «если нет или поровну
 * — начинается ночь и все остаются за столом».
 *
 * Проверено на реальном матче match/598995, день 4: шесть живых, num 1 дал
 * 5:[1,4,10] против 4:[3,5,6] — ничья 3:3; num 2 повторил её один в один —
 * ушли и №4, и №5.
 *
 * Остаточное допущение: у матчей БЕЗ записей бюллетеня ничья в подъёме
 * по-прежнему трактуется как уход — маркер «против» в данных не встречался.
 */
export function resolveDayOutcome(votes: MatchVote[], day: number): DayOutcome {
  const dayVotes = votes.filter((vote) => vote.day === day && !isLiftBallot(vote));
  const finalNum = dayVotes.reduce((max, vote) => Math.max(max, vote.num || 0), 0);

  const countsByCandidate = new Map<number, number>();
  dayVotes
    .filter((vote) => (vote.num || 0) === finalNum)
    .forEach((vote) => {
      countsByCandidate.set(vote.candidate, (countsByCandidate.get(vote.candidate) || 0) + 1);
    });
  const counts = [...countsByCandidate.entries()].sort((a, b) => b[1] - a[1]);
  const tied = counts.length >= 2 && counts[0][1] === counts[1][1];

  let departed: number[] = [];
  if (finalNum > 0 && counts.length > 0) {
    if (!tied) {
      departed = [counts[0][0]];
    } else if (finalNum >= 2) {
      const ballot = votes.filter((v) => v.day === day && isLiftBallot(v));
      const yes = ballot.filter((v) => v.candidate === 1).length;
      const no = ballot.length - yes;
      // Бюллетень есть → он решает; бюллетеня нет → допущение «попил состоялся».
      if (ballot.length === 0 || yes > no) {
        const top = counts[0][1];
        departed = counts.filter(([, cnt]) => cnt === top).map(([pos]) => pos);
      }
    }
  }

  return { finalNum, counts, tied, departed };
}

/** Пояснение к иконке ночного действия (показывается на hover). */
export function actionTip(type: string, to: unknown): string {
  const n = `№${to}`;
  switch (type) {
    case "kill":
      return `Выстрел мафии → ${n}`;
    case "check":
      return `Проверка шерифа → ${n}`;
    case "don_check":
      return `Проверка дона → ${n}`;
    case "vote":
      return `Голос → ${n}`;
    default:
      return `Действие → ${n}`;
  }
}
