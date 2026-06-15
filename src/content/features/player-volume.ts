/**
 * Запоминание громкости игроков. Сайт не сохраняет выставленную громкость
 * видео игрока — после обновления страницы (F5) она снова на максимуме.
 *
 * Здесь мы храним УРОВЕНЬ громкости каждого игрока (ключ — ник) в storage.local
 * и восстанавливаем при появлении его видео.
 *
 * ВАЖНО: флаг `muted` НЕ трогаем и НЕ сохраняем. Видео при автозапуске часто
 * стартует с muted=true (политика автоплея браузера) — если это сохранять и
 * восстанавливать, у игроков пропадает звук. Поэтому работаем только с .volume.
 *
 * Тонкость: когда сами выставляем сохранённое значение — событие volumechange
 * игнорируется (флаг applying), чтобы не затирать данные.
 */
import { onDomChange } from "@core/dom";
import { browser } from "@core/env";
import { log } from "@core/log";
import { SITE } from "@core/selectors";
import type { Feature } from "@core/feature";

const STORAGE_KEY = "playerVolumes";

interface VolEntry {
  v: number;
}
type VolMap = Record<string, VolEntry>;

let volumes: VolMap = {};
let offDom: (() => void) | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let processed = new WeakSet<HTMLVideoElement>();
const applying = new WeakSet<HTMLVideoElement>();
const listeners: Array<{ el: HTMLVideoElement; fn: () => void }> = [];

function usernameOf(video: HTMLVideoElement): string | null {
  const player = video.closest(SITE.player);
  const name = player?.querySelector(SITE.playerName)?.textContent?.trim();
  return name || null;
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void browser.storage.local.set({ [STORAGE_KEY]: volumes });
  }, 400);
}

function applyTo(video: HTMLVideoElement, username: string): void {
  const saved = volumes[username];
  if (!saved) return;
  applying.add(video);
  try {
    video.volume = saved.v;
    // muted НЕ трогаем — иначе ловим автоплейный mute и глушим игроков.
  } catch {
    /* элемент мог отвалиться */
  }
  // Снимаем флаг после того, как браузер обработает наш volumechange.
  setTimeout(() => applying.delete(video), 250);
}

function process(video: HTMLVideoElement): void {
  if (processed.has(video)) return;
  processed.add(video);

  const username = usernameOf(video);
  if (username) applyTo(video, username);

  const onVolumeChange = () => {
    if (applying.has(video)) return; // наше же изменение — не сохраняем
    const u = usernameOf(video);
    if (!u) return;
    volumes[u] = { v: video.volume };
    log.debug("player-volume", "save", u, volumes[u]);
    scheduleSave();
  };
  video.addEventListener("volumechange", onVolumeChange);
  listeners.push({ el: video, fn: onVolumeChange });
}

function scan(): void {
  document.querySelectorAll<HTMLVideoElement>(SITE.playerVideoEl).forEach(process);
}

export const playerVolumeFeature: Feature = {
  id: "player-volume",
  settingKey: "remember_player_volume_enabled",
  async enable() {
    processed = new WeakSet<HTMLVideoElement>();
    const res = await browser.storage.local.get({ [STORAGE_KEY]: {} });
    volumes = (res[STORAGE_KEY] as VolMap) || {};
    scan();
    offDom = onDomChange(() => scan());
    log.info("player-volume", "enabled", Object.keys(volumes).length, "saved");
  },
  disable() {
    offDom?.();
    offDom = null;
    for (const { el, fn } of listeners) el.removeEventListener("volumechange", fn);
    listeners.length = 0;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  },
};
