# Аудит безопасности и приватности Polemica Notes — 26.08.2026

Проверен HEAD `3d548f6`, manifest `9.41.0`. Production-код не менялся.
Проведены шесть независимых статических срезов и ручная перепроверка спорных
цепочек. Baseline: `docs/audit-security-2026-08-01.md`, версия `9.0.0`.

Живая игровая сессия не использовалась: подтверждённые сценарии относятся к
extension storage, импорту, экспортам, runtime IPC и release tooling и не
зависят от текущей разметки сайта.

## Модель угроз

- Сайт и его API, Twitch, OBS/WebSocket и присланный backup считаются
  недоверенными источниками данных.
- `storage.local` расширения недоступен обычному JS сайта; `localStorage` и
  `sessionStorage` страницы полностью принадлежат сайту.
- Content script работает в isolated world. В текущем коде не найден мост
  `page world -> browser.runtime`, `externally_connectable` и
  `onMessageExternal` отсутствуют.
- Popup, background и content scripts — части одного расширения. Компрометация
  исполняемого кода content script уже даёт ему extension API, включая storage,
  поэтому отсутствие sender ACL между собственными контекстами не оценивалось
  как самостоятельная High-уязвимость без достижимого входа со страницы.
- Файл покидает компьютер только после явного клика пользователя. Автоматической
  загрузки backup/log/WS-log на внешний сервер не найдено.

## Итог

- Critical: 0.
- High: 4.
- Medium: 6.
- Low: 4.
- Отдельно: 3 пробела исполняемости release-гарантий и 7 hardening-наблюдений.
- Исполняемой HTML/SVG/CSS-инъекции через сайт, Twitch, OBS, заметки или backup
  не найдено.
- Главный privacy-риск: backup может раскрыть credentials из `obs_host` и без
  consent подготовить сбор полного WebSocket-трафика после reload/навигации.
- Главный риск данным: фактический объём WS-log не ограничен заявленными 2 млн
  символов и способен занять общую с заметками квоту.
- Главный незакрытый baseline-риск: sync-миграция всё ещё может перезаписать
  свежую local-карту устаревшим снимком.

## Локальные подтверждения

Для 200 000 коротких кадров вида
`{t: 1800000000000+i, d: "in", m: "42[\"x\",{}]"}` получено:

```text
учёт chunkChars:     2 000 000
JSON.stringify:      9 600 031
отношение:                 4.8x
```

Выборочный набор по затронутым контурам:

```text
npm test -- --run tests/unit/ws-log.test.ts tests/unit/log.test.ts \
  tests/unit/notes-coordinator.test.ts tests/unit/import-fallback.test.ts \
  tests/unit/obs-record-clip.test.ts

Test Files  5 passed
Tests      79 passed
```

## Находки

### SEC26-1 — High: credentials внутри `obs_host` уходят в sync и backup

**Файлы:** `src/popup/index.ts:608-634`, `src/core/settings.ts:126-166`,
`143-185`; `src/shared/safe-endpoint.ts:1-14`.

Экспорт исключает отдельный `obs_password`, но кладёт в JSON сырой
`safeSettings.obs_host`. Поддерживаемый OBS URL может содержать userinfo и
query-token:

```text
ws://admin:hunter2@localhost:4455/?token=SECRET
```

Оба секрета и имя пользователя попадут в backup. Кроме того, `obs_host` не входит
в `LOCAL_KEYS`: в отличие от отдельного `obs_password`, он автоматически пишется
в browser `storage.sync`. Значит credentials могут уйти в Chrome/Firefox Sync
сразу при сохранении настройки, без экспорта файла. Runtime OBS connection при
этом ограничен CSP адресами localhost; non-local подключение не заявляется.

Backup-ветка особенно опасна из-за явного комментария и UI-обещания, что пароль
OBS в файл не входит: пользователь обоснованно считает файл безопаснее, чем он
есть, и может отправить его в поддержку или мессенджер.

`safeEndpoint()` уже задаёт нужную политику для диагностического файла, но для
backup его использовать напрямую нельзя без продуктового решения: backup после
очистки перестанет восстанавливать полный endpoint. Минимум нужен явный запрет
credentials в `obs_host` либо отдельная классификация/подтверждение экспорта.

### SEC26-2 — Medium: импорт без consent подготавливает полный WebSocket-log

**Файлы:** `src/popup/index.ts:52-77`, `691-731`, `807-815`, `932-934`;
`src/core/settings.ts:114-117`; `src/content/index.ts:182-212`;
`src/core/ws-log.ts:20-22`.

`ws_full_log_enabled` — валидная boolean-настройка и импортируется, но отсутствует
в `OPERATIONAL_KEYS`. Поэтому следующий присланный файл не показывает consent:

```json
{
  "app": "polemica-notes",
  "type": "notes-backup",
  "notes": {},
  "settings": { "ws_full_log_enabled": true }
}
```

После `setSettings()` FeatureManager видит `storage.onChanged`, а content script
зеркалирует флаг в page-owned `localStorage`. Сам ранний page probe ставится
только в `document_start`, поэтому в обычном default-off сценарии сбор ролей,
ночных действий, целей и чата начнётся после следующего reload/перехода, а не
немедленно в уже открытом документе. Файл не загружается автоматически, но
нарушена принципиальная граница «выключено по умолчанию, включает человек
осознанно» из комментария самой фичи.

Сценарий требует user-assisted импорта чужого файла, но включение чувствительного
сбора происходит без отдельного предупреждения.

### SEC26-3 — High: лимит WS-log считает тело, а не фактический storage-size

**Файлы:** `src/core/ws-log.ts:47-61`, `98-115`, `224-280`, `325-377`;
`tests/unit/ws-log.test.ts:126-178`.

`chunkChars()` и все три бюджета считают только `frame.m.length`. Не входят:

- timestamp `t` и direction `d` каждого кадра;
- JSON-структура каждого объекта и массива;
- metadata куска и storage key;
- сериализационные накладные расходы браузера.

Для коротких кадров ручной детерминированный расчёт дал 4.8x между учётом и
JSON-представлением. В Chrome, где quota accounting для `storage.local` близок к
размеру JSON плюс keys, «2 млн» может приблизиться к лимиту 10 MiB ещё без
остальных данных расширения. Firefox использует отличающуюся реализацию quota,
поэтому точный коэффициент расхода там не заявляется, но неучтённые поля и
metadata всё равно делают production budget неверной оценкой. Квота общая с
`playerNotes`: существующие заметки не удаляются, но последующие whole-map
сохранения могут начать отклоняться.

Текущие тесты воспроизводят production-ошибку, суммируя только `m.length`, и не
проверяют сериализованный размер.

### SEC26-4 — High: завершённые поколения текущего документа не входят в sweep

**Файлы:** `src/core/ws-log.ts:102-115`, `161-168`, `263-316`, `345-377`;
`src/content/features/ws-log.ts:54-90`.

Ключ имеет форму:

```text
polemica:wslog:<SESSION_ID>:<generation>-<seq>
```

Но `sweepStorage()` исключает весь prefix текущего `SESSION_ID`, а не только
активное generation. `finishSession()` затем увеличивает generation и обнуляет
`chunks`, `storedChars`, `foreignChars` и `seq`, не удаляя прошлое поколение.

После выключения и повторного включения в той же вкладке прошлое поколение:

- остаётся на диске;
- не считается foreign;
- не участвует в sweep;
- не входит в новый лимит 2 млн;
- не входит в новый лимит 100 ключей.

Повторное переключение настройки накапливает поколения до реального отказа
storage. Дополнительно `disable()` запускает `void finishSession()`: быстрое
повторное enable может пересечься с асинхронным reset старой сессии и потерять
начало нового лога.

### SEC26-5 — High: sync→local миграция всё ещё может стереть свежую правку

**Файлы:** `src/core/notes-store.ts:440-497`, `500-518`.

Baseline №2 закрыт не полностью. Возможна последовательность:

1. Контекст A читает local-карту `L0`, migration flag ещё false.
2. A ждёт `storage.sync.get()`.
3. Контекст B через координатор сохраняет `L1`.
4. A строит `mergeNotes(L0, bridge, { onlyNew:true })`.
5. A одним `storage.local.set()` пишет устаревшую карту и migration flag.

`onlyNew` защищает существующие ключи в снимке A от старого sync-моста, но не
может сохранить ключ или изменение, появившееся после чтения `L0`. Миграцию
может одновременно начать любой контекст через `loadNotes()`; background-
координатор этот writer не сериализует.

Сценарий редкий и ограничен первым запуском миграции на устройстве, но последствие
— тихая потеря главной пользовательской ценности.

### SEC26-6 — Medium: crafted `roleMarks` может занять почти всю local-квоту

**Файлы:** `src/popup/index.ts:46-50`, `614-633`, `739-805`.

Импорт ограничивает файл 10 МБ, число game keys — 50, длины ключей/значений —
200/40. Не ограничены число игроков внутри игры, total marks, aggregate bytes и
role ID реальным allowlist. Один game key может содержать десятки тысяч entries.

Если запись чуть меньше свободной квоты, `roleMarks` успешно сохранится, но
следующая запись полной карты `playerNotes` может быть отклонена. Превышение
квоты само по себе атомарно и не удаляет старые заметки; риск именно в payload,
подобранном ниже остатка.

`game in merged` и обычный объект также некорректно обрабатывают prototype names,
но глобальное prototype pollution не подтверждено.

### SEC26-7 — Medium: перечитывание палитры и мьютов не устранило RMW-гонку

**Файлы:** `src/content/features/player-notes.ts:510-513`, `865-910`,
`2162-2174`, `2472-2481`, `2799-2805`.

Baseline №8 исправлен частично: ошибки теперь видны пользователю, перед записью
читается свежий список и выполняется merge. Но глобальной очереди или CAS нет:

1. Вкладки A и B читают один disk-list.
2. A добавляет цвет/мьют Alice, B — Bob.
3. Обе строят разные merged arrays.
4. Последний `storage.local.set()` стирает добавление первой вкладки.

`removedTagsThisSession` и `unmutedThisSession` помогают не воскресить локально
удалённое значение, но не сериализуют два контекста. Потеря не касается текста
заметок, поэтому severity ниже baseline note race.

### SEC26-8 — Medium: consent импорта неполно классифицирует auto-actions

**Файлы:** `src/popup/index.ts:52-77`, `691-712`; `src/core/settings.ts:25`,
`36`, `117`.

Кроме SEC26-2, в `OPERATIONAL_KEYS` отсутствуют как минимум:

- `skip_start_screen_enabled` — автоматические клики стартового окна;
- `obs_auto_record_enabled` — автоматический запуск OBS recording.
- `obs_clip_enabled` — при enable сразу вызывает `replay_setup`, который может
  изменить `RecRBTime` и перезапустить Replay Buffer.

**Дополнительные файлы:** `src/content/features/obs-clip.ts:44-58`, `86-99`;
`src/background/index.ts:487-516`.

Присланный backup включает их без operational consent. Последовательное правило
для списка: отдельного подтверждения требуют импортируемые настройки, которые
автоматически кликают за пользователя, открывают сеть либо инициируют/меняют
OBS operation. Для OBS физическое действие дополнительно требует подключённой
интеграции, но это не заменяет согласие на импорт.

### SEC26-9 — Medium: «Очистить WS-log» не очищает состояние content-контекста

**Файлы:** `src/popup/index.ts:252-254`; `src/core/ws-log.ts:102-133`,
`407-416`; `src/content/features/ws-log.ts:54-90`.

Core-модули существуют отдельно в popup и content. Кнопка вызывает
`wsLog.clearAll()` только в popup: её `resetBuffer()` не видит `pending`,
`flushChain`, timer и generation игровой вкладки. Возможный сценарий:

1. Пользователь выключает полный лог; content запускает `void finishSession()`.
2. Сразу нажимает «Очистить»; popup удаляет текущие keys и показывает success.
3. Асинхронный content flush завершается после удаления и снова создаёт chunk.

При очистке во время всё ещё включённой записи следующий timer делает то же без
гонки с disable. UI обещает полную очистку, хотя файл может появиться снова.

### SEC26-10 — Medium: extras backup могут не восстановиться при общем success

**Файлы:** `src/popup/index.ts:739-815`, `819-944`.

`applyExtras()` восстанавливает palette, muted players и role marks отдельной
неатомарной записью. Любой отказ ловится внутри, пишется только в log, наружу
status не возвращается. После этого popup формирует success по результатам
notes/settings и может сообщить успешное восстановление, хотя часть обещанного
backup осталась неприменённой.

Это не стирает исходные extras: merge выполняется с текущими значениями. Риск —
ложное подтверждение recovery именно на пути смены extension ID/установки, после
которого пользователь может удалить единственную резервную копию.

### SEC26-11 — Low: финальный экспорт не редактирует старые log entries повторно

**Файлы:** `src/core/log.ts:369-390`, `449-487`;
`src/popup/index.ts:182-205`.

Новые записи проходят `redactSecrets()` на стоке. `collectAll()` при этом
доверяет массивам под `polemica:logs:*` и возвращает `Entry.m` как есть.
Запись старой версии вида `authKey=OLD_SECRET` будет экспортирована текущей
версией без новой защиты. Для `bg`, `popup` и `ext` нет content TTL.

Нужны ранее сохранённые сырые данные и ручной экспорт, поэтому это upgrade/
defense-in-depth leak, а не удалённая атака.

### SEC26-12 — Low: support-log сохраняет полный путь OBS recording

**Файлы:** `src/background/obs-client.ts:570-574`;
`src/background/index.ts:112-131`, `452-475`;
`src/content/features/obs-record.ts:29-52`.

`StopRecord.outputPath` пишется в persistent log. Путь может раскрыть имя OS
account, каталоги клиента/проекта и naming scheme записи. Требуются включённая
OBS auto-record и ручная отправка диагностического файла. Для диагностики обычно
достаточны basename, категория или boolean.

### SEC26-13 — Low: свободный внешний error text попадает в UI и support-log

**Файлы:** `src/background/obs-client.ts:503-510`;
`src/background/index.ts:523-527`; `src/content/features/obs-clip.ts:52-70`;
`src/content/features/queue-peek.ts:362-370`, `418-455`, `737-740`.

Два подтверждённых источника:

- OBS `requestStatus.comment` становится `Error.message`, затем runtime error,
  toast/status и persistent log;
- неизвестные queue rejection `message/reason` и `CloseEvent.reason` входят в
  `PeekError`, панель и persistent log.

UI использует `textContent`/экранирование, поэтому XSS нет. Риск — приватный
текст на стриме, log forging и попадание server/plugin-controlled текста в файл.
Известные credential labels центральный redactor маскирует, произвольные URL,
имена и пути — нет. Обе фичи выключены по умолчанию.

### SEC26-14 — Low: тексты экспорта неполно описывают содержимое файлов

**Файлы:** `src/static/popup.html:551-584`; `src/popup/index.ts:614-633`;
`src/core/notes-store.ts:17-38`; `src/core/ws-log.ts:20-22`.

Backup помимо «заметок и настроек» содержит прежние ники, muted players,
game IDs/table composition и role reads. WS warning упоминает полную переписку,
роли и ночные действия, но не называет явно chat text, ники, user/game IDs и
target IDs. Данные включены намеренно; проблема в точности informed consent.

## Release-гарантии

### REL26-1 — Medium process risk: новые `web-ext` warnings не блокируют релиз

**Файлы:** `scripts/release-assets.mjs:85-91`, `package.json:19-20`.

Firefox lint возвращает exit 0 при warnings. Сейчас наблюдается 32 warning; рост
до 33, например из-за нового небезопасного sink, останется зелёным. Нужен
проверяемый baseline codes/count либо отдельный статический invariant.

### REL26-2 — Medium process risk: digest-check GitHub release необязателен

**Файлы:** `scripts/release-assets.mjs:168-181`,
`scripts/verify-dist.mjs:83-97`, `package.json:25-26`.

`release:check` корректно сверяет hashes/tree/HEAD, но перед прямым
`gh release create` только напечатан как инструкция. В отличие от
`publish:chrome`, технического wrapper-гейта нет.

### REL26-3 — Low process risk: adversarial ledger — soft gate

**Файлы:** `scripts/release-assets.mjs:93-107`, `docs/review-ledger.md`.

Для `9.41.0` строка ledger отсутствует. Скрипт намеренно лишь предупреждает и
продолжает release. Это не баг реализации, но документированная обязательность
review сильнее исполняемой гарантии.

## Hardening, не отдельные уязвимости

1. `core/messaging.ts:92-102` приводит `unknown` к `ExtMessage` без runtime
   schema; `replay_setup` допускает `NaN`, а несколько handlers используют
   `"type" in msg` без object/null guard. Нужна централизованная fail-closed
   валидация для устойчивости, но обычный сайт runtime channel не достигает.
2. Sender policy для `notes_merge`, ручных OBS-команд и `obs_event` явно не
   выражена. Это полезная capability-документация и защита от внутренних ошибок,
   но найденная модель «скомпрометированный собственный content script» уже
   имеет storage/API-полномочия и сама по себе не доказывает exploit.
3. Сайт может подделывать same-window `pn-media-result`, `pn-room-probe` и
   connection diagnostic messages. Эффект ограничен disruption/poisoning
   диагностики; прямого `postMessage -> runtime` bridge нет. Nonce в page world
   не является секретом от того же сайта.
4. `collectDiagSnapshot()` вставляет browser API `Error.message` прямо в файл,
   минуя redactor. Текущего источника секрета на этих ветках не найдено.
5. `redactSecrets()` не закрывает короткие значения до четырёх символов,
   quoted values с пробелами и unlabeled URL credentials. Текущего ordinary-log
   callsite с raw `obs_password` не найдено.
6. Исторически испорченный `NoteRecord.tag` читается без общей нормализации и в
   player-notes доходит до `ring.style.cssText`. Текущий импорт проверяет
   `isSafeTag()`, сайт не пишет extension storage; актуального attacker path нет.
7. У release scripts и точных manifest host/WAR/CSP/`externally_connectable`
   гарантий нет собственных regression tests. Реализация на HEAD чистая, но
   будущий mutant может пережить `npm test`.

## Статус baseline 01.08.2026

| № | Baseline-находка | Статус на 9.41.0 |
|---|---|---|
| 1 | Межвкладочная потеря notes whole-map | Закрыта background-координатором и delta ops; принятый fallback-риск описан в AGENTS §6 №19 |
| 2 | Гонка sync→local миграции | Открыта частично, SEC26-5 |
| 3 | Потеря sync-палитры миграцией | Закрыта ordered-set merge и учётом palette-only migration |
| 4 | Ненормализованный malicious backup | Закрыта `normalizeNoteRecord()` |
| 5 | Неограниченный backup и тихая замена | Основная часть закрыта size/count/type limits и consent; aggregate `roleMarks` остаётся, SEC26-6 |
| 6 | Настройки активируются до отказа notes | Порядок закрыт; operational classification неполна, SEC26-2/8 |
| 7 | Backup не включает устойчивые данные | Поля добавлены, но extras restore не сообщает partial failure, SEC26-10; disclosure wording остаётся, SEC26-14 |
| 8 | Silent failure и lost update palette/mutes | Silent failure закрыт; RMW-гонка остаётся, SEC26-7 |
| 9 | Connection diagnostics пишет frame bodies/credentials | Закрыта структурными summaries и redaction |
| 10 | Page storage включает persistent Twitch debug | Закрыта fixed `bufferLevel=info`; raw IRC не логируется |
| 11 | Confused auto-accept click и duplicate background path | Закрыта route/scope/exact/deepest/visibility/budget/backoff gates; background inject удалён |
| 12 | Nick→id migration стирает string `u:` record | Закрыта `toRecord()`, lossless tie merge и canonical ID keys |
| 13 | Полный page URL в обычном логе | Закрыта `origin + pathname`; query/fragment исключены |
| 14 | `cssAttr()` не экранирует controls | Закрыта `CSS.escape` и fallback hex escaping |
| 15 | Future requeue timestamp | Закрыта `validateMark()` |
| 16 | FloatingPanel восстанавливается за viewport | Закрыта clamp по viewport |

## Карта sink'ов

| Sink | Источники | Защита | Остаток |
|---|---|---|---|
| Notes backup JSON | settings, notes, nick history, tags, muted nicks, role marks | explicit click, file cap, record normalization, `obs_password` excluded | raw `obs_host`; incomplete disclosure; roleMarks aggregate; silent extras failure |
| Browser `storage.sync` | все Settings кроме `obs_password` | browser account transport; notes bridge frozen | raw credentials/query внутри `obs_host` синхронизируются автоматически |
| Ordinary support TXT | logger entries, UA, settings/storage/OBS/tab snapshot | sink redaction for new entries, safe endpoint, no query/fragment, completeness marker | legacy entries, OBS path, free-form OBS/queue errors, snapshot exceptions |
| Full WS TXT | incoming/outgoing room frames | off by default, media filter, named-secret redaction, per-frame cap, TTL, explicit download | import consent bypass; real-size/generation accounting; clear race; sensitive-content wording |
| UI toasts/status | OBS and queue errors, local outcomes | `textContent` or escaping | raw external text can be shown on stream |
| Site-readable DOM | notes/statistics panels, tags, Twitch overlay, OBS controls | output escaping, local feature gates | displayed user data is intentionally visible to the same page/user; no extension secret sink found |
| Runtime IPC | own popup/background/content contexts | no external channel; target-tab delivery where needed | schemas/sender roles implicit |
| Page `postMessage` probes | site-controlled same window | source/origin/type/length filters vary by probe | diagnostic spoofing/disruption, no privilege bridge |
| OBS WebSocket | configured localhost OBS | CSP localhost-only, challenge-response auth, endpoint redaction in logs | raw password remains local; server comments return as free-form errors |
| Twitch IRC WebSocket | `wss://irc-ws.chat.twitch.tv:443` | feature off by default, normalized channel, no persisted raw IRC | chat shown in overlay/history by design |
| Polemica HTTPS/API and queue WS | match/profile/rating/history/search data; queue credentials | manifest HTTPS scope, queue credentials parsed in memory, raw bodies not ordinarily logged | queue close/rejection free text can enter support log |
| GitHub Releases HTTPS | extension version/update metadata | fixed API URL, no user payload | no user data sent |
| ZIP/XPI/gate stamp | built source/manifests and git/hash metadata | local release gate and digests | no runtime user data; GitHub check remains manual |

## Проверено и чисто

### HTML, SVG, CSS и URL

- Проверены текущие `innerHTML`, `outerHTML`, `insertAdjacentHTML`, SVG и CSS
  sinks. Достижимой script/markup injection не найдено.
- Twitch live/history text и usernames экранируются; colors строго `#rrggbb`,
  badges из локального allowlist.
- OBS scene names экранируются либо записываются через `textContent`/`dataset`.
- Role SVG строится `createElementNS()`/`setAttribute()`.
- Profile links используют положительные numeric IDs; arbitrary
  `javascript:`/`data:` navigation sink не найден.
- `textarea.innerHTML` в match-data используется на detached textarea только
  как fallback entity decoder.

### Secrets и сеть

- `obs_password` хранится только в `storage.local`, исключён из backup,
  diagnostic snapshot и settings broadcast.
- Обычные OBS endpoint logs и snapshot используют `safeEndpoint()`; close
  reasons категоризируются локально.
- Connection diagnostics не пишет frame bodies, query string или close reason.
- Обычный Twitch log не содержит raw IRC, nick или message text.
- Boot/tab diagnostics исключают query и fragment.
- Note text не найден в ordinary persistent logs или diagnostic snapshot.
- Нет telemetry, automatic upload, remote code, `eval` или `new Function`.

### Manifest и permissions

- Permissions `storage`, `alarms`, `notifications` имеют реальные callsites.
- `scripting`, optional permissions, HTTP matches и HTTP host permissions
  отсутствуют.
- `externally_connectable` и production `onMessageExternal` отсутствуют.
- WAR ограничен тремя используемыми page probes и HTTPS Polemica origin.
- CSP: `script-src 'self'`; OBS connect ограничен localhost.
- Chrome и Firefox manifests собираются из одного base с ожидаемыми overlays.

### Notes и storage

- Notes остаются в `storage.local`; frozen sync bridge не удаляется.
- Import records реконструируются только из известных полей; key/text/count,
  timestamp и CSS values ограничены.
- Coordinator fail-closed при load failure и превышении replacement consent.
- Popup fallback перечитывает карту после диалога и не срабатывает на malformed
  coordinator response.
- WS sweep удаляет только `polemica:wslog:*` и напрямую не удаляет notes.
  Практический отказ — блокировка будущих writes при занятой квоте.

## Проверки

Финальный прогон после правок первого и второго adversarial review:

```text
npm run typecheck
exit 0

npx tsc -p tests/tsconfig.json --noEmit
exit 0

npm test
exit 0; 73 test files, 1103 tests passed

npx web-ext lint -s dist/chrome
exit 1; 2 errors, 1 notice, 32 warnings
errors: MANIFEST_FIELD_UNSUPPORTED (Chrome service_worker),
        EXTENSION_ID_REQUIRED (нет Firefox Gecko ID)

npx web-ext lint -s dist/firefox
exit 0; 0 errors, 0 notices, 32 warnings

git diff --check
exit 0
```

Chrome lint запускается отдельно по требованию аудита, но его exit 1 ожидаем:
`web-ext` — Firefox-oriented validator и отвергает корректный Chrome MV3
`background.service_worker`. Release gate поэтому блокирует только ненулевой
Firefox lint; Chrome artifact фактически валидирует CWS upload.
