# Аудит безопасности и целостности данных Polemica Notes — 01.08.2026

Проверен текущий HEAD, manifest `9.0.0`. Код не менялся. Выполнены шесть
параллельных статических аудитов и отдельная adversarial-перепроверка находок.

Локально подтверждены два PoC:

```text
isSafeTag(123) === true
isSafeTag(["red"]) === true
```

И диагностический Socket.IO frame:

```text
40/search?userId=6521&authKey=SECRET...
```

при обрезке до 32 символов раскрывает:

```text
40/search?userId=6521&authKey=SE
```

Живая сессия не использовалась: доказанные пути не требуют поведения текущей
вёрстки игры.

## Итог

- КРИТИЧНО: не найдено.
- ВАЖНО: 12 находок.
- МЕЛОЧЬ: 4 находки.
- Исполняемой HTML/SVG-инъекции через ник, заметку, Twitch или API не найдено.
- Основной риск целостности: несколько контекстов заменяют целиком
  `playerNotes`.
- Основной риск злонамеренного файла: бэкап не проходит полноценную
  runtime-нормализацию.
- Основной privacy-риск: диагностика и управляемый страницей log level
  сохраняют чужие сообщения и сетевые credentials.

## Находки

### 1. ВАЖНО: две вкладки молча стирают несвязанные заметки друг друга

**Файлы:** `src/core/notes-store.ts:264-272`;
`src/content/features/player-notes.ts:364-398`, `522-537`, `1965-2017`,
`2118-2302`

**Вход → путь → последствие:**

1. Вкладки A и B загрузили одинаковую карту `N`.
2. A изменила Alice и начала `storage.local.set(N + Alice)`.
3. До доставки `storage.onChanged` вкладка B изменила Bob.
4. B записала старую карту `N + Bob`.
5. Последняя whole-map запись полностью заменяет `playerNotes`.
6. Alice исчезает, хотя обе операции могли показать «Сохранено».

```ts
await browser.storage.local.set({ [NOTES_KEY]: notes, version: NOTES_VERSION });
```

`notesWriteQueue` сериализует операции только внутри одного экземпляра content
script. Между вкладками, popup и другими контекстами общей очереди нет.

Popup-импорт имеет ту же гонку: `loadNotes → mergeNotes → saveNotes` в
`popup/index.ts:408-425`. Заметка, сохранённая между чтением и записью импорта,
стирается успешным импортом.

**Фикс:** шардировать заметки по ключам либо проводить все note-операции через
background-координатор с единой очередью и delta-операциями. Простой
`get → merge → set` без межконтекстного lock лишь уменьшит окно.

**Инварианты:** §4.3, §4.11.

### 2. ВАЖНО: первая sync→local миграция может затереть свежую local-запись и закрыть повтор флагом

**Файл:** `src/core/notes-store.ts:194-255`

**Вход → путь → последствие:**

1. Контекст A читает local-карту `L0`, флаг миграции ещё `false`.
2. A отдельно начинает `storage.sync.get(...)`.
3. Вкладка B записывает свежую карту `L1`.
4. A сливает sync с устаревшей `L0`.
5. A одним `set` пишет устаревший результат и `pn_notes_migrated_v1=true`.
6. Изменение `L1` потеряно, миграция больше не повторится.

```ts
await browser.storage.local.set({
  [NOTES_KEY]: merged,
  [TAGS_KEY]: customTags,
  [MIGRATED_KEY]: true,
});
```

Атомарность «результат + флаг» формально соблюдена, но результат построен на
устаревшем снимке. Миграцию может запустить даже read-only `queue-peek`,
вызывающий `loadNotes()`.

**Фикс:** выполнять миграцию в background под той же глобальной очередью, что
и все писатели. Непосредственно перед commit проверять ревизию local-карты или
использовать CAS-подобный протокол.

**Инварианты:** §4.3, §4.11. Sync-мост нельзя удалять.

### 3. ВАЖНО: миграция палитры автоматически теряет sync-цвета

**Файл:** `src/core/notes-store.ts:200-222`

Подтверждены две ветки.

**Sync-only палитра без заметок:**

```ts
if (!Object.keys(fromSync).length && !Object.keys(fromLegacy).length) {
  await browser.storage.local.set({ [MIGRATED_KEY]: true });
  return { notes: localNotes, customTags: localTags };
}
```

Если в sync есть `tagCustomColors`, но нет заметок, код ставит флаг и выходит
до обработки палитры. Цвета остаются в замороженной sync-копии, но штатно
больше не импортируются.

**Непустая local-палитра:**

```ts
const customTags = localTags.length ? localTags : syncTags;
```

Любой local-цвет полностью подавляет дополнительные sync-цвета вместо
объединения.

**Последствие:** пользователь после обновления видит неполную или пустую
пользовательскую палитру без каких-либо действий и предупреждений.

**Фикс:** учитывать `syncTags` при проверке «переносить нечего», валидировать
элементы и объединять local/sync как ordered set. Затем атомарно писать палитру
и флаг.

**Инварианты:** §4.11.

### 4. ВАЖНО: злонамеренный бэкап сохраняет записи неправильных типов и устойчиво ломает заметки

**Файлы:** `src/core/notes-store.ts:70-75`, `137-191`;
`src/core/dom.ts:199-228`; `src/content/features/player-notes.ts:625-637`,
`2309-2327`

**PoC:**

```json
{
  "app": "polemica-notes",
  "type": "notes-backup",
  "notes": {
    "u:123": {
      "text": "обычная заметка",
      "timestamp": 1,
      "nick": 123,
      "nickColor": 123
    }
  }
}
```

**Вход → путь → последствие:**

1. `mergeNotes()` проверяет только наличие строкового `text`.
2. `nick`, `timestamp`, `version`, `tag`, `nickColor` полноценно не
   нормализуются.
3. `isSafeTag(123)` возвращает `true`: RegExp неявно преобразует число в
   строку.
4. Запись сохраняется в `storage.local`.
5. После перезапуска потребители вызывают:
   - `rec.nick.toLowerCase()`;
   - `a.nick.localeCompare(...)`;
   - `color.includes("gradient")`.
6. Проходы заметок, менеджер цветов или очередь начинают устойчиво бросать
   `TypeError`.

Arrays также проходят часть проверки:

```json
"tag": ["red"]
```

Поскольку `["red"].length === 1`, а RegExp преобразует массив в `"red"`.

Это не XSS, но постоянная порча extension state после импорта присланного
файла.

**Фикс:** принимать `unknown` и создавать новый нормализованный `NoteRecord`
только из разрешённых полей и типов. `isSafeTag(raw)` первым условием должен
требовать `typeof raw === "string"`.

**Инварианты:** §4.3. Нельзя сохранять сырой объект JSON через TypeScript cast.

### 5. ВАЖНО: бэкап не ограничен по размеру и может без предупреждения заменить хорошие заметки

**Файлы:** `src/popup/index.ts:359-425`;
`src/core/notes-store.ts:128-130`, `154-188`

Нет ограничений на:

- размер файла;
- количество записей;
- длину ключа и текста;
- суммарный размер;
- глубину и размер неизвестных полей;
- диапазон timestamp.

`file.text()` и `JSON.parse()` загружают весь файл. Неизвестные поля
сохраняются вместе с записью через `safe = note`.

**PoC перезаписи:**

```json
{
  "app": "polemica-notes",
  "notes": {
    "Alice": {
      "text": "текст из присланного файла",
      "timestamp": 9007199254740991
    }
  }
}
```

Любое числовое значение принимается timestamp. Оно побеждает существующую
запись:

```ts
noteTimestamp(safe) > noteTimestamp(existing)
```

Импорт не показывает preview конфликтов и не запрашивает подтверждение замен.
Существующий текст Alice исчезает.

Большой файл может заморозить popup либо занять почти всю квоту
`storage.local`, после чего перестанут сохраняться заметки, логи и палитры.
Quota rejection хотя бы возвращает ошибку, но near-quota payload может успешно
сохраниться.

**Фикс:** до чтения ограничивать `file.size`; после parse нормализовать только
известные поля, ограничить count/key/text/aggregate bytes и разумный диапазон
timestamp. Перед заменой показывать количество конфликтов и делать recovery
snapshot.

**Инварианты:** §4.3, loadFailed-гейт.

### 6. ВАЖНО: импорт настроек неатомарен и может активировать опасное поведение до отказа заметок

**Файл:** `src/popup/index.ts:369-425`

Настройки записываются до чтения и сохранения заметок. Проверяется только
совпадение `typeof` с дефолтом:

```ts
if (typeof value === typeof def) patch[key] = value;
```

Не проверяются:

- `app` и `type` бэкапа;
- enum-значения;
- длины строк;
- корректность hotkey;
- допустимость OBS endpoint;
- необходимость подтверждения автоматических действий.

**PoC:**

```json
{
  "app": "anything",
  "settings": {
    "auto_accept_enabled": true,
    "requeue_after_lobby_fail_enabled": true,
    "obs_enabled": true,
    "obs_auto_mode_enabled": true,
    "obs_host": "ws://localhost:9999"
  },
  "notes": {
    "Alice": {
      "text": "<слишком большая строка для квоты>",
      "timestamp": 1
    }
  }
}
```

**Последствие:**

1. Настройки успешно применяются и немедленно запускают соответствующие фичи.
2. Сохранение notes падает по квоте.
3. Popup сообщает, что заметки не сохранились, но настройки уже активны.
4. Rollback отсутствует.

`obs_password` правильно не импортируется, однако старый локальный пароль
сохраняется. Изменение `obs_host` запускает reconnect через
`background/index.ts:330-366`. Фальшивый localhost OBS-сервер может выбрать
salt/challenge и получить password-derived response для offline guessing.

CSP ограничивает этот сценарий localhost, поэтому удалённой отправки пароля не
подтверждено.

**Фикс:** сначала полностью валидировать пакет, затем показать preview
operational settings. Не импортировать включённые auto-action/OBS флаги без
отдельного подтверждения; при смене OBS host очищать пароль или требовать
повторный ввод.

**Инварианты:** §4.4, §4.6, §4.10. Пароль остаётся только в local.

### 7. ВАЖНО: обещанный «полный» бэкап не включает часть устойчивых пользовательских данных

**Файлы:** `src/popup/index.ts:315-340`;
`src/static/popup.html:450-457`

UI обещает:

> импорт вернёт всё как было

Но export содержит только:

```ts
settings: safeSettings,
notes,
```

Не экспортируются:

- `tagCustomColors`;
- `pn_muted_players`;
- `roleMarks`.

Наиболее значимы первые два:

- пользовательские цвета, уже назначенные конкретным заметкам, сохранятся;
- неназначенные заготовки палитры исчезнут;
- персистентные локальные мьюты игроков исчезнут.

Это воспроизводится именно на документированном пути смены Chrome ID или
перехода с временной Firefox-установки.

**Фикс:** определить версионированную backup-схему и включить все устойчивые
пользовательские данные. Если role marks сознательно считаются временными,
явно исключить их из обещания UI.

**Инварианты:** §4.3, §4.11. Каждый компонент импорта валидировать отдельно.

### 8. ВАЖНО: палитра и список мьютов имеют silent failure и собственные lost-update гонки

**Файлы:** `src/content/features/player-notes.ts:548-571`, `1646-1648`,
`1915-1923`, `2237-2241`; `src/core/notes-store.ts:275-283`

Палитра сначала меняется в памяти, затем результат сохранения игнорируется:

```ts
this.customTags.push(c);
void this.saveCustomTags();
```

```ts
private async saveCustomTags(): Promise<void> {
  if (this.notesReadOnly) return;
  await saveCustomTagsToStore(this.customTags);
}
```

`saveCustomTags()` возвращает `false` при quota/I/O error, но вызывающий не
показывает ошибку и не откатывает UI. После reload цвет исчезает.

Две вкладки также пишут весь массив `tagCustomColors`, поэтому одновременные
добавления A и B дают только одно из них.

`pn_muted_players` имеет тот же класс дефекта:

```ts
void browser.storage.local
  .set({ [MUTED_PLAYERS_KEY]: [...this.mutedPlayers] })
  .catch(/* ... */);
```

Ошибка остаётся только в логе, а две вкладки заменяют список целиком.

**Фикс:** хранить add/remove как операции под глобальной очередью; подтверждать
UI только после durable commit либо откатывать. Для ошибок показывать
пользователю явное сообщение.

**Инварианты:** §4.3.

### 9. ВАЖНО: диагностика сохраняет тела WebSocket и части credentials в support-log

**Файлы:** `src/content/page/conn-diag-page.ts:49-76`, `104-174`;
`src/content/features/connection-diag.ts:57-62`; `src/popup/index.ts:48-68`

PAGE-скрипт перехватывает все WebSocket страницы, не только очередь:

```ts
else if (s.length <= 64) say(`WS send ${s} ${label}`);
else say(`WS send(${s.length}) ${s.slice(0, 32)}… ${label}`);
```

Далее:

```ts
log.info(SCOPE, /* ... */, data.line.slice(0, 400));
```

Запись персистится в `storage.local`, затем кнопка «Скачать» включает её в
файл, который UI предлагает прислать поддержке.

**Реальный путь credentials:**

```text
40/search?userId=6521&authKey=SECRET&intention=game_search
```

Для длинного ключа сохраняется как минимум префикс. Короткий frame до
64 символов сохраняется полностью. Аналогично пишутся входящие сообщения,
handshake, close reason и короткие payload других сокетов.

Страница также может подделать строку лога:

```js
window.postMessage({
  source: "pn-conn-diag",
  t: 0,
  line: "произвольная строка"
}, location.origin);
```

Listener проверяет origin/source, но сообщение приходит из того же
недоверенного page world.

**Гейт:** пользователь должен включить диагностику и persistence логов, а
затем вручную выгрузить файл.

**Фикс:** никогда не логировать frame body. Парсить только тип события,
размер, timing, event name и close code; централизованно редактировать
`authKey`, token, password, authorization, query и cookie. Ограничить зонд
ожидаемым socket URL.

**Инварианты:** §4.7, §5 о недоверенном page world.

### 10. ВАЖНО: сайт может включить сохранение полного Twitch-чата через свой `localStorage`

**Файлы:** `src/core/log.ts:33-40`, `65-68`, `241-245`;
`src/content/panels/twitch-panel.ts:930-943`

Уровень persistence берётся из page-owned storage:

```ts
localStorage.getItem("polemica:buflevel")
```

Сайт может выполнить:

```js
localStorage.setItem("polemica:buflevel", "debug");
location.reload();
```

После этого Twitch пишет полный raw IRC frame:

```ts
log.debug(SCOPE, "IRC <<", line);
```

В строке находятся:

- username;
- display-name;
- channel;
- полный текст сообщения;
- badges и остальные IRC tags.

При дефолтном `debug_logging_enabled=true` чат сохраняется в extension storage
и позже попадает в support export. Сайт не может самостоятельно прочитать
файл, но может незаметно включить сбор данных третьих лиц.

**Фикс:** перенести уровни логирования в extension-owned `storage.local`. Raw
`PRIVMSG` не логировать даже на debug; сохранять только event type и длину.

**Инварианты:** §5 прямо считает page `localStorage` недоверенным.

### 11. ВАЖНО: два auto-accept пути всё ещё допускают confused click

**Файлы:** `src/content/features/auto-start.ts:86-103`, `121-229`;
`src/background/auto-accept.ts:17-81`; `src/content/features/search.ts:17-29`

**Content fallback:**

```ts
.filter((el) => containsAny(norm(el), TEXT.acceptGameText))
```

Затем найденный элемент кликается без обязательного accept-container:

```ts
if (consumeClickBudget(el)) safeClick(el);
```

**PoC на `/game-search`:**

```js
const b = document.createElement("button");
b.textContent = "Не принять игру";
b.onclick = () => console.log("нежелательное действие");
document.body.append(b);
```

Подстрока `принять игру` совпадает, кнопка видима и может быть нажата до трёх
раз.

**Background fallback:**

- ищет document-wide generic `"готов"`, `"подтвердить"`, `"confirm"`,
  `"join"`;
- не проверяет accept-container;
- не имеет trusted-user backoff;
- не проверяет pathname внутри инжекта.

Запуск инициируется click-listener, который не требует `e.isTrusted`:

```js
document.querySelector(".p-play__profile-button").click();
```

Это открывает 10-секундное окно, в котором появившаяся посторонняя кнопка
`Подтвердить` может быть нажата расширением.

Маловероятно, что другой игрок напрямую создаст такой DOM, но это конкретный
путь через недоверенную разметку сайта и нарушение §4.2.

**Фикс:** единая реализация exact-text + deepest-only + accept-container +
visibility + budget + trusted backoff. Предпочтительно удалить дублирующий
background-инжект и permission `scripting`.

**Инварианты:** §4.2, §4.10.

### 12. ВАЖНО: ленивый ник→id перенос может автоматически уничтожить строковую `u:`-запись

**Файл:** `src/content/features/player-notes.ts:683-741`

**PoC backup:**

```json
{
  "notes": {
    "u:123": "важный текст под id",
    "Alice": {
      "text": "другая заметка",
      "timestamp": 1
    }
  }
}
```

После появления Alice в игре статистика резолвит `userId=123`.

Существующая id-запись принимается только если она object:

```ts
let best =
  fresh[key] !== undefined && typeof fresh[key] === "object"
    ? fresh[key]
    : undefined;
```

Строка `"важный текст под id"` игнорируется. Победителем становится
ник-запись, после чего:

```ts
fresh[key] = { ...winner, nick: username };
```

исходный id-текст уничтожается без участия пользователя.

Связанные дефекты импорта:

- mixed backup `u:123` + `Alice` в пустой базе может оставить две записи,
  потому что `idKeyByNick` строится только из `base`;
- `u:0123` и `u:123` считаются разными ключами.

**Фикс:** пропускать существующую id-запись через тот же `toRecord()`,
нормализовать весь incoming до merge и канонизировать положительные decimal ID
без ведущих нулей.

**Инварианты:** §4.3, §4.11. Конфликтующие тексты нельзя удалять до lossless
merge.

## Мелкие находки

### 13. МЕЛОЧЬ: полный URL страницы сохраняется в лог по умолчанию

**Файл:** `src/content/index.ts:132`

```ts
log.info("content", "booted", navigator.userAgent, location.href);
```

Query и fragment попадают в `storage.local`, затем в support-файл. Конкретный
текущий bearer-token route не найден, поэтому это не подтверждённая credential
leak, но invitation/private query будут раскрыты при отправке логов.

**Фикс:** писать только `origin + pathname` либо route enum.

### 14. МЕЛОЧЬ: `cssAttr()` не экранирует CSS control characters

**Файл:** `src/content/features/player-notes.ts:1281-1288`, `3125-3132`,
`3254-3257`

```ts
return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
```

Ник с literal LF/CR/form-feed может сделать `[data-username="..."]`
невалидным и вызвать `querySelectorAll()` exception.

**PoC-ник:**

```text
alice<U+000A>bob
```

Это не selector breakout с исполнением CSS, но может регулярно срывать
обновление tooltip/buttons. Требуется, чтобы сайт допустил control character.

**Фикс:** использовать `CSS.escape` с безопасной конструкцией селектора либо
избегать селектора по нику и фильтровать `dataset.username` в JS.

### 15. МЕЛОЧЬ: будущий timestamp в `sessionStorage` проходит requeue-проверку

**Файл:** `src/content/features/queue-requeue.ts:185-200`

```ts
if (!Number.isFinite(ts) || Date.now() - ts > PENDING_TTL_MS) return;
```

Будущее время даёт отрицательный age и считается свежим:

```js
sessionStorage.setItem("pn_requeue_pending", String(Date.now() + 10 ** 12));
```

Флаг одноразовый и последующий клик всё ещё проходит
foreground/modal/backoff/budget, поэтому повышения привилегий почти нет.

**Фикс:** отклонять `age < 0`; для реального provenance хранить bridge в
extension-owned session state.

### 16. МЕЛОЧЬ: page storage может навсегда убрать FloatingPanel за экран

**Файл:** `src/core/FloatingPanel.ts:378-401`

Проверяются finite и положительные размеры, но нет максимума и viewport clamp:

```js
localStorage.setItem("fp:twitch-panel", JSON.stringify({
  left: 1e9,
  top: 1e9,
  width: 1e9,
  height: 1e9
}));
```

Панель восстанавливается недоступной. Это persistent UI denial, но сайт и так
контролирует собственную страницу.

**Фикс:** ограничивать размеры viewport/config max и оставлять header видимым.

## Топ-3

1. **Убрать whole-map last-write-wins.** Ввести background-координатор или
   шардированные ключи заметок, палитры и мьютов. Это закрывает межвкладочные
   потери, импортные RMW и миграционные гонки.
2. **Ввести строгую версионированную backup-схему.** Нормализовать каждый
   record из `unknown`, ограничивать размер, показывать preview конфликтов, не
   активировать operational settings до подтверждения.
3. **Перестать сохранять содержимое сетевых сообщений.** Убрать raw
   WebSocket/IRC bodies, перенести log level из page storage и централизованно
   редактировать credentials/URL.

## Проверено и чисто

### DOM/HTML/SVG

- Проверены все 33 активных `innerHTML`, один `insertAdjacentHTML` и один
  `outerHTML` bridge.
- Исполняемой HTML-инъекции через ник, note text, match API, Twitch, OBS scene
  или GitHub tag не найдено.
- Ники и заметки в HTML проходят `escapeHtml`; в остальных местах используются
  `textContent`, `.value`, `dataset` или property assignment.
- `escapeHtml` корректен для используемых text и double-quoted attribute
  contexts.
- Twitch username/message/system text экранируются в финальном sink.
- Twitch color принимается только по `^#[0-9a-fA-F]{6}$`.
- Twitch badges отображаются через локальную emoji-таблицу.
- OBS scene names экранируются либо записываются через `textContent`.
- Role SVG строится через `createElementNS`/`setAttribute`; string-built
  SVG-инъекции нет.
- `match-data` использует detached textarea только как entity decoder; узел не
  подключается к DOM.

### CSS и прототипы

- Строковый `isSafeTag` блокирует `;`, quotes, braces, slash, backslash,
  `url()`, `expression`, `@import` и длину более 200.
- Declaration breakout через Unicode lookalikes или CSS escapes не
  подтверждён.
- `var(...)` проходит, но самостоятельного пути к исполнению кода или утечке
  extension secrets не даёт.
- `__proto__`, `constructor`, `prototype` отбрасываются как note keys.
- Prototype pollution через JSON/object spread не воспроизведён.
- Прямая UI-палитра использует `input[type=color]`, выдающий нормализованный
  hex.
- `stats_button_theme` проходит через фиксированный `THEME_COLORS`.

### Хранилище и backup

- Заметки остаются в `storage.local`.
- `loadFailed` блокирует destructive merge-over-empty в popup и content.
- Обычные note-save пути проверяют результат и показывают ошибку.
- Миграция пишет данные и флаг одним `local.set`.
- При исключении миграционный флаг не ставится.
- Замороженная sync-копия заметок не удаляется.
- `obs_password` исключён из export, import и broadcast в content.
- Popup продолжает писать settings только diff против `lastKnown`.

### Утечки и сеть

- Обычные note-save пути не логируют текст заметки.
- OBS raw password не логируется и хранится только в `storage.local`.
- OBS отправляет challenge-response, не сырой пароль.
- Queue URL строится через `URLSearchParams`, namespace `authKey` проходит
  `encodeURIComponent`.
- Ошибка чтения queue credentials логирует только `Error.name`, а не JSON с
  ключом.
- Twitch destination фиксирован, channel нормализуется до `[a-z0-9_]`.
- Runtime fetch destinations фиксированы Polemica/GitHub.
- Cross-origin request injection через ник не найдена.
- GitHub update banner использует фиксированный URL и `textContent`.

### Manifest и messages

- `externally_connectable` отсутствует.
- Remote scripts и `unsafe-eval` запрещены CSP.
- Host permissions ограничены Polemica.
- WAR содержит только `conn-diag-page.js` и доступен только Polemica origins.
- `storage`, `alarms`, `notifications` реально используются.
- `scripting` нужен только дублирующему background auto-accept.
- Runtime handlers почти не валидируют sender/schema, но web page не имеет
  пути к `runtime.onMessage` без `externally_connectable`; конкретного внешнего
  message exploit не найдено.
