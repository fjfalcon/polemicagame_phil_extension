/**
 * Дайджесты артефактов для gate-stamp (ревью 26.08.2026, хвост №1):
 * штамп без привязки к байтам ловил только смену HEAD — частичная пересборка
 * (npm run build:firefox) после gated-прогона подписывала ungated-байты.
 *
 * Общий модуль: release-assets пишет дайджесты, verify-dist пересчитывает.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function fileSha256(p) {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** Дайджест дерева: отсортированные относительные пути + содержимое. */
export function treeSha256(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const h = createHash("sha256");
  for (const p of files) {
    h.update(path.relative(dir, p));
    h.update("\0");
    h.update(fs.readFileSync(p));
    h.update("\0");
  }
  return h.digest("hex");
}
