# Polemica Notes

Расширение для [polemicagame.com](https://polemicagame.com): статистика игроков, заметки,
подмена роли, быстрая пауза, автопринятие игры, режим поворота камер, интеграция с OBS
и Twitch-чатом.

Единая кодовая база на TypeScript, собирается под **Chrome (MV3)** и **Firefox (MV3)**.

Код основан на работах [Phil_Richards](https://t.me/smartestphill).

## Установка (готовые сборки)

Скачай архив из [последнего релиза](https://github.com/fjfalcon/polemicagame_phil_extension/releases/latest):

- **Chrome** — `polemica-notes-chrome-<версия>.zip`: распаковать → открыть `chrome://extensions`
  → включить «Режим разработчика» → «Загрузить распакованное» → выбрать папку.
- **Firefox** — `polemica-notes-firefox-<версия>.zip`: распаковать → открыть `about:debugging#/runtime/this-firefox`
  → «Загрузить временное дополнение» → выбрать `manifest.json`.
  Временное дополнение слетает при перезапуске Firefox; для постоянной установки нужна подпись
  через AMO (`npx web-ext sign -s dist/firefox`).

## Сборка

```bash
npm install
npm run build           # собирает dist/chrome и dist/firefox
npm run build:chrome    # только Chrome
npm run build:firefox   # только Firefox
npm run typecheck       # tsc --noEmit
npm run lint:ext:firefox  # web-ext lint
```

Артефакты:
- `dist/chrome/` — распаковать в `chrome://extensions` → «Загрузить распакованное».
- `dist/firefox/` — `about:debugging` → «Загрузить временное дополнение» → выбрать `manifest.json`.
  Для публикации нужна подпись: `npx web-ext sign -s dist/firefox` (через AMO).
- Запуск Firefox для разработки: `npm run dev:firefox`.

## Архитектура

```
src/
  manifest/        manifest.base.json + overlay'и chrome/firefox (мерджатся в scripts/assemble.mjs)
  core/            браузеро-независимое ядро
    env.ts         webextension-polyfill → единый `browser.*` для обоих браузеров
    settings.ts    типизированные настройки поверх storage.sync (+ local для секретов)
    messaging.ts   типизированная шина сообщений
    feature.ts     FeatureManager — жизненный цикл фич по настройкам
    dom.ts         общий MutationObserver, waitForSelector, safeClick
    keyboard.ts    единый keyboard-роутер (F/E/F8/D без конфликтов)
    selectors.ts   ВСЕ привязки к разметке сайта в одном месте
    FloatingPanel.ts  база для OBS/Twitch панелей (drag/resize/persist)
    modal.ts       кастомные модалки (без подмены нативного confirm)
    escape.ts      escapeHtml (защита от XSS)
    log.ts         логгер с уровнями
  background/      service worker (Chrome) / event page (Firefox)
    obs-client.ts  OBS WebSocket v5
    auto-accept.ts автопринятие через scripting.executeScript
  content/         единый content.js
    index.ts       bootstrap: регистрирует все фичи в FeatureManager
    features/       search, auto-start, player-notes, match-stats, tooltip,
                    role-faker, pause-hotkey, camera-rotate
    panels/         obs-panel, twitch-panel
  popup/           UI настроек
  static/          popup.html, notes.css, иконки
shared/types.ts    Settings + протокол сообщений
legacy/            прежняя версия расширения (исходники до рефакторинга)
tests/fixtures/    HTML/JSON матчей для проверки селекторов
```

### Ключевые принципы
- **Кросс-браузерность**: весь код работает через `browser.*` (polyfill). Различия Chrome/Firefox
  только в манифесте (`service_worker` vs `background.scripts`, `browser_specific_settings.gecko`).
- **Фичи** реализуют интерфейс `Feature` (`enable/disable/update`). `FeatureManager` включает/выключает
  их по настройкам — без перезагрузки страницы. `disable()` обязан снимать все слушатели/observers.
- **Настройки** — единый источник правды (`core/settings`). Пароль OBS хранится в `storage.local`
  (не уходит в облачную синхронизацию).
- **Селекторы сайта** — только в `core/selectors.ts`. При редизайне сайта правится один файл.

## Что изменено относительно прежней версии (`legacy/`)
- TypeScript + сборка (tsup), две цели из одного кода.
- `chrome.*` → `browser.*` (polyfill) — работает в Firefox.
- Удалён `chrome.scripting.executeScript` из popup (длина ников — через сообщение в content).
- Один `content.js` вместо 11 скриптов; один общий `MutationObserver` и один keyboard-роутер.
- Фиксы: `content_scripts.matches` покрывает `www.`; убран неиспользуемый `externally_connectable`;
  пароль OBS — в `storage.local`; нативный `window.confirm` больше не переопределяется.
- Удалён мёртвый код (`content-notes2.js`, `module-manager.js`, `*.py`, `head.hex`).

## Режим поворота камер

Фича `src/content/features/camera-rotate.ts` — порт пользовательского userscript
[«Rotate Mafia Game Videos»](https://github.com/fjfalcon/mafia_online_javascripts/blob/main/polemicagame.js)
(fjfalcon). В Firefox видео игроков иногда отображается перевёрнутым; при включённом
тумблере «Режим поворота камер» клик по игроку переворачивает его камеру на 180°
(зеркально, через canvas-оверлей), повторный клик возвращает оригинал. Исходник
userscript сохранён в `legacy/userscript-camera.js`.
