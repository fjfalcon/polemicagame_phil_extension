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

  register(...f: Feature[]): this {
    this.features.push(...f);
    return this;
  }

  async start(): Promise<void> {
    this.settings = await getSettings();
    await this.sync();
    onSettingsChanged((patch) => {
      this.settings = { ...(this.settings as Settings), ...patch };
      void this.sync();
    });
  }

  private isEnabled(f: Feature): boolean {
    const s = this.settings as Settings;
    return f.settingKey === null || s[f.settingKey] === true;
  }

  private async sync(): Promise<void> {
    const ctx: FeatureContext = { settings: this.settings as Settings };
    for (const f of this.features) {
      const shouldEnable = this.isEnabled(f);
      const isActive = this.active.has(f.id);
      if (shouldEnable && !isActive) {
        try {
          await f.enable(ctx);
          this.active.add(f.id);
          log.info("feature", "enabled", f.id);
        } catch (e) {
          log.error("feature", "enable failed", f.id, e);
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
