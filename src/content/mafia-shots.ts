/**
 * Анализ ночной стрельбы мафии по разбору матча (просьба владельца
 * 31.08.2026): промахи, «в скольких» случился промах и КТО виновен.
 *
 * Данные — data.shots разбора: {night, shooter, victim} по позициям за
 * столом. Промах = выстрелы ночи не сведены (жертвы различаются): по
 * правилам никто не умирает.
 *
 * ПРАВИЛО ВИНЫ (сформулировано владельцем): виновен тот, кто УВЁЛ выстрел
 * от большинства. Двое стреляли в одного, третий в другого — виновен
 * третий. Большинства нет (1-1 при двух живых чёрных, 1-1-1, любая ничья)
 * — виновны ВСЕ стрелявшие: определить уведшего нельзя.
 *
 * «В скольких» (живых на момент ночи) восстанавливается по таймлайну:
 * убийства сведённых ночей до этой + выбывшие голосованиями дней до этой
 * (resolveDayOutcome — единственный владелец правила исхода дня).
 */
import { resolveDayOutcome, type MatchVote } from "./match-outcome";

export interface NightShooting {
  night: number;
  /** Живых за столом на момент этой ночи. */
  alive: number;
  /** Выстрелы ночи: позиция стрелявшего → позиция жертвы. */
  shots: Array<{ shooter: number; victim: number }>;
  missed: boolean;
  /** Позиция убитого при сведённой стрельбе (иначе null). */
  victim: number | null;
  /** Виновные в промахе по правилу владельца (пусто при сведении). */
  blamed: number[];
}

interface RawShot {
  night?: unknown;
  shooter?: unknown;
  victim?: unknown;
}

function asPos(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

export function analyzeMafiaShots(data: {
  shots?: unknown;
  votes?: unknown;
  players?: unknown;
}): NightShooting[] {
  const rawShots = Array.isArray(data.shots) ? (data.shots as RawShot[]) : [];
  const votes = Array.isArray(data.votes) ? (data.votes as MatchVote[]) : [];
  const totalPlayers = Array.isArray(data.players) && data.players.length > 0
    ? data.players.length
    : 10;

  const byNight = new Map<number, Array<{ shooter: number; victim: number }>>();
  for (const s of rawShots) {
    if (!s || typeof s !== "object") continue; // мусор из недоверенного разбора
    const night = asPos(s.night);
    const shooter = asPos(s.shooter);
    const victim = asPos(s.victim);
    if (night === null || shooter === null || victim === null) continue;
    if (!byNight.has(night)) byNight.set(night, []);
    byNight.get(night)!.push({ shooter, victim });
  }

  const nights = [...byNight.keys()].sort((a, b) => a - b);
  const out: NightShooting[] = [];
  let deaths = 0;
  let lastNight = 0;
  for (const night of nights) {
    // Дни между предыдущей учтённой ночью и этой: каждый мог унести
    // выбывших. Ночь k идёт после дней 1..k-1 (день 0 — без голосования).
    for (let day = lastNight; day < night; day++) {
      if (day >= 1) deaths += resolveDayOutcome(votes, day).departed.length;
    }
    lastNight = night;

    const shots = byNight.get(night)!;
    const victims = new Set(shots.map((s) => s.victim));
    const missed = victims.size > 1;
    let blamed: number[] = [];
    let victim: number | null = null;
    if (missed) {
      const counts = new Map<number, number>();
      for (const s of shots) counts.set(s.victim, (counts.get(s.victim) ?? 0) + 1);
      const top = Math.max(...counts.values());
      const leaders = [...counts.entries()].filter(([, n]) => n === top).map(([v]) => v);
      blamed =
        leaders.length === 1
          ? shots.filter((s) => s.victim !== leaders[0]).map((s) => s.shooter)
          : shots.map((s) => s.shooter);
    } else {
      victim = shots[0]?.victim ?? null;
    }

    out.push({ night, alive: totalPlayers - deaths, shots, missed, victim, blamed });
    if (!missed && victim !== null) deaths += 1;
  }
  return out;
}
