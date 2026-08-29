# Аудит архитектурных швов — 29.08.2026

Версия на момент аудита: `9.54.0`.

Статус документа: находки зафиксированы аудитором 29.08.2026 без правок кода.
В тот же день SEAM-01–08 исправлены, SEAM-09 закрыт переносом селекторов в
реестр SITE с записью границы стража в AGENTS §6 (с оговоркой: имена
атрибутов в getAttribute и регэкспах остаются литералами — см. §6); шум contract-теста разобран
(penaltyTooltip — наш собственный элемент, best-move-tooltip — мёртвый CSS,
девять умерших альтернатив составных селекторов внесены в разобранный список).
Подробности — в docs/review-ledger.md и коммите волны.

## Область проверки

Проверены пять направлений:

1. Дубли правил: миграции, coordinator/direct fallback, TTL, границы
   нормализации, storage-ключи, роли/цвета и route-гейты.
2. Направление зависимостей между `core`, `shared`, content-фичами, панелями,
   popup и background.
3. Все контракты `runtime.sendMessage`, `tabs.sendMessage` и `onMessage`,
   включая старый content-script с новым background и обратное сочетание.
4. Владение состоянием в `src/content/features/player-notes/*` после
   декомпозиции.
5. Соответствие инвариантов §4 из `AGENTS.md` реальным автоматическим стражам
   и ручная проверка lifecycle вне `features/**`.

Runtime ports в проекте не используются. Production-код в ходе аудита не
менялся.

## Резюме

Подтверждены:

| Серьёзность | Количество |
|---|---:|
| HIGH | 2 |
| MEDIUM | 6 |
| LOW | 1 |

Самый опасный класс связан с обновлением расширения во время живой игры:
новый background принимает молчание старого content-script за отрицательный
ответ о состоянии вкладки.

## Подтверждённые находки

### SEAM-01 — обновление расширения может остановить OBS-запись посреди игры

Серьёзность: **HIGH**. Статус: **ИСПРАВЛЕНО 29.08.2026**.

Код:

- `src/background/index.ts:111-125` — `countRoomTabs()` считает только ответы
  `inRoom === true`.
- `src/background/index.ts:134-153` — при нуле комнат watchdog останавливает
  запись и снимает `obs_auto_record_started`.
- `src/background/index.ts:928-934` — reconcile запускается после пробуждения
  background.
- `src/content/index.ts:259-263` — ответ на `obs_room_probe` существует только
  у живого content-контекста текущей версии.
- `src/core/messaging.ts:12-18` — после обновления старый content-контекст
  инвалидирован и не может обращаться к новому background.

Сценарий:

`автообновление во время матча` → `старый content-script не отвечает на
obs_room_probe` → `countRoomTabs() = 0` → `watchdog видит нашу активную запись`
→ `obs.stopRecord()` посреди игры.

Почему тесты зелёные: `tests/unit/obs-record-clip.test.ts:299-306` называет
сценарий молчащей вкладкой, но mock фактически отвечает `{inRoom:false}`, а не
`undefined`. Инвалидация старого content-контекста не моделируется.

### SEAM-02 — mixed-version probe разрешает автоматический выход из живого матча

Серьёзность: **HIGH**. Статус: **ИСПРАВЛЕНО 29.08.2026**.

Код:

- `src/background/index.ts:715-733` — все неответившие вкладки сводятся к
  итоговому `{live:false}`.
- `src/content/features/postgame-search.ts:275-308` — `undefined`, timeout и
  `{live:false}` дают `liveMatchGate() === "pass"`.
- `src/content/features/postgame-search.ts:800-819` — после `pass` разрешён
  автоклик «Покинуть игру».

Сценарий:

`основная игровая вкладка осталась на старом content-script` → `новая
поисковая вкладка отправляет postgame_live_query` → `старая живая /game-вкладка
не отвечает` → `background возвращает live:false` → `машина получает право
нажать «Покинуть игру»`.

Общая fail-open политика известна и закреплена тестами. Новая находка здесь —
не сама политика, а предсказуемый mixed-version путь сразу после обновления,
где «не знаю» относится к заведомо существующей игровой вкладке.

### SEAM-03 — позднее сохранение заметки воскрешает UI после выключения фичи

Серьёзность: **MEDIUM**. Статус: **ИСПРАВЛЕНО 29.08.2026**.

Код:

- `src/content/features/player-notes/note-modal.ts:242-308` — сохранение
  продолжается после `await model.saveNotes()` и вызывает refresh-сигналы.
- `src/content/features/player-notes/notes-model.ts:576-612` — обычное
  сохранение не проверяет `ctx.isActive()` перед callback'ами.
- `src/content/features/player-notes.ts:556-604` — `disable()` удаляет UI и
  помечает manager неактивным.
- `src/content/features/player-notes.ts:829-866` — `ensureProfileNoteUI()`
  создаёт кнопку профиля.
- `src/content/features/player-notes.ts:1536-1546` —
  `refreshNoteIndicators()` без lifecycle-гейта вызывает
  `ensureProfileNoteUI()`.

Сценарий:

`пользователь сохраняет заметку на профиле` → `операция ждёт background или
storage` → `statistics_enabled выключается` → `disable()` удаляет UI →
`Promise завершается` → `refreshIndicators()` → `.pn-profile-note-btn`
создаётся заново через уже выключенный manager.

`isActive()` защищает автоматическую миграцию ник→id, но не обычные операции
сохранения. Тест поздней миграции в `tests/unit/notes-model.test.ts:420-437`
этот путь не покрывает.

### SEAM-04 — async-хвост OBS снова скрывает роль после teardown

Серьёзность: **MEDIUM**. Статус: **ИСПРАВЛЕНО 29.08.2026**.

Код:

- `src/content/panels/obs-panel.ts:596-657` — скрытие роли ставит retry-таймер,
  а `hideRoleBeforeDaySceneSwitch()` содержит `await` на 30 мс.
- `src/content/panels/obs-panel.ts:1023-1043` — callback подтверждения фазы
  после `await` без lifecycle-гейта вызывает `scheduleRoleVisibility()`.
- `src/content/panels/obs-panel.ts:1210-1232` — teardown восстанавливает
  исходные стили роли.
- `src/content/panels/obs-panel.ts:1495-1505` — `disable()` снимает только уже
  существующий `pendingRoleVisibilityTimer`.

Сценарий:

`подтверждается переход на день` → `роль скрыта` → `30-мс await` → `в это окно
автомод выключается и restoreRoleVisibility() возвращает стили` → `старый
callback продолжает работу` → `ставится новый timer` → `роль снова скрывается
после teardown`.

`tests/invariants/obs-role-latch.test.ts` проверяет latch/retry статически, но
не гонку `await → disable`.

### SEAM-05 — Twitch сохраняет ложную готовность после отключения

Серьёзность: **MEDIUM**. Статус: **ИСПРАВЛЕНО 29.08.2026**.

Код:

- `src/content/panels/twitch-panel.ts:1259-1277` — `disconnect()` сбрасывает
  socket и `isConnected`, но не `ircReady` и не `reconnectAttempts`.
- `src/content/panels/twitch-panel.ts:1303-1308` — IRC `366` устанавливает
  `ircReady=true`.
- `src/content/panels/twitch-panel.ts:1413-1419` — `twitch_get_status`
  отвечает значением `ircReady`.
- `src/content/panels/twitch-panel.ts:1513-1541` — `disable()` не сбрасывает
  готовность и бюджет попыток.

Сценарий статуса:

`чат получил IRC 366` → `twitch_disconnect` или `disable()` → `сокета уже нет,
ircReady всё ещё true` → `следующий twitch_get_status` сообщает попапу
«Подключено».

Сценарий бюджета:

`исчерпаны 10 reconnect-попыток` → `фича выключена и включена заново` →
`reconnectAttempts всё ещё 10` → `после первой неудачи полноценного нового
reconnect-бюджета нет`.

`tests/unit/twitch-panel-lifecycle.test.ts:345-360` проверяет сокеты и таймеры,
но не статус и бюджет после teardown.

### SEAM-06 — direct fallback палитры молча теряет цвета

Серьёзность: **MEDIUM**. Статус: **ИСПРАВЛЕНО 29.08.2026**.

Код:

- `src/background/notes-coordinator.ts:141-182` — coordinator считает
  `dropped` и `purged`, пишет предупреждения и возвращает число потерь.
- `src/content/features/player-notes/notes-model.ts:220-260` — штатный
  coordinator-путь показывает `res.dropped` пользователю.
- `src/content/features/player-notes/notes-model.ts:265-283` — fallback
  фильтрует весь список, режет его до `MAX_CUSTOM_TAGS`, но возвращает `true`
  без сведений о потере.

Сценарий:

`background недоступен` → `на диске уже 100 цветов или есть unsafe
legacy-цвет` → `пользователь добавляет новый` → `fallback фильтрует и режет
список` → `новый цвет или legacy-элементы исчезают` → `операция отвечает
успехом без предупреждения`.

`tests/unit/notes-model.test.ts:542-575` покрывает свежесть чтения и unsafe
добавляемый цвет, но не заполненный fallback и очистку unsafe legacy-элементов.
Соответствующие проверки потерь существуют только для coordinator в
`tests/unit/notes-coordinator.test.ts:214-248`.

### SEAM-07 — один keydown назначает одну клавишу нескольким действиям

Серьёзность: **MEDIUM**. Статус: **ИСПРАВЛЕНО 29.08.2026**.

Код:

- `src/popup/index.ts:1185-1198` — отдельный listener захвата клавиши паузы.
- `src/popup/index.ts:1213-1240` — каждый role/outcry/clip capture создаёт ещё
  один независимый listener на `window`.
- `src/popup/index.ts:1563-1573` — все изменённые значения входят в
  сохраняемый patch.

Сценарий:

`нажать две capture-кнопки до ввода клавиши` → `на window остаются два
listener` → `один keydown проходит через оба, потому что stopPropagation() не
останавливает соседний listener на том же объекте` → `оба действия получают
один event.code` → `оба вызывают saveSettings()`.

Поведенческого теста на capture-сессию попапа нет.

### SEAM-08 — mixed-case импорт мьютов и скрытий не работает

Серьёзность: **LOW**. Статус: **ИСПРАВЛЕНО 29.08.2026**.

Код:

- `src/popup/index.ts:883-921` — импорт проверяет тип и длину строки, но не
  приводит ник к lowercase.
- `src/content/features/player-notes/tile-media-state.ts:56-89` — lookup
  мьюта использует lowercase, а load/adopt сохраняют исходную строку.
- `src/content/features/player-notes/tile-media-state.ts:155-188` — та же
  асимметрия у скрытия камеры.

Сценарий:

`backup содержит "MixedNick"` → `storage.local сохраняет MixedNick` →
`runtime спрашивает Set.has("mixednick")` → `мьют/скрытие не применяется`.

Свежий собственный экспорт обычно содержит lowercase. Основной риск — старые
или вручную изменённые backup-файлы.

### SEAM-09 — attribute-only селекторы role-marker обходят реестр

Серьёзность: **пробел стража; текущий пользовательский дефект не доказан**.
Статус: **ЗАКРЫТО 29.08.2026** (селекторы в реестре SITE; граница стража
записана в AGENTS §6).

Код:

- `src/content/features/role-marker.ts:70-105` — сырые `[data-game-id]` и
  `[data-game]` находятся вне `SITE`.
- `tests/invariants/architecture.test.ts:581-619` — страж анализирует классы
  и `classList`, но не attribute-only селекторы.
- `src/content/match-data.ts:65-71` — актуальный внешний контракт страницы
  разбора использует `:game-data`, а `[data-game]` является legacy.

До сырых атрибутов `resolveGameKey()` проверяет query, URL и
`SITE.gameIdBlock`, после них имеет fallback по составу. Поэтому доказательств
текущей неверной привязки `gameKey` нет. При выпадении ранних источников
legacy-ветка не поможет отличить рематч тем же составом.

## Дубли правил

| Область | Реализации | Результат |
|---|---|---|
| Палитра | coordinator `notes-coordinator.ts:141-182`; fallback `notes-model.ts:220-283` | Подтверждённая разница: fallback не сообщает обрезку и очистку |
| Мьют/скрытие | popup `index.ts:883-921`; runtime `tile-media-state.ts:56-188` | Подтверждённая разница нормализации регистра |
| Ключи мьюта/скрытия | константы `tile-media-state.ts:23-28`; литералы `popup/index.ts:714-715,902-903` | Один storage-контракт описан независимо в двух слоях |
| Лимит roleMarks | `role-marker.ts:41-42`; `popup/index.ts:55,932-980` | Сейчас оба равны 50; автоматической связи нет |
| TTL истории | `player-stats.ts:47-48`; импорт в `history-store.ts:26,160,319-337` | Значение едино, но владелец истории зависит от TTL соседнего владельца |
| Notes coordinator/fallback | `notes-coordinator.ts:90-124`; `notes-model.ts:325-410`; `normalize-touched.ts` | Правила ключей, свежего чтения и обрезки сейчас согласованы |
| Импорт заметок | `notes-coordinator.ts:201-238`; `popup/import-fallback.ts:36-64` | Оба используют `mergeNotes(..., MAX_OWN_NOTE_TEXT)`; расхождения не найдено |
| Match outcome | `src/content/match-outcome.ts`; `match-stats.ts` | Правило единственное, включая `num == null`, `yes > no`, список `departed` |
| Route gates | `@shared/routes` у основных room/search/profile фич | Значимого конкурирующего определения маршрута не найдено |

## Направление зависимостей

Циклов импортов не найдено. `src/content/index.ts` остаётся composition root:
он импортирует и регистрирует фичи, обратных импортов к нему нет.

Прямые межфичевые рёбра:

| Откуда | Куда | Оценка |
|---|---|---|
| `profile-mmr-chart.ts:19` | `profile-crossover.ts` | Same-layer: route parser принадлежит другой фиче |
| `postgame-search.ts:56` | `queue-requeue.ts` | Same-layer: классификатор стадии принадлежит другой фиче |
| `postgame-search.ts:61-62` | `requeue-pending.ts` | Leaf-helper, несмотря на расположение в `features/` |
| `tooltip.ts:15` | `match-stats.ts` | Same-layer: tooltip зависит от палитры другой фичи |
| `hotkey-hints.ts:24` | `outcry-hotkey.ts` | Same-layer: подсказки зависят от DOM finder другой фичи |
| `auto-start.ts:23` | `queue-requeue.ts` | Same-layer: auto-start меняет состояние queue-requeue |
| `queue-requeue.ts:54-55` | `requeue-pending.ts` | Leaf-helper |
| `popup/index.ts:117` | `content/nickname-lengths.ts` | Обратное layer-ребро, но только `import type` |
| `history-store.ts:26` | `player-stats.ts` | Скрытая связь владельцев через `STATS_TTL_MS` |

Внутри `player-notes/*` направление в основном чистое: оркестратор зависит от
leaf/store-модулей, а leaf-модули не импортируют оркестратор. Единственное
ownership-ребро между stores — `history-store → player-stats` ради TTL.

Скрытые строковые контракты остаются для storage (`pn_muted_players`,
`pn_hidden_players`, `roleMarks`), page-world сообщений (`pn-room-probe`) и
некоторых DOM data-атрибутов. Runtime message names сведены в `ExtMessage`.

## Контракты сообщений

Все каналы построены на `runtime.sendMessage`, `tabs.sendMessage` и
`onMessage`.

| Контракт | Отправитель | Получатель | Нет ответа / malformed |
|---|---|---|---|
| `obs_command` | popup `2252-2262`; OBS panel `362-366`; record/clip features | background `593-597` | `{success:false}` и `undefined` становятся ошибкой |
| `obs_event` | `background/obs-client.ts:729-730` | popup `1855-1862`; OBS panel `1417-1422` | Broadcast, ответ не нужен |
| `obs_endpoint_set` | popup `846-855,1630-1659` | background `616-675` | `ok !== true` показывается как отказ |
| `updateNotesSettings` | popup `867,1667,2211,2221` | player-notes `459-484` | Fire-and-forget; storage events остаются вторым путём |
| Twitch control variants | popup | twitch-panel `1380-1432,1446-1448` | Прямого ответа нет; status приходит отдельным сообщением |
| `twitch_status` | twitch-panel `901-903` | popup `1863-1883` | Попап имеет timeout; payload проверяется слабо |
| `getNicknameLengths` | popup `644` | `content/nickname-lengths.ts:39` | `undefined` показывается как «игроки не найдены» |
| `openNickColors` | popup `677` | player-notes `484` | Strict sender показывает отсутствие получателя |
| `getContentVersion` | popup `490-505` | content root `255-258` | Молчание гасится; orphan-watch отвечает за баннер |
| `obs_scene_owner_ping` | background `377` | OBS panel `1423-1454` | Молчание трактуется как отсутствие активного владельца |
| `notes_apply_ops` | NotesModel `328` | background `613-615` | `undefined`/небулевый ответ запускает direct fallback; успех без counters даёт warning |
| `notes_tag_ops` | NotesModel `239` | background `610-612` | `undefined`/malformed запускает fallback; успех без списка даёт warning |
| `notes_merge` | popup import | background `680-682` | `undefined` разрешает fallback; malformed живого coordinator даёт refusal |
| `notes_migrate` | notes-store `661` | background `677-679` | Без подтверждения миграция остаётся незавершённой и может повториться |
| `startSearch` / `stopSearch` | search feature `33-35` | background `599-607` | Новый background отвечает no-op `ok:true` старым вкладкам |
| `queueGuardArm` | queue-guard `78` | background `685-692` | `ok !== true` не считается успешным взводом |
| `queueGuardCancel` | queue-guard `50` | background `701-710` | Fire-and-forget |
| `queueGuardPing` | background `782` | queue-guard `166` | Нет ответа — background не подтверждает состояние очереди |
| `postgame_live_query` | postgame `277` | background `698-700` | `undefined` становится `live:false` |
| `postgame_live_probe` | background `730` | postgame `989` | Только `live === true` блокирует действие |
| `obs_room_probe` | background `118` | content root `261-263` | Только `inRoom === true` считается комнатой |
| `ws_log_flush` / `ws_log_reset` | popup `266,340` | ws-log `74-80` | Выключенная фича не отвечает; flush ждёт доступные вкладки |
| `diag_state` | popup `187` | content root `265-266` | Неответившая вкладка отсутствует в snapshot |

Общая граница `src/core/messaging.ts:38-63` превращает delivery errors в
`undefined`. Это стирает различие между «получателя нет», «старая версия не
знает message type» и «контекст инвалидирован».

Handlers типизируют вход кастом к `ExtMessage`, не валидируя runtime payload
целиком. Неизвестный объект обычно игнорируется. `null` или primitive способен
бросить на выражении `"type" in msg`, но канал доступен только контекстам
расширения, поэтому внешнего сценария атаки не найдено.

### Mixed-version матрица

| Сочетание | Эффект |
|---|---|
| Новый background + старый live content | SEAM-01 и SEAM-02: молчание на probes становится отрицательным ответом |
| Новый content + старый background | Notes и palette переходят в direct fallback; `obs_endpoint_set` не работает; новые команды требуют F5 |
| Новый background + старый content для `startSearch/stopSearch` | Совместимость сохранена явным no-op |
| Старый background + новый content для OBS events | Известные типы продолжают обрабатываться; новые поля в основном игнорируются |
| Старый content + новый popup | Strict-команды показывают ошибку; обычные broadcast-команды могут быть молча проигнорированы |

## Владение состоянием player-notes

| Модуль | Владеет |
|---|---|
| `flipped-players.ts` | Чистый parser недоверенного sessionStorage; mutable-state нет |
| `history-store.ts:81-107` | Crossover/last-games caches, in-flight promises, progress callbacks, warm flags |
| `modal-port.ts` | Только интерфейс границы модалок; состояния нет |
| `nick-color-manager.ts:169-187` | Локальное состояние окна: expanded key, saved indicator и timer; данные пишет через NotesModel |
| `normalize-touched.ts` | Чистая нормализация затронутых записей |
| `note-keys.ts:30-38` | TTL-кэш nick→id-key; карту получает через read callback |
| `note-modal.ts:223-306` | Локальное состояние формы и openedKey; напрямую мутирует карту NotesModel |
| `notes-model.ts:76-110` | Notes map, palette, hydration flags, write queue, NoteKeys |
| `player-stats.ts:151-157` | Stats values, fetched timestamps, in-flight, error backoff, active-game checks |
| `styles.ts` | CSS-константы и чистые вычисления |
| `tag-palette.ts` | Immutable presets |
| `tile-media-state.ts:37-50` | muted/unmuted, hidden/unhidden, flipped и их storage lifecycle |
| `player-notes.ts:253-400` | Feature lifecycle, settings, DOM UI, tooltips, profile IDs, rebuild throttling и композиция stores |

Главное нарушение заявленного владения находится в
`note-modal.ts:258-291`: getter `NotesModel.notes` документирован как read-only
в `notes-model.ts:116-119`, но возвращает mutable map, которую модалка меняет
напрямую. Операция завёрнута в `model.enqueue()` и делает rollback, поэтому
внутривкладочная сериализация сейчас не потеряна. Однако обычный save оказался
вне `isActive()` lifecycle-гейта, что проявилось в SEAM-03.

Остальные вынесенные модули чужое состояние напрямую не мутируют.
`nick-color-manager` использует методы `setNickColor`, `setNoteText` и
`deleteEntry`; `history-store`, `player-stats` и `tile-media-state` владеют
своими cache/set полями.

## Карта инвариантов

| §4 | Автоматическая защита | Что ленивое нарушение пропустит |
|---|---|---|
| §4.1 DOM fixpoint | `dom-fixpoint.test.ts`, `dom-enrollment.test.ts`, runtime storm guard | Реальный fixpoint гоняется только для 2 profile-фич; остальные 16 subscribers находятся в reviewed EXEMPT |
| §4.1а selectors | AST-поиск классов и `classList`; live contract | Attribute-only selectors вроде `[data-game]` не видны; contract требует каждый класс составного selector и даёт ложные тревоги |
| §4.2 autoclicks | Специальные проверки auto-start и unit-тесты машин | Нет общего enrollment всех `click()`/`safeClick()` путей |
| §4.3 storage | AST-списки writers notes/palette, frozen sync bridge | Нет общего стража locality `obs_password`; косвенные patch writers ловятся частично |
| §4.4 popup diff | Source assertions `architecture.test.ts:880-889` | Не AST: whole-snapshot вызов другой формы способен пройти |
| §4.5 hotkeys | Router и role-faker predicate | `f5-refresh.ts:19-29` не проверяется; popup capture также вне политики |
| §4.6 WebSocket teardown | Проверяется наличие четырёх `handler = null` | Не проверяется `ircReady`/reconnect budget; SEAM-05 прошёл |
| §4.7 lifecycle | AST-счёт add/remove и set/clear под `features/**` | Не проверяются panels, popup и core; не сопоставляются target/callback; async continuations не считаются |
| §4.8/§4.9 match data | Parser order и поведенческие outcome tests | Посторонние потребители legacy `[data-game]` не охвачены |
| §4.10 SW state | Специализированные queue/OBS/postgame тесты | Нет общего запрета на module-state; mixed-version no-response не моделируется |
| §4.11 migrations | Notes migration data+flag и frozen bridge | Нет общего контроля атомарности всех `runUpgradeMigrations()` |
| §4.12 revived setting | Равенство `Settings` и `DEFAULT_SETTINGS` | Нельзя обнаружить, что старое ранее нечитавшееся значение стало читаться без разовой миграции |

### Отдельная граница §4.5

`src/content/features/f5-refresh.ts:19-29` формально не содержит
`isTypingContext` и `e.repeat`. Реального typing-багa не подтверждено: F5 не
производит текст, а repeat успевает лишь повторить reload до навигации. Это
пробел стража, а не отдельная пользовательская находка.

## Живой contract-тест

`npm run test:contract` красный на 11 записях:

```text
videoClickZone: .video-control
siteModalsWide: .vm--overlay
siteMenuItem: .base-menu__item
siteMenuWide: .base-menu__list
siteMenuWide: .base-menu__content
siteMenuWide: .context-menu
siteMenuOwning: .context-menu
menuClickable: .base-menu__item
siteModals: .vm--overlay
bestMoveTooltip: .best-move-tooltip
penaltyTooltip: .penalty-tooltip
```

`penalty-tooltip` создаёт само расширение в
`src/content/features/tooltip.ts:350-356`, поэтому его поиск в live site —
ложная проверка. `best-move-tooltip` является мёртвым собственным
selector/CSS. Остальные девять записей — исчезнувшие альтернативы внутри
составных selectors; отсутствие одной альтернативы не доказывает поломку
selector целиком.

Причина шума находится в `tests/contract/site-contract.test.ts:106-117`:
тест разбивает составной selector на классы и требует присутствия каждого.

## Проверено и чисто

- Runtime import cycles отсутствуют.
- Notes map и palette остаются в `storage.local`; frozen sync bridge не имеет
  writers.
- `obs_password` в текущем коде не пишется в sync и не рассылается content-
  вкладкам.
- Coordinator notes operations сериализованы одной background queue.
- Notes import coordinator/fallback используют общий `mergeNotes` и
  одинаковый `MAX_OWN_NOTE_TEXT`.
- Match outcome имеет одного владельца и поведенческие тесты реальных форм
  голосования.
- Единственный production `MutationObserver` остаётся в `src/core/dom.ts`.
- OBS и Twitch перед заменой WebSocket отвязывают все четыре handlers.
- Dual manifest, permissions, package/manifest versions и browser minimums
  проходят invariants.
- Popup основной save path пишет diff против `lastKnown` и подписан на
  storage changes.
- `openNickColors` использует strict delivery и сообщает о старой вкладке.
- WebSocket runtime ports отсутствуют, отдельного port lifecycle нет.
- Chrome MV3 и Firefox event-page используют одинаковые persisted OBS/queue
  keys; дополнительной browser-specific гонки не найдено.

## Результаты проверок

На состоянии репозитория во время аудита:

```text
npm test
84 test files passed
1326 tests passed

npm run typecheck
passed

npx tsc --noEmit -p tests/tsconfig.json
passed

npm run test:contract
1 test failed on 11 selector entries
6 tests passed
```

Отдельный adversarial-агент получил все 11 кандидатных находок с заданием
попытаться их опровергнуть. SEAM-01..08 подтверждены; SEAM-09 понижен до
пробела стража; отсутствие typing/repeat в F5 понижено до формального пробела
без доказанного пользовательского ущерба; contract-ошибка разобрана на две
собственные записи и девять исчезнувших альтернатив.
