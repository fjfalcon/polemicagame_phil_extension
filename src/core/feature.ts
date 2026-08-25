/**
 * Единый жизненный цикл фич content-скрипта.
 * Заменяет 11 самописных синглтонов с ручным роутингом onMessage в каждом файле.
 *
 * FeatureManager сам включает/выключает фичи при изменении настроек —
 * больше не нужен location.reload() для применения тумблеров.
 */
import { getSettings, onSettingsChanged } from "./settings";
import { log } from "./log";
import type { Settings, SettingKey } from "@shared/types";

export interface FeatureContext {
  readonly settings: Settings;
}

export interface Feature {
  /** Уникальный id для логов. */
  readonly id: string;
  /** Ключ настройки-выключателя; null = фича включена всегда. */
  readonly settingKey: SettingKey | null;
  /** Включить фичу: повесить слушатели/observers. */
  enable(ctx: FeatureContext): void | Promise<void>;
  /** Выключить фичу: ОБЯЗАТЕЛЬНО снять все слушатели/observers/интервалы. */
  disable(): void;
  /** (Опционально) реакция на изменение настроек без выкл/вкл. */
  update?(ctx: FeatureContext): void;
}

export class FeatureManager {
  private features: Feature[] = [];
  private active = new Set<string>();
  private settings: Settings | null = null;
  /** Хвост очереди: sync() никогда не выполняется параллельно сам с собой. */
  private queue: Promise<void> = Promise.resolve();
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  register(...f: Feature[]): this {
    this.features.push(...f);
    return this;
  }

  async start(): Promise<void> {
    this.settings = await getSettings();
    await this.enqueueSync();
    this.logSkippedAtBoot();
    onSettingsChanged((patch) => {
      this.settings = { ...(this.settings as Settings), ...patch };
      // Сохранение настроек пишет в sync и local раздельно → два события подряд.
      // Склеиваем их, чтобы не гонять sync() дважды на одно нажатие тумблера.
      if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = null;
        void this.enqueueSync();
      }, 50);
    });
  }

  /** Ставит проход в очередь; параллельных enable() для одной фичи не будет. */
  private enqueueSync(): Promise<void> {
    this.queue = this.queue.then(
      () => this.sync(),
      () => this.sync(),
    );
    return this.queue;
  }

  /**
   * Одна строка в журнал при буте: какие фичи пропущены настройками и что
   * РЕАЛЬНО лежит в хранилище под их ключом. Пропуск по настройке — законное
   * молчание, но когда пользователь жалуется «кнопок нет», а в попапе
   * «галочки стоят», журнал обязан отвечать сам (жалоба 25.08.2026: полдня
   * раскопок вместо одной строки). JSON.stringify показывает и тип: строка
   * "true" из битого хранилища видна как «"true"», а не как булево.
   */
  private logSkippedAtBoot(): void {
    const s = this.settings as Settings;
    if (s.extension_enabled === false) return; // мастер-выключатель — не «пропуск»
    const skipped = this.features
      .filter((f) => f.settingKey !== null && !this.isEnabled(f))
      .map((f) => `${f.id}(${f.settingKey}=${JSON.stringify(s[f.settingKey as keyof Settings])})`);
    if (skipped.length) log.info("feature", "пропущены настройками:", skipped.join(" "));
  }

  private isEnabled(f: Feature): boolean {
    const s = this.settings as Settings;
    // Мастер-выключатель гасит все фичи разом, включая безусловные (settingKey null).
    if (s.extension_enabled === false) return false;
    return f.settingKey === null || s[f.settingKey] === true;
  }

  private async sync(): Promise<void> {
    const ctx: FeatureContext = { settings: this.settings as Settings };
    for (const f of this.features) {
      const shouldEnable = this.isEnabled(f);
      const isActive = this.active.has(f.id);
      if (shouldEnable && !isActive) {
        // Резервируем id ДО await: иначе повторный проход успеет вызвать
        // enable() второй раз и оставит второй набор слушателей навсегда.
        this.active.add(f.id);
        try {
          await f.enable(ctx);
          log.info("feature", "enabled", f.id);
        } catch (e) {
          this.active.delete(f.id);
          log.error("feature", "enable failed", f.id, e);
          // Откат: enable мог успеть навесить часть слушателей/таймеров до
          // падения — без disable() они жили бы вечно, а следующий проход
          // включил бы фичу ВТОРЫМ экземпляром поверх осиротевшего.
          try {
            f.disable();
          } catch {
            /* фича не обязана переживать disable после неполного enable */
          }
        }
      } else if (!shouldEnable && isActive) {
        try {
          f.disable();
        } catch (e) {
          log.error("feature", "disable failed", f.id, e);
        }
        this.active.delete(f.id);
        log.info("feature", "disabled", f.id);
      } else if (shouldEnable && isActive && f.update) {
        try {
          f.update(ctx);
        } catch (e) {
          log.error("feature", "update failed", f.id, e);
        }
      }
    }
  }
}
