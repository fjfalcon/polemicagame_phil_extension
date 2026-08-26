# Аудит производительности Polemica Notes — 26.08.2026

## Резюме

Проверен commit `300eb92` (версия 9.39.0) без изменения production-кода.
Предыдущая карта стоимости была снята 06.08.2026 на commit `2e7aeac`
(версия 9.5.0). С тех пор прошло 86 коммитов и изменено 62 production-файла.

Аудит выполнен шестью параллельными срезами с последующей ручной проверкой
громких находок:

1. общий DOM observer и все его подписчики;
2. таймеры, layout, media и высокочастотные события;
3. storage, сеть, сообщения и журналы;
4. background, OBS и долгие MV3-сессии;
5. startup, bundle и route activation;
6. исполняемость старых perf-бюджетов.

Итог:

- блокеров/P0 не найдено;
- 2 находки высокой важности;
- 11 находок средней важности;
- 5 низкоприоритетных хвостов;
- старые PERF-3, PERF-5 (опасная часть), PERF-6, PERF-7 (два сокета), PERF-8
  (основной cadence) и PERF-10 остаются исправленными;
- главный новый default-риск — суммарная стоимость множества небольших
  DOM-подписчиков, появившихся после 9.5;
- главный сетевой риск по умолчанию — автоматический прогрев пересечений;
- главный optional-риск — полный WS-журнал, который делит квоту с заметками;
- только 4 из 18 бюджетов старого отчёта имеют сильную исполняемую защиту.

Живой CPU/heap trace с установленным расширением не снят. Статические selector
counts, request counts и payload bounds ниже не выдаются за миллисекунды.
Протокол обязательного живого замера приведён в конце.

## Baseline

### Сборка

Локальная production-сборка 26.08.2026:

| Артефакт | Размер |
|---|---:|
| `content.js` | 402 743 B |
| `content.js`, gzip | 106 492 B |
| `background.js` | 58 764 B |
| `popup.js` | 82 969 B |
| `conn-diag-page.js` | 2 509 B |
| `media-probe-page.js` | 1 949 B |
| `room-probe-page.js` | 956 B |
| `room-probe-inject.js` | 646 B |
| `notes.css` | 8 377 B |

`tsup.config.ts:11-42`: `iife`, `splitting:false`, `treeshake:true`,
`minify:true`. Минификация, отсутствовавшая до первого аудита, остаётся
включённой.

По release-артефактам content bundle вырос с 298 941 B в 9.5.0 до 402 743 B
в 9.39.0: +103 802 B, или +34,7%. Число зарегистрированных content-фич выросло
с 16 до 30 (`src/content/index.ts:20-83`).

Воспроизводимые команды для текущего артефакта (macOS):

```bash
npm run build
stat -f '%N %z' .dist-js/*.js dist/chrome/notes.css
gzip -c .dist-js/content.js | wc -c
```

Baseline 9.5.0 взят из release archive, а не из исходного TypeScript diff:

```bash
gh release download v9.5.0 --pattern polemica-chrome.zip --dir /tmp/pn-perf-9.5.0
unzip -p /tmp/pn-perf-9.5.0/polemica-chrome.zip content.js | wc -c
```

На Linux вместо `stat -f` нужен `stat -c '%n %s'`.

### Проверки

- `npm run build` — успешно;
- `npm run typecheck` — успешно;
- `npx tsc --noEmit -p tests/tsconfig.json` — успешно;
- `npm test` — 73 файла, 1093 теста, все успешно.

Зелёный набор не подтверждает все заявленные perf-бюджеты: разрыв между
названием теста и реально измеряемым критерием разобран в PERF26-6.

### Модель нагрузки

- foreground-комната, 10 игроков и 10 video;
- сайт непрерывно меняет `class/style` индикаторов речи и звука;
- SharedDomObserver работает на верхней частоте 4 flush/с;
- отдельно считаются default, optional и user-driven сценарии;
- длинная стримерская сессия — 3 часа;
- верхние границы batch — 4000 `MutationRecord`;
- network payload histories взят из измерений, зафиксированных в
  `src/core/crossover.ts:188-208`: 2000 строк примерно 660 КБ.

## Находки

### PERF26-1 — MEDIUM, default: новые DOM-подписчики суммарно сверяют комнату на каждый flush

**Файлы:**

- `src/content/features/camera-health.ts:140-149,272-295`;
- `src/content/features/controls-safety.ts:122-137,154-174`;
- `src/content/features/hotkey-hints.ts:110-149`;
- `src/content/features/postgame-search.ts:944-979,981-1008`;
- `src/core/dom.ts:92-159,193-220`.

Все четыре фичи включены по умолчанию и не фильтруют mutation batch до полной
сверки своего состояния.

В стабильной комнате один общий flush выполняет ориентировочно:

- camera-health: поиск кнопки, host и control center, обход кнопок центра;
- controls-safety: поиск control center и обход его кнопок с нормализацией
  `textContent`;
- hotkey-hints: поиск пунктов меню и всех `[data-pn-key]`; при найденном меню —
  visibility/layout reads;
- postgame-search: проверки итогового экрана, viewer/eliminated-state и своей
  кнопки.

Суммарный порядок — около 7–8 document-scoped QS/QSA и 2 scoped QSA за flush,
то есть примерно 28–32 document-scoped и 8 scoped selector calls/с при
saturation. Это число вызовов API, а не доказательство полного обхода DOM:
браузер может обслуживать class/id selectors через внутренние индексы.
У выбывшего игрока postgame дополнительно может делать
`getComputedStyle + getBoundingClientRect` до 4 раз/с
(`postgame-search.ts:383-385`).

Это не возврат старого PERF-1 в одной фиче. Это новый composition-риск: каждая
сверка умеренная и идемпотентная, но четыре новых default-потребителя делят
один и тот же непрерывный cadence сайта.

**Сценарий:** обычная игра с дефолтами; состав кнопок и состояние матча не
меняются, но `class/style` звука поддерживают 4 flush/с.

**Нужный бюджет:** hostile attribute-only batch не должен запускать full
reconciliation этих фич; stable room должен иметь измеренный общий selector и
layout budget, а не только отдельные functional tests.

### PERF26-2 — MEDIUM, default: route-specific ресурсы живут на всех маршрутах

**Файлы:**

- `src/content/features/auto-start.ts:978-989,1149-1162,1290-1324`;
- `src/content/features/camera-health.ts:124-193,266-295`;
- `src/content/features/player-notes.ts:537-583`;
- `src/content/features/tooltip.ts:399-477`;
- `src/content/features/profile-crossover.ts:113-151,191-207`;
- `src/content/features/profile-mmr-chart.ts:89-148,184-203`;
- `src/core/feature.ts:89-106`.

FeatureManager гейтит настройки, но не маршруты. На произвольной странице
остаются примерно 11 callbacks общего observer и семь recurring intervals.
Сам факт живого lifecycle shell не равен дорогой работе: многие callbacks
возвращаются после route/state gate, а queue-guard и match-stats имеют отдельный
route lifecycle. Finding относится к перечисленной ниже остаточной работе.

Подтверждённые расходы вне целевого маршрута:

- auto-start раз в секунду ищет welcome modal и до двух признаков lobby:
  примерно 3 document QS/с, до 15 QS/с при added-node saturation;
- camera-health каждые 2 секунды делает document-scoped QSA overlays даже вне
  комнаты; interval и subscriber живут, даже если обе camera-настройки false;
- player-notes держит двухсекундный fallback на всех маршрутах;
- tooltip проверяет каждый добавленный Element scoped selector call по его
  subtree;
- две профильные фичи при childList вне профиля всё равно ищут и удаляют свои
  карточки: до 8 document-scoped selector calls/с вместе.

Старый PERF-4 (auto-game polling вне room) остаётся открытым. Опасная часть
старого PERF-5 исправлена: OBS не детектирует фазу и не переключает сцену вне
комнаты, но его optional batch-filter также остаётся подписанным на общий
observer.

**Сценарий:** пользователь несколько часов держит поиск, профиль или разбор
матча; игровые фичи продолжают polling и observer callbacks без полезного UI.

**Нужный бюджет:** на нерелевантном route — 0 периодических route-specific
full reconciliations и не
более 3 действительно общих subscribers. Route-specific feature должна
mount/unmount, а не только возвращаться внутри callback.

### PERF26-3 — MEDIUM, default: ночной прогрев crossover имеет высокий структурный потолок

**Файлы:**

- `src/core/crossover.ts:188-220,254-318`;
- `src/content/features/player-notes.ts:3364-3505`;
- defaults: `src/core/settings.ts:48-58`.

`btn_crossover_enabled=true` по умолчанию. С первой ночи
`pumpCrossoverWarm()` последовательно прогревает каждого игрока стола. Одна
история имеет до четырёх страниц по 2000 строк:

- своя история: до 4 запросов / 2,64 МБ;
- 9 соперников: до 36 запросов / 23,76 МБ;
- теоретический итог: до 40 запросов / примерно 26,4 МБ и до 80 000 разобранных
  строк.

Это структурный потолок, не измеренная типичная стоимость. Он требует, чтобы
все десять историй нуждались во всех четырёх страницах, страницы были близки к
полным, а `reachedDepth()` не остановил чужие истории раньше. Четвёртая
страница аккаунта из исходного замера на 6196 игр частичная; 660 КБ — один
измеренный sample полной страницы, а не гарантированный размер каждого ответа.

`warmBusy` не даёт залпа девяти игроков одновременно, но не уменьшает общий
объём. Внутри одной пары первая чужая страница и своя история идут вместе, а
оставшиеся страницы загружаются через `Promise.all`; peak — до четырёх тяжёлых
requests.

Отмены при выходе из комнаты/disable нет. Room и profile surfaces имеют
независимые caches, поэтому открытие профиля уже прогретого игрока способно
повторно скачать обе истории.

**Сценарий потолка:** пользователь играет состав из десяти аккаунтов с очень
длинными почти непересекающимися историями; первой ночью расширение без
действия пользователя прогревает стол, затем профиль игрока повторяет работу
другим cache. Typical/p95 объём пока не измерен.

**Нужный бюджет:** ограничение общего byte/request budget на стол; общий cache
между room/profile; отмена при route/disable; preload только до минимальной
глубины или по более сильному intent.

### PERF26-4 — HIGH, optional: WS-log не держит заявленный общий cap и не имеет backpressure

**Файлы:**

- `src/core/ws-log.ts:42-49,85-188,191-263`;
- `src/content/features/ws-log.ts:50-85`.

Настройка выключена по умолчанию, но журнал делит `storage.local` с заметками,
поэтому quota-риск важнее обычного optional CPU.

Три независимых механизма:

1. `enable()` вызывает `void sweepStorage()`, но игнорирует возвращённый объём.
   Sweep может оставить 2 000 000 символов старых сессий, после чего локальный
   `storedChars=0` разрешает текущей сессии записать ещё 2 000 000. Фактическая
   WS-owned объём может приблизиться к 4–4,2 млн code units до учёта metadata,
   заметок, остальных local-ключей и различий browser quota. Фактический отказ
   storage способен случиться существенно раньше.
2. `flushChain` сериализует writes, но число ожидающих chunks не ограничено.
   За одну задержку storage `D` при потоке `R` добавляется примерно `R × D`;
   если arrival rate устойчиво выше service rate, backlog closures продолжает
   расти со временем без фиксированной границы.
3. Малый непрерывный поток сбрасывается раз в 5 секунд: до 2160 отдельных
   storage keys за 3 часа. Лимит символов не ограничивает число ключей.

Дополнительно `disable()` делает `void flushNow(); resetBuffer();`: seq и
accounting сбрасываются до завершения старой chain, а `SESSION_ID` остаётся тем
же. Повторное включение может переиспользовать старые keys и рассинхронизировать
учёт.

**Сценарий:** стример включает полный лог на три часа, storage замедляется или
настройка переключается; очередь растёт, старые chunks не входят в текущий cap,
а отказ квоты способен помешать сохранению заметок до реактивной уборки.

**Нужный бюджет:** один глобальный accounting после sweep, ограниченная очередь
pending chunks/bytes, cap по числу keys, lifecycle generation для flush chain.
Текущие tests уже защищают внутрисессионный cap и отдельный sweep, но не
old+new accounting, slow storage и toggle generation.

### PERF26-5 — MEDIUM, startup: content bundle вырос на 34,7% и остаётся монолитом

**Файлы:**

- `tsup.config.ts:11-42`;
- `src/content/index.ts:20-83`;
- `src/manifest/manifest.base.json:44-55`.

Весь минифицированный `content.js` размером 402 743 B загружается на каждом
`*.polemicagame.com/*`. Route gates не уменьшают parse/evaluate: код OBS,
Twitch, match stats, postgame, crossover, media и queue-фич импортирован до
проверки URL и настроек.

Минификация исправила старую проблему неминифицированных 449 KiB, но с 9.5
bundle вырос на 103 802 B. Абсолютное parse/evaluate время без trace не
оценивается.

**Сценарий:** открытие статичного профиля или разбора всё равно парсит все 30
feature modules.

**Предлагаемая policy до живого startup target:** временный regression gate
410 000 B, целевой предел 350 000 B; рост больше 10 000 B требует perf-review.
Эти числа не выведены из измеренного parse budget и должны быть заменены после
trace. До эксперимента с route entries нельзя обещать выигрыш от code splitting:
IIFE content scripts Chrome/Firefox требуют отдельной проверки доставки
ресурсов и lifecycle.

### PERF26-6 — HIGH, доказуемость: 8 из 18 старых бюджетов практически не исполняются

**Файлы:**

- `docs/audit-performance-2026-08-06.md:411-437`;
- `tests/unit/perf-budgets.test.ts:25-138`;
- `tests/invariants/dom-enrollment.test.ts:71-144`;
- `tests/invariants/dom-fixpoint.test.ts`.

Матрица старых budgets:

| Статус | Бюджеты |
|---|---|
| Сильная защита | tooltip, Twitch socket lifecycle, background OBS cadence, hidden-rAF race |
| Частичная | observer core, player mutation throttle, auto-accept scheduler, game-UI subscribers, requeue bridge, OBS route gate |
| Практически отсутствует | subscriber record cap, stable-room player cost, player cache cost, match-off zero-cost, log gate/IO, active-games overlap, timeout ownership, FloatingPanel gesture cost |

Примеры ложнозелёных регрессий:

- `MAX_PENDING=400000` или `MIN_FLUSH_INTERVAL_MS=10` не закреплены тестом;
- добавление 20 per-tile QS в player-notes не нарушит wiring test;
- tooltip test считает QSA, но не оставшийся subtree `querySelector`;
- requeue test проверяет изменение timestamp, а не число физических writes;
- Twitch cadence test допускает до четырёх сверок за тестовое окно около 1,6 с
  и не проверяет rolling-window `<=2/с`;
- большинство новых subscribers исключены из живого fixpoint harness узкими
  allowances enrollment-теста.

Зелёные 1093 теста поэтому не являются доказательством соблюдения всей таблицы
§6 старого отчёта.

**Нужный бюджет:** сначала превратить существующие обещания в instrumentation
tests, затем добавлять budgets новых фич. Новый exception ради зелёного теста
не считается закрытием.

### PERF26-7 — MEDIUM, user-driven: «Последние игры + ПУ» даёт до 90 запросов на стол

**Файлы:**

- `src/content/features/player-notes.ts:3583-3693`;
- `src/core/match-brief.ts:28-112`;
- defaults: `src/core/settings.ts:48-58`.

После hover intent 350 мс один новый игрок запускает один history request и до
восьми параллельных `/match/{id}`. Для десяти различных histories верхняя
граница — 90 requests, из них 80 match HTML. Число 2,48 МБ — экстраполяция
одного измеренного sample около 31 КБ: она требует 80 различных match pages
сопоставимого размера. Повторяющиеся match IDs сокращаются cache/in-flight
dedupe.

Per-player и per-match in-flight dedupe, timeout и permanent successful cache
работают. Не хватает глобального concurrency scheduler и отмены пачки после
`mouseleave`.

### PERF26-8 — MEDIUM: `/api/games` перекрывается после 15 секунд

**Файл:** `src/content/features/player-notes.ts:194-224`.

TTL записывается при старте P1. Если P1 живёт дольше 15 секунд, следующий
consumer запускает P2. Поздний reject P1 без identity check делает
`activeGamesPromise=null`, стирая marker P2 и открывая путь P3. У fetch нет
timeout/AbortSignal.

Это прямо нарушает бюджет «never overlap unresolved requests», сформулированный
в старом отчёте, и не покрыто тестом с двумя управляемыми promises.

### PERF26-9 — MEDIUM, startup: последовательный FeatureManager задерживается тяжёлым enable

**Файлы:**

- `src/core/feature.ts:96-135`;
- `src/content/index.ts:159-231`;
- `src/content/features/player-notes.ts:537-542`;
- `src/core/settings.ts:159-173`.

FeatureManager последовательно `await`-ит каждый `enable()`. Player-notes стоит
третьим и до активации всех следующих фич ждёт notes migration/load и отдельное
чтение muted players. Большая карта или медленный storage задерживает
независимые hotkeys, route UI и панели.

До feature-specific IO content startup дополнительно запускает минимум пять
sync read transactions для manager, log gate, router, WS mirror и orphan watch,
плюс local accesses. Эти top-level чтения стартуют независимо; finding здесь —
дублирование transactions, а не их последовательное исполнение.

Нужен один boot snapshot и явное разделение sync lifecycle shell от тяжёлой
асинхронной загрузки. Параллелить все `enable()` без проектирования нельзя:
текущая сериализация также защищает lifecycle и порядок shared resources.

### PERF26-10 — MEDIUM: обычный log ring переписывает весь буфер

**Файл:** `src/core/log.ts:306-390`.

При постоянном `info+` полный ring из 600 записей переписывается раз в 3 секунды.
При максимальных 600 code units поля message это до 360 000 message code units
плюс metadata на write. За 3 часа искусственно шумного одного context: 3600
writes и 1,296 млрд message code units плюс metadata, переданных storage API.
Это не равно физическим байтам записи на диск, но structured clone и
сериализация выполняются.

Нужен тест суммарного payload за длинную сессию и chunk/delta storage либо
явно принятый measured budget. Любая смена схемы обязана сохранить чтение
существующих log keys, экспорт, health markers и сообщение о quota failure.

### PERF26-11 — MEDIUM: одна заметка передаёт всю карту всем вкладкам

**Файлы:**

- `src/background/notes-coordinator.ts:31-70`;
- `src/core/notes-store.ts:500-535`;
- `src/content/features/player-notes.ts:618-652,897-947`.

Координатор корректно устраняет lost updates, но representation остаётся одной
картой. Для карты размера `S` и `T` вкладок одна точечная операция создаёт
концептуальный accounting порядка `(3 + 2T) × S`: full read, write, response и
old/new storage events. Это не измерение фактического копирования browser
backend. Затем каждая content-вкладка запускает четыре refresh path.

Пример модели: `S=40 КБ`, `T=4` — около 440 КБ map payload и 16 вызовов refresh
functions на одно редактирование; это не означает 16 равноценных полных DOM
scans. Finding user-driven, не steady-state, но масштабируется размером самой
ценной пользовательской базы. Любая смена representation обязана сохранить
`storage.local`, координатор, fail-closed `loadFailed`, атомарную миграцию и
замороженный sync-мост из AGENTS.md §4.3/§4.11.

### PERF26-12 — MEDIUM, background: один startup wake может запустить два OBS reconcile

**Файлы:**

- `src/background/index.ts:707-728,804-850,877-950`;
- `src/background/index.ts:157-189`.

Top-level `restoreObsConnection()` выполняется при каждой инкарнации SW.
`runtime.onStartup` независимо ставит второй reconcile; dedupe применяется
только к `probe=true` alarm path. При недоступном host два последовательных
connect могут занимать до 20 секунд очереди. Эта часть optional и требует
включённого OBS с недоступным host.

Даже при `obs_enabled=false` cold incarnation делает несколько повторных
settings/local reads и `alarms.clear`; это отдельный низкий default startup
расход, а не 20-секундный connect. Основной старый PERF-8 cadence исправлен, но
«one reconcile/wake» доказан только для alarm после завершённого boot.

### PERF26-13 — LOW, optional: watchdog проверяет orphan-marker каждую минуту

**Файл:** `src/background/index.ts:95-131,775-781`.

Каждый минутный OBS watchdog вызывает `reconcileAutoRecord()`. Проверяется не
текущая настройка, а ownership marker `obs_auto_record_started`: это намеренная
защита от осиротевшей записи. При пустом marker остаётся один local read:
номинально до 180 reads за 3 часа connected OBS. При нашем активном record
добавляются до 180 `GetRecordStatus`, 180 `tabs.query` и `180N` tab messages для
`N` вкладок.

Orphan-record correctness-защита нужна, но её cadence появился после старого
PERF-8 и не имеет отдельного бюджета.

### PERF26-14 — MEDIUM, optional: скрытая Twitch-панель продолжает IRC и DOM work

**Файлы:**

- `src/content/panels/twitch-panel.ts:508-571`;
- `src/content/panels/twitch-panel.ts:1037-1147,1474-1547`.

`twitch_floating_panel_enabled=false` вызывает `hidePanel()`, но намеренно не
disconnect: политика видимости отделена от route-policy. В режиме «чат везде»
сокет продолжает получать сообщения; каждое сообщение вставляет DOM-строку и
планирует сериализацию истории. При `atBottom` после записи дополнительно
читается layout-sensitive `scrollHeight`.

При `R` сообщений/с это `R` HTML insertions и до `R` layout-sensitive reads/с,
даже когда панель `display:none`. Finding opt-in: Twitch целиком выключен по
умолчанию.

### PERF26-15 — LOW, optional: connection-diag оставляет WebSocket hooks после выключения

**Файлы:**

- `src/content/features/connection-diag.ts:36-134`;
- `src/content/page/conn-diag-page.ts:23-187`.

PAGE probe заменяет `window.WebSocket`, `prototype.send`, четыре property
setter и `addEventListener`. Stop только ставит silenced flag; hooks остаются до
F5. Аргументы `say(...)` вычисляются до проверки flag, поэтому каждый будущий
frame продолжает оплачивать `String`, regex и URL formatting.

Для сокета, созданного через patched constructor, instance и prototype wrappers
также способны дважды классифицировать один frame. Фича диагностическая,
выключена по умолчанию и ставится только на search, поэтому без измерения frame
rate риск классифицирован как низкий и ограничен сессией после ручного
включения.

### PERF26-16 — LOW: update-check даёт межвкладочный burst

**Файл:** `src/content/features/update-notify.ts:119-169`.

У нескольких одновременно восстановленных non-store вкладок check cache не
атомарен: `T` вкладок могут прочитать старый timestamp и сделать до `T`
одинаковых GitHub requests через 4 секунды. Внутри одной вкладки это one-shot,
не recurring loop.

### PERF26-17 — LOW, optional: OBS scene change может рассылаться дважды

**Файл:** `src/background/obs-client.ts:478-484,537-542,714-718`.

Успешный `SetCurrentProgramScene` локально обновляет state и вызывает
`notifyAll`. Если после request response OBS присылает стандартное событие
`CurrentProgramSceneChanged`, оно повторяет запись и рассылку. Тогда на смену
сцены получается до двух state writes, двух `tabs.query` и `2N` tab messages.
Живой transcript этого порядка не снят; события фаз редкие, поэтому severity
низкая.

### PERF26-18 — LOW: warning о dropped mutations может усилить шторм

**Файл:** `src/core/dom.ts:193-220`.

Slow-flush warning ограничен разом в 5 секунд, а warning о переполнении batch —
нет. Поток больше 4000 records/250 мс может дать до 4 persistent log records/с
и регулярные full-ring writes, усиливая исходную перегрузку.

## Актуальная карта подписчиков

В production 20 вызовов `onDomChange` в 17 файлах. Definition в `core/dom.ts`
не считается подпиской.

| Подписчик | Default | Batch/route поведение |
|---|---|---|
| auto-accept | да | addedNodes, общий scheduler, scan route-gated |
| auto-start game | да | interval + addedNodes; room gate отсутствует |
| player-notes | да | attr игнорирует; inner full pass не чаще 1/с; classifier без record cap |
| tooltip | да | каждый added Element получает scoped subtree probe |
| camera-health | да | full `syncButton` на каждый flush |
| controls-safety | да | room gate, но full controls pass на каждый flush |
| hotkey-hints | да | room gate, но full hint pass на каждый flush |
| postgame-search | да | state-machine tick на каждый flush |
| nick-plate | shell | `opened.size===0` даёт дешёвый return |
| profile-crossover | да | childList filter; off-route document QS |
| profile-mmr-chart | да | childList filter; off-route document QSA |
| queue-guard | да | только search; foreground return |
| queue-peek | нет | search reconciliation |
| queue-requeue | нет | state-machine tick, storage refresh ≤1/5с |
| role-marker | нет | coalesced 250 мс player scan |
| role-faker | нет | только во время fake |
| match-stats | да | только active match/pending data |
| OBS phase | нет | detector route-gated, batch scan без local record cap |
| OBS panel UI | нет | childList, debounce ≤2/с |
| Twitch panel | нет | childList, debounce ≤2/с |

## Recurring timers

На дефолтах room/search/profile держат семь recurring intervals:

| Механизм | Период | Полезная работа вне целевого route |
|---|---:|---|
| URL router | 500 мс | href compare |
| auto-accept | 1 с | scheduler; scan только search |
| auto-start game | 1 с | до 3 selector lookups везде |
| freeze-watch | 1 с | часы без DOM; hidden result подавляется |
| player-notes fallback | 2 с | route reconciliation |
| camera-health | 2 с | overlay cleanup вне room |
| orphan-watch | 10 с | runtime liveness |

На `/match/:id` добавляется auto-height раз в 5 секунд. Optional: OBS phase
2 секунды, Twitch idle 60 секунд, session stats 3 минуты, connection-diag
рекурсивно 5 секунд.

Очереди queue-requeue/postgame, camera reconnect, role retries, Twitch reconnect,
match readiness и FloatingPanel используют bounded state-machine timers; новых
случаев timer multiplication в них не подтверждено.

## Старые PERF-1…12

| Пункт 06.08 | Текущий статус |
|---|---|
| PERF-1 player-notes full reconciliation | Частично закрыт: full pass дросселирован, record classifier без cap |
| PERF-2 OBS/Twitch document-scoped calls | Основной cadence снижен; появились новые default subscribers |
| PERF-3 duplicate auto-accept scan | Закрыт: общий scheduler |
| PERF-4 auto-game off-route | Открыт |
| PERF-5 OBS phase off-route | Опасная детекция/смена сцены закрыта; batch-filter без local cap |
| PERF-6 requeue storage refresh | Закрыт: refresh ≤1/5с |
| PERF-7 Twitch duplicate/lifetime | Duplicate socket закрыт; route policy изменена на «чат везде»; panel-hide cost остаётся |
| PERF-8 background OBS | Основной probe/write/retry budget закрыт; новые startup/record paths вне бюджета |
| PERF-9 match feature off | Setting key отделён и route teardown есть; zero-cost budget тестом не доказан |
| PERF-10 hidden rAF race | Закрыт и воспроизводится тестом |
| PERF-11 tooltip subtree scan | Cleanup закрыт; subtree `querySelector` и record cap остаются |
| PERF-12 bounded tails | Большинство прежних хвостов закрыто; owner ping timeout остаётся residual callback |

## Проверено и чисто

- Один production `MutationObserver`, cap 4000, foreground throttle 250 мс.
- В рассмотренных новых фичах не подтверждён устойчивый цикл
  `DOM write → observer → безусловный write`.
- Camera flip использует CSS transform; canvas/rAF-copy отсутствует.
- FloatingPanel коалесцирует pointermove через один rAF и пишет storage на
  завершении gesture.
- Auto-accept interval и observer используют один scheduler.
- OBS phase detector не сериализует body и не переключает сцену вне room.
- Queue-requeue и postgame используют по одному decision timer.
- Twitch держит не больше одного CONNECTING/OPEN socket; teardown handlers
  симметричен.
- Основной PERF-8: connected OBS не превышает 3 `GetVersion`/мин, state write
  реже probe, reconnect budget persisted и degraded mode ограничен.
- Успешный OBS request очищает свой 10-секундный timeout.
- Notes остаются в `storage.local`; coordinator предотвращает lost updates.
- Rating и player stats имеют in-flight dedupe/cache/backoff.
- Match-data отменяется на смене route.
- Session stats не опрашивает сеть в hidden tab и не перекрывает свой request.
- WS-log исключает media/SDP/ICE, режет кадр до 4000 символов, сериализует
  storage writes и останавливается после повторного quota failure.
- PAGE probes room/media отделены от основного bundle и ставятся условно.
- CSS меньше 10 KiB и не тянет внешние ресурсы.

## Новые исполняемые бюджеты

Приоритет 1 — закрепить существующие обещания:

1. `MAX_PENDING<=4000`, foreground interval `>=250ms`, subscriber record
   inspection `<=256` с одним fallback reconciliation.
2. Stable room с 10 tiles: общий QS/QSA/layout/write budget всех default
   subscribers, не только player-notes.
3. Off-route: 100 hostile batches дают 0 route-specific full scans.
4. `/api/games`: unresolved P1 не допускает P2; stale reject не очищает новую
   identity.
5. Log: полный ring, суммарный payload и write count за виртуальные 3 часа.
6. WS-log: old 2M + new session, slow storage backpressure, key count и toggle
   с незавершённым flush.

Приоритет 2 — новые фичи:

1. camera-health: 10 videos, stable tick без layout/write; 100 unrelated attr
   batches не запускают tile scan;
2. postgame: inactive route 100 batches → 0 selectors; active burst → не более
   двух full state scans/с;
3. controls/hotkey hints: relevant-root processing и настоящий fixpoint;
4. crossover: request/byte/concurrency budget на стол и cancel при teardown;
5. last-games: общий concurrency cap match HTML;
6. OBS record watchdog: один tabs query, один probe/tab, один reconcile/wake;
7. startup bundle-size gate и число storage transactions до активации.

## Живой замер

Статический аудит отвечает «что и как часто может выполняться», но не переводит
selectors в milliseconds на реальном DOM/железе.

Обязательный протокол:

1. Chrome stable, fresh profile, записать browser version и hardware.
2. Для A/B использовать воспроизводимые idle-сценарии: один lobby/search DOM,
   один и тот же профиль и сохранённый synthetic mutation workload. Live room
   после reload не является тем же участком матча.
3. Run A: extension disabled; Run B: 9.39.0 с default settings.
4. Активную комнату измерять matched windows одной и той же фазы, явно сохраняя
   вариативность сайта; не выдавать их за детерминированный A/B.
5. Optional runs разделить: C1 OBS, C2 Twitch, C3 WS full log, C4 combined.
6. Каждый run повторить минимум три раза, первые 10 секунд исключить, сравнивать
   median и разброс.
7. Отдельно повторить для idle `/game-search`, своего/чужого профиля и
   `/match/:id`.
8. Снять Performance с JS samples и memory, без screenshots.
9. Сравнить extension-attributed samples/marks и delta относительно disabled:
   scripting, long tasks, observer callbacks, style/layout, storage и network.
10. Heap сравнивать по retained objects после одинаковых GC/checkpoint
    условий или в нескольких длинных окнах; монотонность короткого окна сама по
    себе не доказывает leak.
11. Для attribution использовать временные Performance marks вокруг общего
    `flush()` и отдельных subscribers; инструментированный build не выпускать.

Минимальный acceptance target до уточнения baseline:

- extension-attributed delta не добавляет long task >50 мс поверх baseline
  сайта;
- один default DOM flush укладывается в 5 мс на целевой машине;
- retained extension-owned DOM/buffers не растут между одинаковыми длинными
  checkpoints без ограничивающего cap;
- default stable room не пишет storage, кроме событий журнала;
- default ночной crossover измеряется отдельно и не смешивается со steady DOM.

## Приоритет исправлений

1. Закрыть WS-log accounting/backpressure до следующего релиза с изменениями
   полного журнала: он делит квоту с заметками.
2. Ограничить/перепроектировать default crossover warm-up и объединить caches.
3. Ввести общий instrumentation budget новых default DOM subscribers и затем
   route-mount для самых дорогих.
4. Исправить overlap `/api/games` и ввести global scheduler match briefs.
5. Добавить bundle-size/startup-IO gates до дальнейшего роста feature count.
6. Закрыть разрыв между таблицей perf budgets и реально падающими тестами.
