# Тестовая инфраструктура Polemica Notes — 01.08.2026

## Итог

С нуля добавлены Vitest 4.1.6, jsdom, fast-check и fast-glob. Production build
по-прежнему использует tsup/IIFE и не зависит от тестовых пакетов.

| Набор | Результат | Время последнего прогона |
|---|---:|---:|
| 1. Unit, DOM, property, небольшие state machine | 134 passed, 12 todo | ~0.4 с отдельно |
| 2. Статические архитектурные инварианты | 16 passed, 4 todo | ~0.3 с отдельно |
| 1+2 через `npm test` | 150 passed, 16 todo | ~0.6 с |
| 3. Живой контракт сайта | 3 passed | ~4.9 с |

`test.todo` здесь не заглушки инфраструктуры, а список известных production
дефектов: позитивные сценарии и остальные проверки исполняются реально.

## Что покрыто

### Набор 1

- `notes-store`: нормализация недоверенного импорта, лимиты 5 000/20 000,
  legacy strings, future timestamps, CSS tags, canonical keys, merge conflict,
  nick/color index и lookup.
- Четыре fast-check свойства с фиксированными seed и 200 runs каждое:
  идемпотентность, отсутствие новых ключей, сохранение цвета при замене и
  зарегистрированные desired properties для text/color conflicts.
- Фазы: вся таблица `tests/fixtures/phase-labels.ru.json`, конфликт
  «Ночь | Голосование мафии», утро, доктор, аукцион, номера игроков, таймеры,
  границы `day`/`miss`.
- Терминальный экран: победа распознаётся, `.ended-pause` не считается концом.
- Redaction секретов, ограничение длины и защита слов `considered`/`resident`.
- Парсер countdown, `cssAttr` через реальный `querySelectorAll` jsdom,
  `escapeHtml`, match route, keyboard helper/router.
- Интеграционные регрессии аудитов: очередь coordinator сохраняет две
  одновременные правки; read failure запрещает overwrite; Firefox unchanged-key
  events игнорируются; remove setting возвращает default; strict messaging не
  выдаёт missing receiver за успех; FeatureManager делает rollback и coalescing.

### Набор 2

- Координатор и два явно разрешённых compatibility fallback — единственные
  прямые whole-map writers заметок.
- Заметки не пишутся/не удаляются из `storage.sync`; migration flag и data
  коммитятся вместе, frozen bridge не удаляется.
- Wildcard DOM scans не могут вырасти незаметно; текущий один случай tracked как
  bug. В production ровно один `MutationObserver`.
- Lifecycle heuristic сравнивает listeners/timers по каждому feature file;
  точные allowances снабжены причинами и проверяются на устаревание.
- Хоткей-роутер сохраняет `event.code`, typing/modifier/repeat gates; WebSocket
  teardown содержит все четыре handlers.
- Match parser предпочитает `game-data`, делает parse-first; lift ballot
  отделён от туров и использует strict majority, `departed` остаётся массивом.
- Settings и `DEFAULT_SETTINGS` извлекаются независимо через TypeScript AST и
  сравниваются как множества.
- Версии package/manifest, browser floors и Chrome/Firefox background forms.
- Реальные `browser.*` namespaces сопоставляются с permissions; новый namespace
  требует явного решения, `scripting` запрещён без использования.
- AST-проверка запрещает секреты в `log.*`; popup обязан писать diff `patch` и
  быть подписан на external changes.

### Набор 3

- Скачиваются четыре заданных bundle с timeout 8 с и максимум тремя попытками.
  Network errors и 5xx дают runtime skip; 4xx и semantic drift не маскируются.
- Каждый site-owned CSS class из `SITE` ищется по всем bundle. Точный список
  известных dead/extension-owned keys хранится отдельно и не может расти молча.
- Русские phase markers сверяются с locale strings; EN markers явно считаются
  best-effort.
- Locale labels извлекаются без выполнения скачанного JS, включая повторные
  ключи; офлайн-набор использует закэшированную таблицу фаз.
- SHA-256 сравнивается с fixture. Новый hash даёт warning, но semantic contract
  продолжает проверяться; запись нового hash только по explicit env flag.
- Проверены live shapes `ratings/default/get-list`, `get-statistic`,
  `get-role-statistic`, `get-games` с реальным `user_id` из rating response.
  Auth-required profile APIs корректно skip при 401/403.

## Production-правки

Логика production не менялась. Сделаны только два test seam:

1. `src/content/features/queue-requeue.ts`: экспортирован существующий
   `parseCountdownSeconds`.
2. `src/content/features/player-notes.ts`: экспортирован существующий `cssAttr`.

Оба изменения добавляют только keyword `export`, не меняют вызовы, state,
bundling или браузерное поведение.

## Найденные баги

Все ниже оставлены без production-фикса и зарегистрированы через `test.todo`.

### 1. `isSafeNoteKey` доверяет compile-time типу

**Воспроизведение:** вызвать `isSafeNoteKey(["Alice"] as any)` — массив проходит;
`null`/`undefined` бросают на `.length`; строка длиннее 200 символов принимается,
хотя storage/import limit равен 200.

**Риск:** crafted backup или повреждённое persisted state обходят ожидаемый
runtime boundary. Часть callers отдельно проверяет длину, но helper не выполняет
собственный заявленный safety contract.

### 2. `mergeNotes` зависит от порядка mixed backup

**Воспроизведение:** incoming map содержит сначала `Alice`, затем `u:7` с
`nick: "Alice"`. Ник-ключ создаётся до появления id в индексе и остаётся дублем.
Обратный порядок даёт одну запись.

### 3. Base id keys не канонизируются

**Воспроизведение:** base содержит `u:007`, incoming — `u:7`. Канонизируется
только incoming, поэтому в результате остаются два ключа одного пользователя.

### 4. Merge может потерять непустое поле

**Воспроизведение:** более новая incoming запись имеет `text: ""`, а старая —
непустой text: новый пустой text побеждает. В обратном направлении timestamp
может оставить новую запись без color и проигнорировать color из более старого
аргумента. Desired property «не терять непустое» сейчас не выполняется
симметрично.

### 5. Color index не защищён от старого мусора

**Воспроизведение:** `buildNickColorIndex({"u:1": {text:"", timestamp:1,
nick:123, nickColor:"#fff"} as any})` бросает на `toLowerCase`. `u:001` также
не находится по id `1`, потому что index не канонизирует id key.

### 6. Pretty JSON обходит redaction

**Воспроизведение:** `redactSecrets('"token" : "abcdef"')` сохраняет секрет.
Regex допускает максимум четыре separator characters, а обычная pretty-запись
между key и value содержит пять.

### 7. Countdown принимает невозможное время

**Воспроизведение:** `parseCountdownSeconds("1:60") === 120`; строка с минутами
из трёх цифр может матчиться по внутреннему двухзначному фрагменту. При смене
формата сайта это искажает решение requeue.

### 8. В `auto-start` остался wildcard scan

`src/content/features/auto-start.ts` всё ещё выполняет один
`querySelectorAll("*")` для fallback поиска стартовой кнопки. Это нарушает
§4.1/§4.2 и может дорого сканировать большой modal subtree.

### 9. Неполный отдельный hotkey gate

`role-faker` проверяет code/typing/modifiers, но не `e.repeat` в отдельном
keydown blocker. Зажатая клавиша нарушает буквальный инвариант §4.5.

### 10. Два lifecycle tail

- `role-marker`: `setTimeout(0)` может прикрепить outside listeners уже после
  `disable()`, потому что callback не отменяется.
- `auto-start`: отложенный webcam click не имеет teardown handle и может
  выстрелить после выключения фичи.

## Что не покрыто

- Реальный Firefox 121 event-page/WebSocket idle и Chrome 116 SW termination:
  platform premise нельзя доказать jsdom/fake timers.
- Store/XPI update с уже открытой игрой, session restore ordering и sleep-delayed
  alarms требуют установленного расширения в настоящих браузерах.
- OBS Studio, две реальные игровые вкладки, камера/GPU и main-thread profile.
- Живые socket.io queue operations намеренно не выполняются: им нужны
  `authKey`/session, и тест мог бы поставить аккаунт в настоящую очередь.
- Contract parser проверяет class/string/API presence, но не доказывает DOM
  nesting, visibility и semantic target каждого generic selector.
- Lifecycle static check — эвристика: DOM-owned handlers учитываются allowlist;
  semantic teardown дополнительно остаётся предметом review.
- Полный round-trip popup backup и match renderer пока не вынесены в чистые
  planners; их тест потребовал бы более крупного production refactor.

## Зависимости

После установки npm сообщил 14 известных vulnerabilities в полном dependency
tree (1 low, 4 moderate, 6 high, 3 critical). Автоматический `npm audit fix`
не запускался: он мог бы менять существующий build/release toolchain и выходит
за рамки тестовой задачи.
