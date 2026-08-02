# Аудит наблюдаемости Polemica Notes — 02.08.2026

## Резюме

Проверено дерево на commit `2badb57` в состоянии на 02.08.2026; при финальном
fact-check единственным незакоммиченным файлом был этот отчёт. В рамках аудита
production-код не менялся. Первичный просмотр выполнялся поверх `97731b2` с
будущими изменениями OBS/background в worktree; после их commit все выводы и
материальные ссылки повторно сверены с `2badb57`.
Аудит отвечает только на вопрос «можно ли доказать причину отказа по файлу
пользователя», а не объявляет само решение state machine ошибочным.

- КРИТИЧНО: 7.
- ВАЖНО: 16.
- МЕЛОЧЬ: 3.
- Обе исходные жалобы подтверждены как класс наблюдаемости: редкие решения
  `queue-requeue` и OBS раньше жили на `debug`; часть OBS-пути уже поднята на
  `info` в текущем дереве, но terminal/no-op состояния всё ещё невидимы.
- Главный общий риск: логгер может молча не сохранить журнал или молча собрать
  только текущий popup-буфер, то есть сам файл не сообщает о своей неполноте.
- Главный риск шума: штатный час даёт примерно 42–84 persisted-записи, но
  connection diagnostics или повторяющаяся DOM-ошибка способны заполнить ring
  из 600 строк за 10–60 минут и вытеснить начало отказа.

## Реальный контракт лога

`src/core/log.ts:75-80`, `278-283`, `316-338`:

- Runtime default `bufferLevel` равен `info`, и production-код его не меняет;
  `debug` не попадает ни в память ring, ни в `storage.local`, ни в экспорт.
  `polemica:loglevel=debug` меняет только консоль. Публичный setter существует,
  поэтому это текущий production contract, а не неизменяемая константа API.
- Ёмкость — 600 записей на context key; старые записи вытесняются первыми.
- Content получает отдельный storage key на document session, но поле `Entry.c`
  остаётся просто `content`; после flatten export identity ключа теряется.
- `info/warn` flush через 3 с, `error` через 400 мс. Chrome service worker не
  имеет `pagehide`, поэтому аварийная выгрузка может потерять хвост.
- `debug_logging_enabled=false` отключает persistence, а не включает/выключает
  debug-уровень. Все оценки ниже предполагают, что persistence включён.
- `fmtArgs()` не применяет `redactSecrets()` автоматически. Безопасность каждой
  динамической info/error-строки зависит от caller.

## Карта состояний отказа

| Фича | Значимые no-op/отказы | Что есть в экспортируемом логе | Вердикт |
|---|---|---|---|
| queue-requeue | готовность не найдена; retry-screen; trusted backoff; bridge/storage; окно/disabled/budget | часть переходов `info`, terminal window и retry-screen только `debug`, storage/backoff немы | находки QR-1..3 |
| auto-start | suppression/backoff; budget; неизвестная модалка; камера unresolved/give-up; роль не найдена/retry | почти всё решение на `debug`; только enable и неоднозначный modal limit на `info` | AS-1..3 |
| obs-panel | unknown/unstable phase; same scene; owner; request result; role target/retries; settings reapply | phase/attempt/success/owner уже видны; unknown/same/role/settings — нет | OP-1..3 |
| obs-client/background | gate/manual/block; handshake/close; retry result; heartbeat probe; durable state | connect/close/schedule/block видны, но trigger/category/gate и intentional disconnect — нет | OC-1..4 |
| queue-guard | arm/cancel; alarm stale; tab ping; notification/focus | `armed` есть до ack; failure/disarm/ping/stale/focus скрыты | QG-1..2 |
| queue-peek | credentials/API shape; safety refusal; retry queue; auto latch | финальная панель часто честна, но причины null не различимы | QP-1 |
| player-notes | load/read-only; coordinator; save; stats/history; DOM processing | данные/запись в целом хорошо видны; persistent DOM error способен затопить ring | PN-1 |
| twitch-panel | transport open/close; IRC ready; reconnect; idle; channel gate | persisted только `connecting`, idle/give-up/errors; normal outcome скрыт | TW-1..2 |
| role-faker | хоткей при отсутствии/неполной роли | обе причины только `debug` | RF-1 |
| role-marker | read-only; unresolved game key; write failure | initial load/save errors видны; конкретный blocked user action и unresolved key немы | RM-1..2 |

## Общая инфраструктура

### LOG-1 — КРИТИЧНО: файл лога не сообщает, что журнал не сохранился

**Код:** `src/core/log.ts:231-266`, `317-338`.

**Сценарий:** `storage.local.set/get` падает из-за квоты или временной ошибки,
пользователь экспортирует старый либо почти пустой файл и принимает его за
полный журнал.

**Сейчас:** `prime`, `flush` и `collectAll` поглощают исключения. При failed
flush `dirty` уже снят; при failed collect возвращается только buffer текущего
popup. Ни одной строки, признака completeness или toast нет.

**Нужно:** отдельный health-path, не рекурсивный `log.*`: throttled
`console.error("[polemica:log] журнал не сохранён", context, operation)` и при
экспорте synthetic `error: "Журнал собран не полностью: storage.local недоступен"`.
Уровень synthetic entry — `error`, максимум один на экспорт; popup toast с тем
же смыслом.

### LOG-2 — ВАЖНО: после экспорта невозможно разделить две игровые вкладки

**Код:** `src/core/log.ts:53-73`, `316-335`; `src/popup/index.ts:98-100`.

**Сценарий:** две игры открыты одновременно, одна владеет OBS, другая получает
отказ; строки обеих перемешиваются под одинаковым context `content`.

**Сейчас:** уникальный session ID существует только в storage key и теряется при
flatten. Boot содержит pathname, но не document/session identity.

**Нужно:** короткий случайный `documentSession` в Entry либо сохранение source
key при collection; `info: "content session=<short> route=/game"` один раз на
document. Tab ID не обязателен и потребовал бы background handshake.

### LOG-3 — ВАЖНО: sink не обеспечивает redaction

**Код:** `src/core/log.ts:102-121`, `278-289`;
`src/background/obs-client.ts:150`, `157`;
`src/content/panels/obs-panel.ts:865`, `873`, `888`;
`src/content/panels/twitch-panel.ts:861`.

**Сценарий:** `obs_host` содержит userinfo/query token или server-controlled
WebSocket close reason содержит секрет; строка `info` уходит в support file.

**Сейчас:** helper `redactSecrets` есть, но `fmtArgs` пишет raw arguments.
OBS логирует полный URL и `event.reason`. Статическая проверка имён секретов не
ловит секрет внутри URL/ошибки. Кроме секретов, persisted OBS attempt/success и
monitor строки содержат полные пользовательские имена сцен, а Twitch
connecting-line — имя канала.

**Нужно:** sink-level redaction после форматирования и до console/storage;
endpoint логировать только как protocol+host+port без userinfo/query/fragment,
close reason — нормализованная category/code. Это ограничение относится ко
всем предложенным ниже info-строкам. Существующие OBS scene-поля тоже заменить
на `configured|set|empty`, а Twitch channel — на `set|empty`, если владелец
отдельно не разрешит экспорт этих имён.

### LOG-4 — МЕЛОЧЬ: popup не соблюдает настройку persistence

**Код:** `src/core/log.ts:75-80`, `299-301`; `src/popup/index.ts:81-82`.

**Сценарий:** пользователь выключил «Вести логи», но ошибки popup продолжают
сохраняться, потому что popup не вызывает `setPersist` и default равен true.

**Нужно:** применить и подписать popup на ту же настройку. Лог-сообщение не
нужно; UI должен честно описывать, что настройка управляет persisted support
logs, а не debug verbosity.

## Queue Requeue

### QR-1 — КРИТИЧНО: terminal отказ автоклика не закрыт строкой результата

**Код:** `src/content/features/queue-requeue.ts:509-545`.

**Сценарий:** принятое лобби исчезло, но окно 8 с истекло, кнопка «Играть»
disabled/невидима либо trusted backoff удержал клик; пользователь остаётся вне
поиска.

**Сейчас:** истечение окна — `debug`; disabled/backoff/hidden — без строки.
`warn` есть только для модалки и бюджета трёх кликов. До первого клика журнал
не отличает «кнопка не появилась» от «машина перестала тикать».

**Нужно:** один terminal outcome на `info/warn`:

- `warn: "автовозврат остановлен: окно истекло, кнопка «Играть» не найдена"`;
- `info: "автовозврат остановлен: кнопка недоступна, требуется выбор очереди"`;
- при backoff не логировать каждый тик, а один раз
  `info: "автовозврат отложен после действия игрока"` и итог после окна.

Успешный trail закрыть в ветке `searchInProgress` одной строкой
`info: "поиск возобновлён: секундомер подтверждён"` перед reset.

Частота — 0–1 terminal line на развал.

### QR-2 — ВАЖНО: room-exit может остановиться после единственного grace tick

**Код:** `src/content/features/queue-requeue.ts:284-318`.

**Сценарий:** grace истёк, но trusted input был менее двух секунд назад; DOM
распущенной комнаты больше не меняется и новой точки решения может не быть.

**Сейчас:** журнал заканчивается на `идёт обратный отсчёт...`; backoff не виден.
Hidden-вкладка не теряет retry окончательно: `visibilitychange` вызывает новый
`tick()`, но сам defer также не фиксируется. Retry-screen имеет правильное
решение, но только `debug`.

**Нужно:** edge-triggered `info: "выход из распущенной комнаты отложен:
недавнее действие игрока"` и bounded retry после backoff; для hidden достаточно
одной строки defer и результата после visibility recovery. Retry-screen —
`info: "обнаружен обрыв связи; автопереход в поиск отменён"`. Не чаще одного
раза на состояние.

### QR-3 — ВАЖНО: session bridge теряет причину

**Код:** `src/content/features/queue-requeue.ts:331-345`, `368-415`, `484-488`.

**Сценарий:** `sessionStorage` недоступен, метка malformed/expired либо
accept-state не распознан; после reload/перехода второй этап не взводится.

**Сейчас:** storage catches немы; invalid age и отсутствие моста неразличимы.
При успехе одна timestamp-метка используется для разных источников, а строка
уверенно говорит «из распущенной комнаты».

**Нужно:** `warn: "не удалось сохранить мост автовозврата"`;
`info: "мост автовозврата пропущен: expired|invalid|unavailable"` с age bucket,
без raw timestamp; transition latch —
`info: "принятие лобби подтверждено; возврат после развала взведён"`.

## Auto Start

### AS-1 — КРИТИЧНО: автопринятие не оставляет action/outcome trail

**Код:** `src/content/features/auto-start.ts:123-253`.

**Сценарий:** карточка найдена, но невидима, suppress gate/backoff активен либо
элемент исчерпал три клика; пользователь жалуется «не приняло игру».

**Сейчас:** persisted есть только `auto-accept enabled`. Попытка клика и ошибки
селекторов — `debug`; terminal budget не логируется. Файл не отличает
«кандидата не было» от «клик был запрещён» и «три клика не сработали».

**Нужно:** не повышать каждый секундный scan. На реальный клик один
`info: "автопринятие: попытка N, target=button|card"`; при исчерпании
`warn: "автопринятие остановлено: лимит попыток исчерпан"`; suppression после
queue-peek — одна state-transition строка, не каждый тик. Не логировать textContent.
Все три target-ветки должны сходиться в этот outcome, иначе card/text fallback
останутся невидимыми.

### AS-2 — ВАЖНО: стартовая модалка и камера имеют невидимые terminal latches

**Код:** `src/content/features/auto-start.ts:782-843`, `886-988`.

**Сценарий:** welcome modal существует, но кнопка не распознана; либо camera
icon drift не даёт найти кнопку; либо десять кликов ставят `webcamGaveUp` до
конца лобби.

**Сейчас:** unknown modal молчит; click и camera identification — `debug`;
`webcamGaveUp=true` полностью нем. Единственный `info` про modal limit пишется
до знания результата третьей попытки и не различает причины.

**Нужно:** `warn: "стартовое окно найдено, но кнопка запуска не распознана"`
один раз на modal; `warn: "кнопка камеры не распознана: candidates=N"` один
раз на lobby; `warn: "камера не переключилась за 10 попыток; автоклики
остановлены до следующего лобби"`. Успех достаточно закрыть
`info: "стартовое окно закрыто после N попыток"` и
`info: "камера выключена, attempts=N"`, только на state transition.
Для модалки допустимы до трёх bounded
`info: "стартовое окно: попытка N, target=button|fallback"`. Identity камеры
логировать один раз на lobby как `known|position_fallback|missing`, а не каждый
из десяти кликов.

### AS-3 — ВАЖНО: управление ролью диагностируется только на debug

**Код:** `src/content/features/auto-start.ts:423-481`, `557-605`.

**Сценарий:** ночью role target не смонтирован или недавний ручной D отменил
показ; после retries пользовательская роль не показалась/не скрылась.

**Сейчас:** no target, schedule, manual skip, fire и retries — всё `debug`;
terminal exhaustion отсутствует. Успех CSS hide/show тоже не попадает в файл.

**Нужно:** state transitions на `info`:
`"роль скрыта для дневной фазы"`, `"ночной показ роли пропущен после ручного
действия"`; итоговый `warn: "видимость роли не подтверждена после 5 попыток"`.
Retry details оставить debug.

## OBS Panel / Automode

### OP-1 — КРИТИЧНО: успешная сцена может соседствовать с невидимым отказом роли

**Код:** `src/content/panels/obs-panel.ts:462-555`, `818-875`.

**Сценарий:** при переходе в день role target ещё отсутствует; сцена OBS
успешно меняется, но журнал не доказывает, была ли роль скрыта до switch.

**Сейчас:** отсутствие target и все retries — `debug`. Более того,
`hideRoleBeforeDaySceneSwitch()` безусловно ставит runtime latch `hidden` после
неуспешного `applyRoleVisibility(false)`. Следующий
`scheduleRoleVisibility("day")` сразу выходит по equality latch, то есть
retry-machine в этом сценарии вообще не запускается. Через 30 мс сцена может
переключиться, и её success-log создаёт ложное ощущение полного успеха.

**Нужно:** `warn: "роль не скрыта перед дневной сценой: элемент не найден;
scene switch выполняется в degraded mode"`; success `info` только после
фактического apply. Одного лога недостаточно для privacy-гарантии: дальнейшая
сцена должна зависеть от подтверждённого apply либо явно завершаться terminal
degraded outcome. Отдельный путь `scheduleRoleVisibility` всё ещё требует
`warn` после шести реальных попыток. Частота — один failure и один terminal
outcome на фазовый переход. Correctness-механика приведена только потому, что
она делает существующий журнал ложно успешным; решение о поведении отдельно.

### OP-2 — КРИТИЧНО: unknown/stable/same-scene состояния неразличимы

**Код:** `src/content/panels/obs-panel.ts:735-842`, `845-875`.

**Сценарий:** site marker перестал распознаваться и detector сохраняет прежнюю
фазу; либо фаза подтверждена, но нужная сцена уже active.

**Сейчас:** unknown fallback, неподтверждённая смена и `Scene already set` —
`debug`. В persisted-файле после `слежение ... запущено` может быть тишина,
одинаковая для здоровой стабильной фазы, мёртвого observer и selector drift.

**Нужно:** edge-triggered `warn: "фаза игры не распознана; сохраняем прежнюю
сцену"` и recovery `info`; для фазового решения
`info: "смена не требуется: сцена уже активна"`. Потиковые detector/result
строки оставить debug. Warning писать только на вход в unknown-state, затем
один recovery, без минутного повторения.

### OP-3 — ВАЖНО: изменение настройки не видно и не имеет outcome

**Код:** `src/content/panels/obs-panel.ts:1064-1089`, `794-806`.

**Сценарий:** пользователь повторно включает автомод или меняет scene mapping в
текущей фазе; equality latch не приводит к новой phase-transition строке.

**Сейчас:** изменения mapping и enabled — один object на `debug`; start monitor
виден, но неизвестно, вызвана ли сверка текущей сцены/роли.

**Нужно:** `info: "настройки автосцен изменены: enabled=true day=set night=set;
выполняем сверку текущей фазы"`, затем один из outcome OP-2/обычного switch.
Имена сцен допустимы только после решения владельца; безопаснее `set|empty`.

## OBS Client / Background

### OC-1 — ВАЖНО: повторные подключения не имеют нормализованного результата

**Код:** `src/background/obs-client.ts:263-292`.

**Сценарий:** десять retries заканчиваются terminal budget, но каждый
`connect()` reject внутри timer catch полностью поглощён.

**Сейчас:** видны schedule `reconnect N/10`, итог бюджета и для большинства
асинхронных отказов соседние `disconnected code reason` и/или `socket error`.
Но они не коррелированы с attempt и не дают надёжной category; timeout вызывает
`socket.close()` без явного кода, а синхронный throw конструктора WebSocket
может остаться только поглощённым rejection timer callback.

**Нужно:** на каждый failed attempt `warn: "переподключение OBS не удалось:
attempt=4/10 category=timeout|closed|socket next_delay_ms=..."`. Не писать URL,
password или raw Error.message. Максимум 10 строк на outage.

### OC-2 — ВАЖНО: reconcile gate и intentional disconnect немы

**Код:** `src/background/index.ts:81-105`, `107-125`.

**Сценарий:** reconnect пропущен из-за manual disconnect или durable retry
block; либо socket намеренно закрыт user/settings/master toggle.

**Сейчас:** ранние return не логируют reason. `disconnect()` отвязывает onclose,
поэтому обычной `disconnected code reason` тоже нет. Storage-флаги не входят в
support export.

**Нужно:** один раз на transition:
`info: "OBS reconcile пропущен: reason=manual_disconnect"`;
`warn: "OBS reconnect заблокирован: reason=auth|protocol attempts=N"`;
`info: "OBS отключён: reason=user|obs_disabled|extension_disabled"`.
Обычный default `obs_enabled=false` на каждом worker boot не логировать.

### OC-3 — ВАЖНО: watchdog заменяет соединение без причины в логе

**Код:** `src/background/obs-client.ts:489-499`;
`src/background/index.ts:94-105`, `429-432`, `479-480`.

**Сценарий:** `GetVersion` probe timeout/status error возвращает только false,
watchdog запускает connect; затем видна новая строка `подключено`, но не причина
замены старой сессии и не source reconcile.

**Нужно:** `warn: "проверка OBS не пройдена: source=watchdog request=GetVersion
category=timeout; выполняем reconnect"`. Healthy минутный watchdog не логировать.
Для startup/update/settings передавать source, но successful boot достаточно
одной строки, не каждого alarm.

### OC-4 — МЕЛОЧЬ: close line не сообщает принятого решения

**Код:** `src/background/obs-client.ts:156-182`.

**Сценарий:** OBS закрывает socket; из `disconnected code reason` нельзя сразу
понять phase handshake/connected, будет retry или durable block.

**Нужно:** единая нормализованная строка:
`warn: "OBS закрыла соединение: phase=handshake code=4009 action=block
reason=auth attempt=0"` или `action=retry|stop`. Raw reason не писать.

## Queue Guard

### QG-1 — КРИТИЧНО: `armed` утверждается до подтверждения background

**Код:** `src/content/features/queue-guard.ts:43-59`;
`src/core/messaging.ts:38-54`; `src/background/index.ts:320-321`, `353-358`.

**Сценарий:** старая вкладка не имеет receiver либо alarms API отвергает arm;
content остаётся `armed=true` и больше не повторяет попытку.

**Сейчас:** persisted говорит `armed`, хотя `sendRuntime` гасит rejection и
возвращает `undefined`; `.catch` в feature не срабатывает. Реальный arm failure
находится только на `debug` либо отсутствует. Это ложное evidence хуже тишины.

**Нужно:** latch и `info: "предупреждение очереди взведено alarm=confirmed"`
только после `{ok:true}`; background при `sender.tab.id === undefined` обязан
вернуть `{ok:false, category:"missing_tab"}`, а не текущий ложный success после
no-op `armQueueGuard(undefined)`. Иначе `warn: "предупреждение очереди не
взведено: background не подтвердил будильник"` и bounded retry. Correctness
ack-протокола указан потому, что без него proposed log тоже был бы ложным.

### QG-2 — ВАЖНО: disarm, ping miss и stale alarm не оставляют итог

**Код:** `src/content/features/queue-guard.ts:43-49`;
`src/background/index.ts:361-395`, `479-495`.

**Сценарий:** уведомление не показано, потому что очередь закончилась, вкладка
не ответила, стала видимой либо alarm просрочен.

**Сейчас:** disarm только `debug`; ping exception и stale cutoff немы. Поддержка
не отличает корректное подавление от сломанного messaging.

**Нужно:** `info: "предупреждение очереди снято: <bounded reason>"` на переход;
`info: "уведомление не показано: вкладка не ответила"` и
`"просроченный alarm пропущен, lateness_s=N"` один раз на alarm. Успех закрыть
`info: "уведомление очереди создано"`, без tab ID, если complaint trail должен
доказывать доставку до notifications API.

## Queue Peek

### QP-1 — ВАЖНО: null credentials/API не имеют причины

**Код:** `src/content/features/queue-peek.ts:198-237`, `606-619`.

**Сценарий:** исчез `current-user`, нет id/authKey, API вернул 403/500 или JSON
без `queues`; панель показывает общий текст «не удалось».

**Сейчас:** исключение логируется безопасно по Error.name, но missing attribute,
missing fields, non-OK и missing shape возвращают null без строки. Соседние
контрактные поломки неразличимы.

**Нужно:** `warn` с category: `credentials_attribute_missing`,
`credentials_shape`, `counts_http status=N`, `counts_shape`; authKey и response
body не писать. Один раз на запуск.

## Player Notes

### PN-1 — ВАЖНО: повторяющаяся DOM-ошибка вытесняет первопричину

**Код:** `src/content/features/player-notes.ts:634-671`, `2149-2166`,
`3156-3173`; `src/background/notes-coordinator.ts:43-70`; ring
`src/core/log.ts:64`, `278-282`.

**Сценарий:** устойчивый malformed record/DOM drift роняет каждый полный pass;
периодический reconciliation продолжает писать одинаковый `error`.

**Сейчас:** причина видна. Только reconciliation timer номинально даёт 0,5
вызова/с, то есть 1 800 строк/час и около 20 минут истории в ring. DOM/update
triggers могут дать больше, background throttling — меньше. Это не blind
silence, а loss of causal context.

**Нужно:** error latch:
`error: "обновление заметок/статистики упало"` один раз на непрерывный период,
с sanitized error category; после первого успешного pass
`info: "обновление заметок/статистики восстановлено"`. Явное сохранение кнопкой
или Ctrl/Cmd+Enter закрывать одной строкой на действие:
`info: "заметка сохранена"` только после storage success либо
`warn: "заметка не сохранена: category=read_only|storage; UI восстановлен"`.
Ник и текст заметки не писать.

**Чисто:** load failure уже оставляет core error плюс
`warn: notes load failed — saves blocked`; coordinator fallback и обычные
save/API failures имеют warn/error. Для UI всё равно нужен немедленный toast
«Данные не удалены; сохранение заблокировано», см. раздел feedback.

## Twitch Panel

### TW-1 — КРИТИЧНО: persisted lifecycle заканчивается на `connecting`

**Код:** `src/content/panels/twitch-panel.ts:813-909`.

**Сценарий:** чат не подключился или замер; пользовательский файл содержит
`connecting to channel`, но не показывает open, close, scheduled reconnect и
intentional disconnect.

**Сейчас:** open/close/reconnect — `debug`; только idle timeout, budget и errors
попадают в файл. `onerror` логирует Event object, который часто сериализуется в
`{}`. Невозможно отличить socket open, IRC reject, intentional stop и close.

**Нужно:** `info` на transport open, close `{code, intentional, attempt}` и
reconnect `{attempt/max, delay}`; error логировать как explicit type/readyState,
не object. Сейчас `reconnectAttempts` сбрасывается на каждый WebSocket open до
IRC readiness, поэтому transport flap не имеет доказанного верхнего предела и
поштучные info могут сами заполнить CAP. До исправления бюджета события нужно
агрегировать/throttle; bounded максимум допустим только после сброса attempts на
подтверждённой IRC readiness.

### TW-2 — ВАЖНО: строка «connected» не имеет IRC-level подтверждения

**Код:** `src/content/panels/twitch-panel.ts:867-881`, `937-953`.

**Сценарий:** WebSocket открылся, но JOIN отвергнут/канал недоступен; runtime/UI
ставят `isConnected=true` и обнуляют attempts до IRC `001/JOIN/366`.

**Сейчас:** support log не содержит даже transport-open, а parser игнорирует
JOIN success и rejection NOTICE/numerics. По логу нельзя доказать readiness.

**Нужно:** различить `transport_open`, `irc_registered` (`001`) и `irc_ready`
только после self `JOIN #channel` либо соответствующего `366`; registration
сам по себе JOIN не подтверждает. Persisted
`info: "Twitch IRC готов: channel=set"`; rejection — bounded normalized
`warn`, без raw IRC payload и имени канала.

## Role Faker

### RF-1 — ВАЖНО: явный хоткей ничего не сделал, но обе причины debug-only

**Код:** `src/content/features/role-faker.ts:57-69`, `195-226`.

**Сценарий:** зритель/судья нажимает F либо сайт пересобрал role block; своей
роли нет или внутри нет `use`/tooltip, визуального результата нет.

**Сейчас:** no role element и outer no-op — две `debug`-строки. Если контейнер
есть без изменяемых children, функция вообще возвращает success без outcome log.

**Нужно:** одна строка на пользовательскую попытку:
`info: "подмена роли не выполнена: own_role_missing"` либо
`warn: "подмена роли не применена: icon_and_label_missing"`; cooldown против
удерживания клавиши. Дополнительно короткий toast.

## Role Marker

### RM-1 — ВАЖНО: unresolved game key делает видимый ввод неперсистентным

**Код:** `src/content/features/role-marker.ts:99-155`, `196-203`.

**Сценарий:** до определения game ID/lineup пользователь выбирает роль; квадрат
меняется, но `persist()` молча выходит по `!gameKey`.

**Сейчас:** нет строки и UI-feedback; это неотличимо от сохранённой метки.

**Нужно:** edge-triggered `warn: "метка роли пока не сохранена: идентификатор
игры не определён"`; после появления key — `info: "ожидающие метки сохранены"`
либо честно не обещать persistence. Toast на первый blocked click.

### RM-2 — МЕЛОЧЬ: read-only и teardown write не привязаны к действию

**Код:** `src/content/features/role-marker.ts:103-145`, `296-348`, `364-369`.

**Сценарий:** load failed ставит `readOnly`, но marker остаётся кликабельным;
либо final direct set на disable/pagehide падает.

**Сейчас:** initial `load failed` и обычный save failure видны, поэтому
первопричина в целом диагностируема. Но конкретный пользовательский click в
read-only и unhandled teardown set не имеют outcome.

**Нужно:** один deduped `warn: "метка не сохранена: хранилище read-only"` и
toast; teardown set должен иметь catch с `error`, максимум один на teardown.

## Ответ пользователю

Где одного support log недостаточно и нужен честный UI:

1. Экспорт логов неполон — popup toast/banner до скачивания файла.
2. Player notes не загрузились — toast: «Данные не удалены; запись временно
   заблокирована» сразу, а не только после нажатия Save.
3. Role marker read-only/unresolved key/save failure — toast при первом клике;
   окрашенный квадрат сейчас выглядит как durable success.
4. Queue guard arm не подтверждён — toast при возвращении вкладки на экран;
   системное уведомление в этот момент ненадёжно по определению.
5. Role faker hotkey не применился — короткий cooldown-toast.
6. Ctrl/Cmd+Enter заметки не сохранил — тот же визуальный feedback, что кнопка.
7. OBS panel status: unknown phase, role visibility failure и ручной scene
   failure должны отображаться в панели; системные notification не нужны.
8. Twitch должен различать «WebSocket открыт», «IRC ready» и JOIN rejection в
   status панели.

Не нужны toast для stale queue alarm, штатного queue-peek safety refusal,
hover-statistics backoff и фонового OBS watchdog: там достаточно bounded log и
существующей панели.

## Типовая жалоба → достаточный trail

| Жалоба | Минимальные строки, которые должны быть в файле |
|---|---|
| «Автовозврат не работает» | readiness detected → countdown/bridge → terminal decision (`click`, `disabled`, `backoff`, `expired`) → `поиск возобновлён: секундомер подтверждён` (добавить в QR-1 success branch) |
| «Автопринятие не сработало» | auto-accept active → suppression state → candidate type → click attempt N либо terminal budget |
| «Стартовый экран не пропустило» | bounded attempt N/target → closed success либо unknown target/limit terminal (AS-2) |
| «Камера не выключилась» | camera identity один раз на lobby → off confirmed либо give-up; десять кликов поштучно не логируются (AS-2) |
| «Автосмена OBS перестала работать» | content session/route → automode config (`day/night set`) → phase confirmed/unknown → role hidden/shown outcome → scene target/same/owner → command accepted/rejected → scene confirmed |
| «OBS не подключается» | reconcile source → gate/manual/block → endpoint sanitized → handshake/close category → retry attempt result → durable block/budget terminal |
| «Не было предупреждения очереди» | alarm arm ack → disarm reason либо alarm fired → tab ping result → notification created/stale/skipped (QG-1/2) |
| «Разведка очереди не работает» | credentials/count category → существующий final success mode либо persisted terminal error; внутренний штатный retry не обязан быть в info |
| «Заметка пропала» | notes load/read-only → coordinator/fallback → operation result → UI rollback/commit; без текста заметки и ника |
| «Twitch-чат замер» | transport connect/open → IRC ready → last activity/idle timeout → close → reconnect result/budget |
| «Подмена/метка роли не работает» | explicit failure outcome (`target missing`, `game key unresolved`, `read-only`, `save failed`); normal success отдельно не логируется |

## Объём за час

### Сейчас

Предположение: одна часовая игра, одна content session, обычный Twitch/OBS,
connection diagnostics выключен, ошибок нет.

| Источник | Persisted строк/час |
|---|---:|
| boot + FeatureManager enables | 12–18 |
| auto-start / queue / requeue transitions | 3–10 |
| OBS 8–14 фазовых переходов | 24–45 |
| Twitch healthy transport | 1–3 |
| background OBS/ready | 2–8 |
| Итого healthy | примерно 40–76 на content и 2–8 на bg |

Это rough scenario estimate, а не измеренный trace: диапазон получен из
перечисленного числа boot/enables, 8–14 фазовых OBS transitions и единичных
queue/Twitch/background transitions. При healthy rate CAP 600 не достигается.
Риск появляется в failure/diagnostic
режиме:

- `connection-diag` пишет каждый probe event на `info`; для одного socket при
  ping/pong около раз в 25 с и доказанной двойной instrumentation получается
  оценка ~576 строк/час только от keepalive. Это не общий максимум: другие
  sockets/events и drift добавляются сверху, доказанной верхней границы нет.
- timer drift loop раз в 5 с — до 720 строк/час при постоянном throttling.
- `player-notes processExistingElements failed`: номинально 1 800 строк/час
  только от reconciliation timer раз в 2 с; DOM/update могут добавить больше,
  browser throttling — уменьшить. Timer-only ring хранит около 20 минут.
- global error capture ограничен одной строкой/с — CAP может заполниться за 10
  минут устойчивой ошибки.

Первым вытесняется именно полезное: boot, route, initial state и первая stack.

### После предлагаемой политики

- Нормальная игра: +15–35 edge-triggered outcome lines, итог примерно 55–111
  на content либо 57–119 суммарно; запас до CAP остаётся примерно пятикратным.
- Полный OBS outage: +до 10 retry results и 2–4 gate/block lines.
- Twitch outage: bounded оценки нет, пока transport open обнуляет attempts.
  После исправления бюджета нужен отдельный aggregation contract; например,
  первая flap-тройка `open/close/reconnect`, затем один summary на пять flaps и
  terminal budget. Без такого правила численный предел не заявляется.
- Unknown phase/DOM target: один warning на вход в состояние и один recovery;
  периодических повторов нет.
- Connection diagnostics: keepalive агрегировать одной info-строкой/минуту
  (`in/out count`, `max drift`), individual open/close/error оставить.
- Повторяющиеся DOM/errors: one error per continuous failure + one recovery.

После bounded budgets/edge latches проблемная сессия должна оставаться ниже CAP;
диапазон 150–250 строк/час — целевой rough budget, а не доказанное текущее число.

## Направления атаки

| Направление | Вердикт |
|---|---|
| 1. Молчаливые ранние выходы | **Находки:** terminal gates в requeue, auto-start, OBS, queue guard/peek, roles. Обычные route/idempotence/cache guards отделены и не требуют info. |
| 2. Латчи | **Находки:** `webcamGaveUp`, `armed`, `gameKey`, role visibility. Положительно: `gameStarted`, `roomExitDone` имеют часть transition logs; `autoPeekDone` — ожидаемый one-shot и не вынесен отдельной находкой. |
| 3. Персистентные блокировки | **Находки:** OBS manual/block/retry source и session bridge причины не экспортируются. Положительно: сам auth/protocol block и exhaustion уже `info`. |
| 4. Уровни | **Находки:** редкие решения остаются debug. **Чисто:** OBS phase polls, IRC frames, player fallback по никам и role retries должны остаться debug; поднимать их поштучно нельзя. |
| 5. Шум | **Находки:** connection diagnostics и повторяющиеся DOM/errors могут вытеснить causality. Healthy info volume безопасен. |
| 6. Опознаваемость | **Находки:** нет content session identity; OBS close/reconcile/retry и queue API null не имеют category/source/outcome. |
| 7. Секреты | **Находка:** sink-level redaction отсутствует; OBS URL/reason/scene names и Twitch channel динамические. **Чисто:** queue-peek не логирует authKey/body; Twitch raw PRIVMSG не persisted; connection diag применяет redact и caps. |
| 8. Ответ пользователю | **Находки:** log export health, read-only notes/marks, failed role hotkey, OBS operational status. Safety no-op без user action обычно не требует toast. |

## Проверено и чисто

- `bufferLevel=info` фиксирован и не управляется page `localStorage`; сайт не
  может включить persisted debug и собрать Twitch chat.
- Queue-requeue уже хорошо фиксирует readiness, countdown, game-start decision,
  bridge success, click attempts, modal stop и budget exhaustion.
- OBS panel в текущем дереве фиксирует monitor config, confirmed phase,
  unconfigured target, ownership rejection, switch attempt, confirmed scene и
  error; это закрывает основной happy/failure path автосцены, но scene names в
  этих строках требуют sanitization из LOG-3.
- OBS client фиксирует malformed frame, connect, close, heartbeat loss,
  reconnect schedule, budget exhaustion, auth/protocol block и persistence
  errors; проблема — категории/источник, а не полное отсутствие всех событий.
- Queue-peek показывает большинство safety refusals в собственной панели и не
  логирует authKey, raw credentials или response bodies.
- Player-notes блокирует запись после failed load, фиксирует read-only state,
  coordinator fallback и API/save errors; обычный save rollback виден в UI, но
  persisted success/rollback outcome нужно добавить по PN-1.
- Role-marker initial load failure и normal storage set rejection имеют error.
- Twitch не сохраняет raw chat: debug содержит только IRC command и frame
  length; persisted connecting-line всё ещё требует скрыть channel по LOG-3.
- Content boot логирует только origin+pathname, без query/fragment.
- Высокочастотные detector/poll/IRC frame/retry detail сообщения правильно
  остаются debug; повышать нужно terminal transition, а не весь поток.
