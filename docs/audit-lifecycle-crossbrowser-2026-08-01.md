# Аудит lifecycle и кроссбраузерности Polemica Notes — 01.08.2026

## Резюме

Проверен clean commit `4b5cd57`, версия `9.0.2`, Chrome MV3 service worker и
Firefox MV3 event page. Код не менялся.

- КРИТИЧНО: 1.
- ВАЖНО: 15.
- МЕЛОЧЬ: 3.
- Главный browser-specific риск: официальная документация Firefox 121 не даёт
  гарантии непрерывной жизни OBS WebSocket в non-persistent background page;
  поведение требует живого idle-теста.
- Главный Chrome lifecycle-риск: heartbeat назначен ровно на 30-секундную границу
  idle shutdown вместо документированного 20-секундного запаса.
- Главный риск данных: несколько вкладок всё ещё заменяют целиком один item
  `playerNotes`.
- После обычного обновления уже открытые игровые документы не получают новый
  content bundle и не имеют version-handshake/автовосстановления.

Живой browser experiment не выполнялся: доступный preview не содержит
установленного расширения. Находки опираются на код и официальные документы;
места, где документация не гарантирует точное поведение старого JS realm после
update, сформулированы узко.

## Источники платформы

- Chrome service worker lifecycle:
  <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Chrome WebSocket keepalive example:
  <https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets>
- Chrome alarms:
  <https://developer.chrome.com/docs/extensions/reference/api/alarms>
- Chrome storage:
  <https://developer.chrome.com/docs/extensions/reference/api/storage>
- Chrome tabs messaging:
  <https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage>
- Firefox background/event pages:
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts>
- Firefox manifest background:
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background>
- Firefox `storage.onChanged` divergence:
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/onChanged>
- Историческая применимость `storage.onChanged` divergence к Firefox 121:
  <https://bugzilla.mozilla.org/show_bug.cgi?id=1621162>
- Firefox alarms:
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms>
- Firefox content scripts:
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts>
- Firefox popup lifecycle:
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups>
- `pagehide` reliability:
  <https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event>

## Находки

### 1. ВАЖНО: для Firefox MV3 нет документированной гарантии непрерывной OBS-сессии

**Код:** `src/manifest/manifest.firefox.json:2-6`;
`src/background/obs-client.ts:30-48`, `206-232`, `352-368`;
`src/background/index.ts:370-371`.

```json
"background": { "scripts": ["background.js"] }
```

OBS полностью зависит от памяти event page:

```ts
private socket: WebSocket | null = null;
private pending = new Map<number, Pending>();
private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
```

**Документированный факт:** Firefox MV3 поддерживает только non-persistent
background pages. MDN говорит, что idle background scripts выгружаются, а DOM
timers “do not remain active after an event page has idled”. Message ports также
не предотвращают shutdown. Документация не уточняет, считает ли Firefox 121
страницу с открытым WebSocket и `GetVersion` раз в 30 секунд idle.

**Механизм риска:** если event page признаётся idle и выгружается, исчезают
socket, scene cache, pending requests, heartbeat/reconnect/request timers и
counters. Top-level restore при следующем WebExtension event создаёт новую
сессию, но не сохраняет непрерывность старой. Код не содержит отдельной
Firefox-стратегии или способа обнаружить такой разрыв до следующего события.

**Сценарий:**

1. В Firefox 121 подключить OBS и закрыть popup.
2. Не менять сцены и не вызывать другие extension events дольше idle window.
3. Проверить в browser toolbox, сохраняет ли WebSocket event page живой.
4. Если page выгружается, следующий alarm/message поднимет новый page и новое
   OBS-соединение; до реконнекта `set_scene` не выполнится.

**Фикс:** сначала обязательный Firefox 121 idle test. Если unload
воспроизводится, честно считать Firefox OBS reconnect-on-event либо вынести
непрерывное соединение в поддерживаемый persistent механизм/companion. Таймеры,
которым нужен гарантированный wakeup после unload, заменить alarms.

**Инварианты:** §4.6, §4.7, §4.10.

### 2. КРИТИЧНО: две вкладки молча теряют несвязанные заметки

**Код:** `src/core/notes-store.ts:324-331`;
`src/content/features/player-notes.ts:535-550`, `623-629`, `2056-2110`,
`2209-2243`, `2341-2395`;
`src/popup/index.ts:584-623`.

```ts
await browser.storage.local.set({ [NOTES_KEY]: notes, version: NOTES_VERSION });
```

`notesWriteQueue` существует только внутри одного `PlayerNotesManager`; popup и
каждая вкладка имеют собственный snapshot и очередь.

**Документированный факт:** `StorageArea.set()` обновляет значение item. Вся
карта — один item `playerNotes`; WebExtensions storage не предоставляет здесь
compare-and-swap или транзакцию между контекстами.

**Механизм:** A и B читают N, строят N+Alice и N+Bob, оба `set()` успешны.
Последняя whole-item запись оставляет только одно изменение.

**Сценарий:**

1. Открыть две игровые вкладки.
2. В каждой открыть и изменить заметку другого игрока.
3. Сохранить почти одновременно до доставки `storage.onChanged`.
4. Обе вкладки покажут успех.
5. После reload одна заметка отсутствует.

Тот же класс гонки есть между content edit, lazy nick→ID migration и popup
import.

**Фикс:** background coordinator с delta-операциями и durable revision либо
шардирование заметок по независимым keys. Простой свежий `get→merge→set` лишь
сужает окно.

**Инварианты:** §4.3, §4.11.

### 3. ВАЖНО: открытые вкладки не получают новый content bundle после update

**Код:** `src/manifest/manifest.base.json:32-44`;
`src/content/index.ts:31-48`, `117-130`;
`src/background/index.ts:321-325`.

Content script и CSS declarative, `run_at: document_end`. `onInstalled` делает
только migrations, OBS restore и alarm cleanup. Нет:

- version handshake content↔background;
- reinjection;
- уведомления “reload required”;
- `FeatureManager.stop()`/общего synchronous teardown;
- новой document navigation по update.

**Документированный факт:** manifest content scripts загружаются, когда browser
загружает matching page/document. `onInstalled` запускает новый extension
lifecycle, но документация не обещает retroactive injection в уже загруженный
document.

**Механизм:** background обновлён, а открытая игра не исполняет новый
`content.js` до reload/navigation. Старые inline DOM changes не имеют
repository-level cleanup. Точная продолжительность старых callback realms
различается по browser/update path и не утверждается; отсутствие нового bundle
и recovery protocol доказано.

**Сценарий:**

1. Оставить игру открытой во время store/XPI update.
2. Browser устанавливает новый background и вызывает `onInstalled`.
3. Открытый document не исполняет новый content entry.
4. Новые фиксы/миграции поведения отсутствуют до reload; messaging к content
   может не иметь receiver.

**Фикс:** version handshake на popup/background interaction и явный banner с
reload текущего tab; при необходимости programmatic reinjection с instance
guard. Централизованный teardown полезен для обычного lifecycle текущего
поколения, но не считается способом вызвать уже инвалидированный старый realm.

**Инварианты:** §4.7.

### 4. ВАЖНО: Chrome heartbeat стоит ровно на границе idle shutdown

**Код:** `src/background/obs-client.ts:41-44`, `224-232`.

```ts
private readonly heartbeatInterval = 30_000;
this.heartbeatTimer = setInterval(() => void this.verifyConnection(), 30_000);
```

**Документированный факт:** Chrome обычно завершает SW после 30 секунд
inactivity. В Chrome 116 WebSocket продлевает жизнь только если messages
отправляются/принимаются “within the 30s ... activity window”. Официальный
пример отправляет keepalive каждые 20 секунд.

**Механизм:** callback на 30000 ms конкурирует с termination и timer jitter.
При спокойном OBS нет входящих событий; worker может умереть до `GetVersion`.

**Сценарий:** подключить OBS в Chrome 116, оставить без events, добавить CPU
pressure около первого tick. Worker может завершиться, watchdog восстановит
соединение лишь позже, создав заметный разрыв.

**Фикс:** heartbeat ≤20 секунд и send независимо от недавнего passive event;
проверить termination через официальный Puppeteer lifecycle test.

**Инварианты:** §4.6, §4.10.

### 5. ВАЖНО: Firefox unchanged-key events отменяют ручной OBS disconnect

**Код:** `src/core/settings.ts:133-143`;
`src/background/index.ts:330-366`.

```ts
for (const [k, c] of Object.entries(changes)) {
  if (k in DEFAULT_SETTINGS) patch[k] = c.newValue;
}
```

```ts
if (patch.obs_enabled === true || patch.extension_enabled === true) {
  await setManualDisconnect(false);
}
if ("obs_host" in patch || "obs_password" in patch) {
  await setManualDisconnect(false);
}
```

**Документированный факт:** MDN отдельно предупреждает: Firefox listener
получает все keys storage area после `set()` и может быть вызван, когда data не
изменилась.

**Механизм:** наличие unchanged key принимается за намеренное включение или
редактирование credentials.

**Сценарий:**

1. В Firefox нажать OBS “Отключиться”; local flag становится true.
2. Сохранить любую несвязанную sync-настройку.
3. Event может содержать unchanged `obs_enabled:true`.
4. Background очищает manual flag и подключается.

Любой unrelated local `set` может аналогично принести unchanged
`obs_password`.

**Фикс:** включать key в patch только если `oldValue !== newValue`; deletion
нормализовать к default. OBS intent менять только по реальному изменению.

**Инварианты:** §4.6, §4.12.

### 6. ВАЖНО: несколько игровых вкладок борются за одну OBS scene

**Код:** `src/content/panels/obs-panel.ts:202-218`, `705-830`, `916-953`;
`src/background/index.ts:111-124`.

Каждая вкладка независимо определяет phase и отправляет `set_scene`. Background
имеет один `ObsClient`, а lightweight `set_scene` намеренно не сериализован с
общей OBS queue.

**Документированный факт:** OBS WebSocket `SetCurrentProgramScene` меняет одну
current program scene; событие `CurrentProgramSceneChanged` сообщает общую
сцену, не сцену per browser tab.

**Сценарий:** открыть game A днём и game B ночью. Стабильные polling cycles не
шлют команды повторно благодаря `currentTimeOfDay`, но инициализация второй
вкладки или последующая смена фазы фоновой игры может переключить общую сцену
поверх активного stream.

**Фикс:** один persisted OBS automode owner per profile. Команда должна нести
tab/document/game identity и phase epoch; background отклоняет non-owner/stale
commands.

**Инварианты:** §4.6, §4.7, §4.10.

### 7. ВАЖНО: выключение OBS automode не восстанавливает inline-видимость роли

**Код:** `src/content/panels/obs-panel.ts:215-218`, `382-425`, `958-983`,
`1046-1073`.

OBS сохраняет original style в `WeakMap`, затем пишет visibility/opacity с
`!important`. При выключении automode вызывается только `stopDOMMonitoring()`;
disable очищает runtime variables, но не итерирует modified nodes и не
восстанавливает style.

**Документированный факт:** `CSSStyleDeclaration.setProperty()` создаёт или
изменяет inline property; удаление WeakMap/reference само CSS не откатывает.

**Сценарий:** automode скрывает role в day, пользователь выключает automode или
master extension. Monitoring остановлен, но role остаётся скрытой до site
rerender/reload. Если automode выключен после ночного показа, его inline
`!important visible/opacity` также остаётся и может конфликтовать с auto-hide.

**Фикс:** iterable registry exact original value+priority; restore при automode
off, feature disable, route exit и owner loss. Лучше один shared role-visibility
controller с auto-start.

**Инварианты:** §4.1, §4.7.

### 8. ВАЖНО: roleMarks после read failure могут уничтожить всю историю

**Код:** `src/content/features/role-marker.ts:97-113`, `246-254`, `285-313`.

Load error превращается в writable `{}`. Следующий marker edit записывает
whole-store snapshot. Все writes fire-and-forget без rejection handling.

**Документированный факт:** `StorageArea.set()` Promise отклоняется при ошибке;
необработанный Promise не подтверждает durability.

**Сценарий:** transient read failure → UI начинает с пустой карты → пользователь
ставит marker → successful whole-map set заменяет всю доступную историю, до 50
ключей. При quota
failure marker остаётся визуально, но исчезает после reload.

**Фикс:** read-only gate как у notes; await writes, показывать failure, не
обновлять durable-state UI до commit. Шардировать games/operations.

**Инварианты:** §4.3, §4.11.

### 9. ПРОДУКТОВЫЙ РИСК, НЕ ДЕФЕКТ: operational settings синхронизируются между devices

**Код:** `src/core/settings.ts:80-123`.

Только `obs_password` local. Через sync распространяются:

- `auto_accept_enabled`;
- `queue_peek_auto`;
- `requeue_after_lobby_fail_enabled`;
- `obs_enabled`, `obs_auto_mode_enabled`;
- `twitch_chat_enabled`.

**Документированный факт:** `storage.sync` делает data доступной в browser
instances пользователя на других devices.

**Сценарий:** включить auto-action/OBS на машине A. Sync переносит значение на B
с другой site session и другим localhost; password при этом не sync. Для
`auto_accept_enabled` это также совпадает с текущим default `true`, поэтому сам
факт активности на B нельзя приписывать только синхронизации.

Текущая реализация соответствует явно зафиксированной карте storage в AGENTS
§5; требования device-local consent нет. Если владелец решит изменить продуктовый
контракт, execution/connection toggles следует перенести в local с migration.

Эта запись не входит в severity counts и не объявляется нарушением §4.

### 10. ВАЖНО: swallowed `tabs.sendMessage` превращается в ложный успех popup

**Код:** `src/core/messaging.ts:22-27`;
`src/popup/index.ts:380-390`, `1099-1111`, `1183-1190`, `1212-1230`.

```ts
try { return await browser.tabs.sendMessage(tabId, msg); }
catch { return undefined; }
```

Caller ожидает exception, но wrapper всегда возвращает `undefined`, после чего
`sendMessageToContentScript()` возвращает `true`.

**Документированный факт:** Chrome `tabs.sendMessage()` rejects, если ошибка
возникла при connecting к tab.

**Сценарий:** после update/open-before-install в tab нет current receiver.
“Цвета ников” закрывает popup, ничего не открыв; panel controls считаются
отправленными. Twitch узнаёт проблему лишь через отдельные 5 секунд.

**Фикс:** strict/non-swallowing send variant для command paths и explicit ack
от receiver; broadcast best-effort оставить отдельным API.

**Инварианты:** §4.7.

### 11. ВАЖНО: startup/install cleanup может удалить свежий queue alarm

**Код:** `src/background/index.ts:177-183`, `240-251`, `308-325`;
`src/content/features/queue-guard.ts:52-59`, `114-115`.

`clearStaleQueueGuards()` удаляет все matching alarm names, не проверяя tab.
Она стартует fire-and-forget на startup/install параллельно с restored hidden
tab, которая может уже вызвать `armQueueGuard()`.

**Документированный факт:** alarm create/clear асинхронны; Chrome рекомендует
проверять важные alarms на каждом worker start, потому что persistence до
Chrome 150 непредсказуема. Firefox alarms вообще не переживают browser session.

**Сценарий возможного interleaving:** restored hidden search tab создаёт fresh
alarm → startup cleanup видит и удаляет его → content сохраняет `armed=true` и
больше не arm → warning не приходит. Конкретный порядок session restore и
`onStartup` требует browser-теста, сама несериализованная race доказана кодом.

**Фикс:** сериализовать startup cleanup/arm либо перед clear ping tab и удалять
только действительно stale alarm. После cleanup content должен подтвердить
существование alarm/получить ack.

**Инварианты:** §4.10.

### 12. ВАЖНО: 15-секундный cutoff отбрасывает полезные delayed alarms

**Код:** `src/background/index.ts:294-306`.

```ts
if (Date.now() - alarm.scheduledTime > 15_000) return;
```

**Документированный факт:** Chrome alarm “may have been delayed an arbitrary
amount beyond” scheduledTime.

**Сценарий:** busy machine задерживает минутный alarm на 16-25 секунд, очередь
ещё жива и warning ещё полезен, но background отбрасывает его до authoritative
`queueGuardPing`. Content уже держит `armed=true`, поэтому после очистки
одноразового alarm не создаст новый до отдельного disarm/rearm-события.

**Фикс:** сначала спрашивать tab; отличать multi-hour sleep через page-side
queue age/visibility timestamp, а не arbitrary lateness alone.

**Инварианты:** §4.10.

### 13. ВАЖНО: OBS retry policy не переживает incarnation и update

**Код:** `src/background/obs-client.ts:38-40`, `115-121`, `206-221`,
`446-452`; `src/background/index.ts:76-83`, `308-325`, `370-371`.

Две связанные ошибки:

- `reconnectAttempts` только memory: новый SW/event-page снова получает 10
  попыток, поэтому lifetime cap фактически бесконечен;
- persisted block 4008-4011 сбрасывается onStartup/settings/manual Connect, но
  не onInstalled. Compatibility fix новой версии может остаться заблокирован
  до перезапуска browser.

**Документированный факт:** Chrome globals теряются при SW shutdown; Firefox
event-page values также не persistent. `onInstalled` предоставляет reason и
previousVersion отдельно от onStartup.

**Сценарий:** unavailable OBS → 10 retries → worker restart → ещё 10. Обратный
сценарий: старая версия ставит 4010 block → update чинит protocol → onInstalled
honors старый block и не тестирует исправление.

**Фикс:** durable retry epoch/backoff; update-specific controlled probe прежде
всего для 4010/4011. Текущий единый boolean не позволяет отличить их от auth
4008/4009; bad-password block нельзя сбрасывать без credential/user change.

**Инварианты:** §4.6, §4.10.

### 14. ВАЖНО: popup может умереть между OBS command и сохранением intent

**Код:** `src/popup/index.ts:1258-1268`, `1271-1297`, `1301-1310`;
`src/background/index.ts:86-104`.

Disable сначала await disconnect, затем `saveSettings()`. Connect сначала ждёт
до 10 секунд command/status, затем сохраняет host/password/settings.

**Документированный факт:** popup document unloads каждый раз при закрытии.

**Сценарий disable:** снять checkbox и закрыть popup во время await. Background
уже поставил manual-disconnect, но `obs_enabled=false` мог не сохраниться.

**Сценарий connect:** изменить credentials, Connect, закрыть popup. Background
подключился с command data, но storage может остаться старым; следующий
reconcile заменит connection.

**Фикс:** persist intent до long operation либо одна transactional command в
background: background сохраняет settings/flags, затем reconcile.

**Инварианты:** §4.4, §4.6.

### 15. ВАЖНО: legacy Twitch migration перезаписывает современный synced false

**Код:** `src/background/index.ts:271-279`.

```ts
if (!localMigrationFlag) {
  await storage.sync.set({ twitch_floating_panel_enabled: true });
  await storage.local.set({ localMigrationFlag: true });
}
```

**Документированный факт:** sync value доступно на других devices, а local flag
per-device.

**Сценарий:** A намеренно sync-ит false. Новая установка B не имеет local flag,
пишет true в sync и возвращает panel на A. Между двумя writes нет atomicity;
после interruption overwrite повторится.

**Фикс:** migration должна различать historical version/provenance, не local
absence. Не перезаписывать существующий explicit sync value.

**Инварианты:** §4.11, §4.12.

### 16. ВАЖНО: queue guard и connection diagnostics зависят от initial route

**Код:** `src/content/features/queue-guard.ts:35-37`, `61-66`;
`src/content/features/connection-diag.ts:32-34`, `49-54`;
`src/content/index.ts:50-106`.

Обе фичи в `enable()` делают return вне `/game-search`. FeatureManager всё
равно помечает их active. Central URL router route-sync делает только для
player-notes/match-stats.

**Документированный факт:** manifest content script загружается при document
load; SPA URL change не создаёт новый document и не перезапускает `enable()`.

**Сценарий:** загрузить `/profile`, SPA перейти `/game-search`, начать поиск и
скрыть tab. Guard/diag не установлены до reload или lifecycle toggle.

**Фикс:** enable устанавливает cheap route support всегда; enter/leave search
resources управляются central URL reconcile с symmetric cleanup.

**Инварианты:** §4.7.

### 17. ВАЖНО: backup import частичен, а roleMarks не восстанавливаются

**Код:** `src/popup/index.ts:399-432`, `521-570`, `572-629`;
`src/static/popup.html:450-457`;
`src/content/features/role-marker.ts:34-42`.

Две lifecycle-проблемы одного recovery contract:

- notes/settings/extras применяются отдельными calls без общей транзакции;
  extras failure log-only, а success UI ориентирован на notes;
- `roleMarks` — persistent user input с историей до 50 ключей — отсутствует в
  export/import, хотя popup обещает, что импорт «вернёт всё как было».

**Документированный факт:** separate `StorageArea.set()` Promises не образуют
transaction across local/sync. `storage.local` очищается при uninstall.

**Сценарий:** import при quota даёт notes restored, settings/extras partial;
либо reinstall/import возвращает notes/tags/mutes, но не role reads.

**Фикс:** versioned complete backup schema, preflight quota/validation,
recovery snapshot и итог по каждому component. Включить roleMarks либо честно
исключить их из обещания “всё как было”.

**Инварианты:** §4.3, §4.11.

### 18. МЕЛОЧЬ: удаление setting key применяет `undefined`, а не default

**Код:** `src/core/settings.ts:133-143`; `src/core/feature.ts:45-53`, `66-71`.

`StorageChange.newValue` optional. При remove patch содержит `key: undefined`,
который затирает runtime settings. Default-on feature может выключиться до
reload, где `getSettings()` снова подставит default.

**Фикс:** при `newValue === undefined` использовать `DEFAULT_SETTINGS[key]`;
совместить с old/new equality filter из находки 5.

**Инварианты:** §4.12.

### 19. МЕЛОЧЬ: final role/log tail полагается на ненадёжный `pagehide`

**Код:** `src/content/features/role-marker.ts:97-106`, `285-313`;
`src/core/log.ts:215-220`, `236-267`, `293-301`.

**Документированный факт:** MDN: `pagehide` “is not reliably fired by
browsers”. Кроме того, handler запускает unawaited async writes.

**Сценарий:** закрыть process/tab в последние 400 ms после marker или ~3 s
после log entry. Теряется только unsaved tail, не вся база.

**Фикс:** user-data marker писать при mutation/через coordinator; unload flush
оставить best-effort. Для logs потеря хвоста допустима, но должна быть
задокументирована.

**Инварианты:** §4.7.

### 20. МЕЛОЧЬ: комментарий alarms неверен для Chrome 116

**Код:** `src/background/index.ts:20`.

```ts
// Минимум chrome.alarms — 0.5 минуты
```

**Документированный факт:** 30-second minimum появился в Chrome 120. На
поддерживаемом Chrome 116 minimum был 1 minute.

Runtime bug сейчас нет: оба alarms используют 1 minute. Риск — будущий
maintainer поставит 0.5, полагаясь на комментарий.

**Фикс:** исправить comment и добавить compatibility test/assert на floor 116.

## Что теряется при выгрузке background

### Chrome service worker

| Состояние | После unload | Восстановление |
|---|---|---|
| `ObsClient.socket`, `isConnected`, `sessionId` | Теряется, socket закрывается | Top-level restore + watchdog |
| Scene cache/current scene | Теряется | Новый GetSceneList после connect |
| Pending OBS requests | Теряются вместе с sender channel | Response channel/result не гарантированы; operation lost |
| Heartbeat/reconnect/connection/request timers | Теряются | Частично новый connect; exact retry state не восстановлен |
| `reconnectAttempts` | Обнуляется | Никак, находка 13 |
| `obsQueue` | Обнуляется | Новая per-incarnation queue |
| `obs_manual_disconnect` | Сохраняется local | Читается reconcile |
| `obs_retry_blocked` | Сохраняется local | Читается reconcile |
| OBS connection snapshot | Сохраняется local, может быть stale | Перезаписывается новым socket event/probe |
| OBS watchdog alarm | Browser-managed, persistence до Chrome 150 не гарантирована | Boot reconcile проверяет/создаёт |
| Queue guard tab identity | В alarm name | Не зависит от module global |

Chrome официально требует не полагаться на globals и готовиться к unexpected
termination. Текущий durable manual/block state — правильный подход; retry
budget и ownership им не следуют.

### Firefox event page

При фактическом idle unload теряется тот же memory state; timers не wake event
page, alarm не переживает browser session. Официальная документация не даёт для
Firefox 121 эквивалента Chrome-гарантии WebSocket traffic, но и не доказывает,
что текущий heartbeat обязательно допускает unload. Нужен живой idle-тест.

## Что происходит на живых вкладках при обновлении

1. Browser устанавливает новый extension background и вызывает `onInstalled`.
2. Migrations/OBS restore/alarm cleanup запускаются fire-and-forget.
3. Existing game document не получает declarative content bundle нового
   поколения задним числом.
4. Repository не содержит version handshake, reinjection или reload banner.
5. Popup commands к отсутствующему receiver могут ошибочно считаться успешными
   из-за `sendToTab`.
6. Реальный navigation/reload создаёт новый document и загружает current
   `content.js`/`notes.css`; это единственный гарантированный recovery path.

Официальные docs не гарантируют одинаковую судьбу старых JS callbacks во всех
Chrome Store, unpacked reload и Firefox XPI update paths. Поэтому отчёт не
утверждает, что старые автоклики обязательно продолжат работать; он утверждает
доказанное отсутствие нового code/teardown/recovery.

Данные same-ID update обычно переживают update: storage не удаляется. Опасные
границы из AGENTS §2б — uninstall/reinstall temporary Firefox add-on и смена
extension ID/path, а не обычный signed/store update.

## Различия Chrome и Firefox

| Область | Chrome 116 | Firefox 121 | Вывод |
|---|---|---|---|
| Background | MV3 service worker | MV3 non-persistent event page | Разные lifecycle guarantees |
| WebSocket lifetime | Traffic within 30s resets idle | Эквивалентная гарантия не документирована; idle page unloads | Требуется Firefox 121 test |
| Timers background | Живут лишь пока SW alive | Не переживают event-page idle | Alarms для wakeup |
| Alarm minimum | 1 min at 116; 0.5 only 120+ | API доступно | Current 1 min clean |
| Alarm session persistence | Historical behavior unpredictable; recreate on boot | Не переживают browser session | Нельзя считать existence durable truth |
| `storage.onChanged` | Changed keys | Firefox may include all area keys/no-op events; применимость к 121 подтверждает Bug 1621162 | Нужен old/new filter |
| Promise `onMessage` | Native 116 caveat закрыт polyfill | Native Promise support | Current wrapper clean |
| `requestUpdateCheck` | Поддерживается и feature-tested | Unsupported, guarded | Clean |
| `:has()` | 105+ | ровно 121 | Floors корректны |
| `scrollbar-width` | Только 121+, но есть WebKit fallback | 64+ | Chrome 116 clean via fallback |
| `AbortSignal.timeout` | Доступен; error name отличается до 124 | Доступен | Код не проверяет name, clean |

### API minimum matrix

В проверенных usage sites на заявленных floors доступны и корректно защищены:

- `crypto.randomUUID`, `crypto.subtle.digest`;
- `CSS.escape`, `WeakRef`, `queueMicrotask`;
- `AbortController`, `AbortSignal.timeout`;
- alarms, notifications, storage, tabs, windows;
- Promise-based wrappers через `webextension-polyfill` 0.12.

В проверенных usage sites unsupported JS/CSS без fallback не найдено; это не
полная compatibility-матрица каждого API расширения.

## Множественность контекстов

- Background/OBS один на browser profile, content state — per tab.
- Popup создаётся заново при каждом открытии и не является durable
  transaction coordinator.
- Notes, roleMarks, palette и mutes используют whole-value/RMW patterns;
  `storage.onChanged` сокращает, но не закрывает race window.
- Две OBS game tabs не имеют owner election.
- Разные browser profiles вообще не делят extension storage/background;
  coordinator между ними невозможен. Sync распространяет configuration, но не
  mutual exclusion.

Гипотеза о взаимном повреждении account queue двумя search tabs не включена как
находка: серверная семантика concurrent same-account sessions не доказана
`docs/site-api.md` или fixture.

## Топ-3

1. **Укрепить OBS lifecycle:** 20-second Chrome keepalive, живой Firefox 121
   idle-test и выбранная по его результату strategy, durable retry policy и
   один automode owner.
2. **Убрать whole-item data races:** notes и roleMarks через delta/coordinator
   или sharded keys; read failure только read-only.
3. **Добавить update handoff:** content/background version handshake, truthful
   missing-receiver errors и явный reload/reinject recovery для live tabs.

## Проверено и чисто

- Все background event listeners зарегистрированы synchronously top-level.
- Promise operations возвращаются из `onMessage`; polyfill держит Chrome 116
  response channel, Firefox принимает Promise нативно.
- OBS replacement отвязывает все четыре handlers старого socket до close.
- В одной живой incarnation OBS connect/reconcile сериализуются и duplicate
  socket leak не найден.
- Connection и OBS request Promises имеют 10-second timeout в живом context.
- Manual disconnect и terminal retry block persisted в local, не globals.
- Queue guard tab ID закодирован в alarm/notification name.
- Alarm fire с lateness ≤15 секунд повторно спрашивает authoritative
  hidden/searching у tab; более поздний alarm ошибочно отбрасывается до ping
  (находка 12). Closed или navigated tab fail-closed на прошедшем cutoff пути.
- Notification click активирует tab и затем фокусирует его window; failure
  закрытого tab catch-ится.
- Notes живут в `storage.local`, а не quota-ограниченном 8 KB sync item.
- Failed notes load ставит `loadFailed` и блокирует overwrite unread storage.
- Notes migration пишет data+flag одним local `set` и не удаляет frozen sync
  bridge.
- Popup normal settings path пишет diff и слушает external changes.
- `obs_password` local-only; legacy sync password удаляется migration.
- Logs bounded: 600 entries/context, content-session cleanup и cap keys.
- Chrome/Firefox manifest overlays не смешивают `service_worker` и `scripts`.
- Build IIFE/classic compatible с обоими background forms.
- Same-version values package/manifest совпадают; release script отдельно
  блокирует divergence.
- Обычный same-ID store/signed update не имеет code path, удаляющий notes,
  palette, mutes или roleMarks.
