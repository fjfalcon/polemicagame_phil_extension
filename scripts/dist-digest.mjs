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
/**
 * Служебные файлы web-ext, которые ПОДПИСЬ кладёт внутрь dist/firefox
 * (.amo-upload-uuid — живой прогон 26.08.2026; .web-extension-id — при
 * отсутствии gecko.id). Это метаданные подписи, не продукт: без исключения
 * каждый sign инвалидировал бы штамп собственного gated-прогона.
 */
const WEB_EXT_METADATA = new Set([".amo-upload-uuid", ".web-extension-id"]);

export function treeSha256(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (d === dir && WEB_EXT_METADATA.has(name)) continue;
      const p = path.join(d, name);
      // lstat, не stat: симлинк в артефакте — сам по себе повод отказать
      // (битый давал ENOENT-стектрейс, цикл — вечную рекурсию, а цель вне
      // дерева делала дайджест зависимым от чужих байтов; adversarial
      // 26.08.2026, находка 2).
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        throw new Error(`symlink в артефакте: ${path.relative(dir, p)} — сборка не должна их класть`);
      }
      if (st.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const h = createHash("sha256");
  for (const p of files) {
    const body = fs.readFileSync(p);
    const rel = path.relative(dir, p);
    // Длины во фрейминге — инъективность: без них {a:"x\0b\0y"} и
    // {a:"x", b:"y"} давали ОДИН дайджест (adversarial 26.08.2026, находка 1).
    h.update(`${Buffer.byteLength(rel)}:${body.length}:`);
    h.update(rel);
    h.update(body);
  }
  return h.digest("hex");
}
