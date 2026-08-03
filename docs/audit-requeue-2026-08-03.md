# Адверсариальный аудит автовозврата — 03.08.2026

## Резюме

Проверен production `9.2.1` на commit `aa5f36c`. Production-код не менялся.
Жалоба подтверждена: цепочка имеет несколько независимых liveness-разрывов,
которые не требуют изменения сайта и воспроизводятся при замёрзшем DOM.

- КРИТИЧНО: 3.
- ВАЖНО: 5.
- МЕЛОЧЬ: 1.
- Доказанная причина этапа 2: transient готовность может появиться и исчезнуть
  внутри 250-мс debounce; фича не анализирует mutation batch и видит только
  финальный DOM без Ready.
- Наиболее вероятная причина этапа 1: после transient return нет собственного
  таймера. Если DOM не мутирует, не наступают ни повторный клик, ни проверка
  восьмисекундного deadline, ни terminal log.
- Существующие 21 unit-тест проходят, потому что тест вручную вызывает
  subscriber после каждой интересующей смены DOM. Production такой гарантии не
  имеет.

## Свежие контракты сайта

03.08.2026 заново скачаны и отформатированы командой
`npx prettier --parser babel`. SHA-256 совпадают с
`tests/fixtures/site-contract.json`:

| Bundle | SHA-256 |
|---|---|
| `https://polemicagame.com/bundle/game-search.js` | `57238ece03a6f583cbb5cfff1c54d0d3360b89d1c3e736a5b7a06c6f883b98d4` |
| `https://polemicagame.com/room/bundle/main.js` | `92b45577b8a2be9638f4cd7b2b44413a017939077960be448ecf0f125873a4b0` |

Ниже `game-search.pretty.js` и `room-main.pretty.js` означают результат этого
форматирования; строки воспроизводимы из указанных URL и SHA.

Подтверждённая семантика:

- поиск получает `searchState.group.timer.{passed,duration}` от сервера и без
  верхнего clamp передаёт остаток в `startStopwatch()`:
  `game-search.pretty.js:50065-50072`, `49730-49756`;
- принятие — `.p-play__profile-accept`, принятый игрок имеет
  `group.ready=true`, из-за чего исчезает `cursor-pointer`:
  `game-search.pretty.js:47377-47422`, `49624-49631`;
- `on_stop_game_search(reason=game_not_accepted)` сбрасывает фазу и вызывает
  `window.location.reload()`: `game-search.pretty.js:50226-50242`;
- `on_game_disbandment` только запускает серверный `t.time`:
  `room-main.pretty.js:40002-40004`;
- сайт обновляет `disbandmentTimer` из animation callback и очищает строку при
  `e<=0` либо `gameDidStart`: `room-main.pretty.js:45876-45890`;
- `voting_finished(type=game_start)` скрывает голосование и сбрасывает всем
  `votingReadyStatus=false`: `room-main.pretty.js:40343-40351`;
- кнопка готовности существует только при `inProgress` и получает `active` из
  `voted`: `room-main.pretty.js:46349-46377`;
- `.player__readiness` зависит от `votingReadyStatus`:
  `room-main.pretty.js:40634`, `44225-44247`.

## Находки

### RQ-1 — КРИТИЧНО: hidden catch-up оставляет stale countdown и имитирует старт

**Сценарий отказа:** roomTick последний раз прочитал `00:28`, после чего вкладка
стала hidden. Сайт останавливает animation loop. Игрок возвращается позже чем
через 28 с; одним callback сайт вычитает весь elapsed interval, присваивает
вычисленное значение и сразу `""`. Vue может свернуть обе записи в один render и
удалить timer без промежуточного DOM `00:00`. Расширение всё ещё хранит `28>3`,
объявляет старт матча, очищает bridge и навсегда прекращает возврат.

**Доказательство:** сайт выключает loop при hidden и на visible одним callback
передаёт весь elapsed: `room-main.pretty.js:58424-58449`, `58452-58468`.
Countdown в одном callback сначала вычисляется, затем очищается при `e<=0`:
`45876-45890`; условный render удаляет timer: `45962-45972`. Расширение хранит
последний sample без времени: `src/content/features/queue-requeue.ts:272-274`,
а `>3` необратимо ставит `gameStarted`: `282-291`.

Для обычной видимой вкладки гипотеза про ненаблюдаемый текст **отклонена**:
Vue 3 TEXT patch вызывает `setElementText` (`room-main.pretty.js:25215-25229`),
то есть `element.textContent=value` (`26626-26633`) и наблюдаемый `childList`.
Проблема специфична для hidden catch-up без промежуточного render.

**Фикс:** хранить `disbandmentLastSampleAt`. После hidden interval либо stale
sample нельзя использовать `>3` как доказательство старта. Если timer исчез,
перейти в существующий grace: появившаяся игровая стадия докажет start; отсутствие
стадии после grace докажет disbandment. Не добавлять второй observer.

**Лог:** один `info: "отсчёт исчез после hidden-паузы; ждём подтверждение
стадии"`, затем один outcome `match_started|disbanded`. Raw timestamps и каждый
sample не писать.

**Мутационный тест:** sample `00:28`, скрыть document больше чем на 28 с,
восстановить visibility и удалить timer без промежуточного текста. После grace
при отсутствии running-stage должен произойти exit. Удаление freshness gate
возвращает ложный `gameStarted` и обязано красить тест.

### RQ-2 — КРИТИЧНО: подтверждённая готовность может исчезнуть до latch

**Сценарий отказа:** игрок нажимает «Готов» в последние 250 мс окна. Сайт
получает `update_voting`, на мгновение ставит `voted/active` и
`votingReadyStatus=true`, затем получает `voting_finished`, удаляет кнопку и
сбрасывает отметку. Shared observer объединяет мутации в один проход; `roomTick`
ресканирует уже финальный DOM, получает `readyConfirmed()=false` и на строке 256
навсегда останавливается перед мостом. Отсчёт роспуска уже может быть виден.

**Доказательство:** debounce минимум 250 мс:
`src/core/dom.ts:55-58`, `126-136`. Mutation records передаются subscriber, но
фича их игнорирует: `src/core/dom.ts:139-152`,
`src/content/features/queue-requeue.ts:640`. Готовность латчится только текущим
DOM-снимком в `roomTick()`: `src/content/features/queue-requeue.ts:204-217`,
`241-256`. Сайт сбрасывает оба визуальных признака на `voting_finished`, как
показано в контракте выше.

Аналогичное узкое окно есть на этапе 1: accepted DOM может появиться и исчезнуть
до одного delayed flush; `accepted/acceptArmed` ставятся только при текущем
`.p-play__profile-accept` без `cursor-pointer`:
`src/content/features/queue-requeue.ts:489-507`.

**Фикс:** латчить пользовательское намерение синхронно delegated click-listener
на exact ready-button: если trusted click пришёл по неактивной кнопке «Готов»,
игрок выполнил предохранитель до того, как Vue и debounce успеют убрать DOM.
`onDomChange` дополнительно может распознавать добавленный readiness node из
сохранённых `addedNodes`; полагаться на class history нельзя, потому что общий
observer не запрашивает `attributeOldValue`. Отдельный observer запрещён.

Для stage 1 batch/monitor не спасает reload до flush. Pending надо ставить
синхронно на trusted exact click по ещё не принятому
`.p-play__profile-accept`: это фиксирует действие «Принять», а не более поздний
DOM. Автоклик расширения должен вызывать прямой internal hook только после
успешного синхронного click dispatch (`safeClick()===true` либо не бросивший
`.click()`), а не приниматься по любому untrusted DOM event, который может
сгенерировать страница. Серверный ответ не обгонит текущий JS stack. Это слегка
меняет доказательство с server-confirmed state на explicit
accept intent и требует отдельного продуктового решения; substring/общий click
не допускается.

**Лог:** если countdown появился при `roomReady=false`, после короткого окна
наблюдения один `warn: "роспуск начался, но подтверждение готовности не было
зафиксировано"`; при transient latch один `info: "готовность подтверждена по
переходу DOM"`.

**Мутационный тест:** trusted click по точной неактивной Ready-button, затем до
единственного subscriber flush удалить controls/readiness и показать countdown.
Мост обязан взвестись; удаление synchronous click latch ломает тест. Отдельный
stage-1 тест вызывает exact accept click и немедленный page unload до flush:
pending уже обязан существовать. Общий click либо кнопка «Не готов» не должны
взводить состояние; thrown `.click()` и `safeClick=false` не вызывают hook.
Поскольку jsdom не позволяет сконструировать `isTrusted=true`, action handler
нужно вынести в чистую функцию и тестировать напрямую; wiring отдельно защищает
static/integration проверка listener с обязательным `event.isTrusted`.

### RQ-3 — КРИТИЧНО: deadline и retry на поиске не имеют источника тиков

**Сценарий отказа:** после reload принятый bridge взводит `accepted`, но кнопка
«Играть» ещё скелетон/невидима. `tick()` возвращает. Если DOM застыл, через 8 с
ничего не произойдёт: deadline проверяется только при следующем tick. То же
после первого `safeClick`: если сайт не меняет DOM, попытки 2–3 не наступят.

**Доказательство:** `onDomChange` не polling; таймер в `dom.ts` лишь flush-ит
уже полученную mutation: `src/core/dom.ts:83-91`, `116-137`. У фичи есть только
room `graceTimer`: `src/content/features/queue-requeue.ts:144-145`, `297-301`.
Без своего wake-up возвращают:

- skeleton/невидимая кнопка: `queue-requeue.ts:562-563`;
- пауза между кликами: `queue-requeue.ts:576`;
- trusted backoff: `queue-requeue.ts:578-585`;
- успешный вызов `safeClick`, после которого ожидается mutation:
  `queue-requeue.ts:593-608`.

Даже terminal «окно вышло» на `queue-requeue.ts:542-551` недостижим без нового
tick. Boolean `safeClick()` игнорируется.

**Фикс:** один lifecycle-managed decision timer, который планирует ближайший из
deadline окна, окончания `MIN_CLICK_INTERVAL_MS` и окончания
`USER_BACKOFF_MS`. После каждого click планировать проверку результата, даже
если DOM не изменился. Таймер именованный, коалесцированный и снимается в
`disable()`, reset, route transition и при доказанном успехе.

**Лог:** `warn: "автовозврат остановлен: DOM не изменился после N попыток"`;
при `safeClick=false` — bounded `warn` с attempt без Error.message. Уже
существующий deadline log станет реально достижимым.

**Мутационные тесты:** при полностью замороженном DOM fake timers должны:

1. довести отсутствующую Play-button до восьмисекундного terminal log;
2. выполнить ровно три попытки с интервалом не меньше 1200 мс;
3. возобновить решение после двухсекундного trusted backoff.

Удаление любой `scheduleDecision()` после соответствующего return/click обязано
ломать свой тест.

### RQ-4 — ВАЖНО: TTL не связан с серверными длительностями

**Контрактный риск этапа 1:** pending ставится сразу после принятия, но reload происходит
только в конце серверного `group.timer.duration`. Клиент не ограничивает
duration сверху. При раннем принятии окно 45 с уже полностью съедает TTL, а
reload и загрузка content script гарантированно добавляют время. На новой
странице `consumePendingFromRoom()` удаляет метку, объявляет её устаревшей и не
взводит автоклик.

**Сценарий этапа 2:** pending ставится при первом появлении серверного countdown.
Если countdown длится больше 45 с, игрок или сайт уходит на главную до нашей
ветки exit либо выход задержан hidden/backoff, `elsewhereTick()` видит stale
метку и ничего не делает. Обновление перед extension-initiated exit на строке
341 спасает только один happy path.

**Доказательство:** единственный stage-1 arm:
`src/content/features/queue-requeue.ts:502-506`; room arm при первом timer:
`258-266`; refresh перед своим exit: `340-353`; TTL и consumers:
`88-91`, `397-417`, `425-454`. Bundle передаёт серверный duration без верхней
границы: `game-search.pretty.js:50065-50072`. Room countdown также принимает
серверный `t.time`: `room-main.pretty.js:40002-40004`, `45876-45890`.
Свежего реального payload с `duration>45с` получить без живой авторизованной
сессии не удалось, поэтому это не объявляется доказанной причиной текущей
жалобы. Доказан именно рассинхрон контрактов: client допускает любую
длительность, extension предполагает максимум 45 с.

**Фикс:** освежать pending на каждом доступном тике, пока подтверждённое условие
живо. Для stage 1 нужен отдельный bounded refresh deadline: ранняя ветка accept
block `489-507` должна планировать его через owned decision timer RQ-3, потому
что Vue 2 обновляет stopwatch text node через `textContent`
(`game-search.pretty.js:47404-47409`, `34231-34233`), то есть
`characterData`, которую наш observer не слушает. Stage 2 получает `childList`
примерно раз в секунду от Vue 3 countdown.
Хранить валидируемые `issuedAt` и `refreshedAt`: sliding TTL считается от
последнего подтверждения, абсолютный cap — от `issuedAt` и переживает reload.
Один перезаписываемый timestamp не обеспечивает hard cap, а `sessionStorage`
недоверенный.

**Лог:** если значение действительно присутствует, consumer на root и search
обязан различать `corrupt|future|expired|storage_unavailable`; age писать только
bounded bucket, не raw timestamp. Обычный `missing` на каждом root tick не
логировать. Причины должны иметь per-episode latch. Сейчас search пишет
stale/corrupt, а root молчит:
`queue-requeue.ts:406-415`, `425-449`.

**Мутационный тест:** контрактный server countdown 60 с, pending впервые создан
на старте; повторные production-like `element.textContent=...` будят room ticks
и освежают `refreshedAt`. После окончания, 12-секундного grace и навигации
search consumer обязан принять метку, но отвергнуть episode старше hard cap.
Удаление refresh на room/search decision tick должно протухать метку и красить
тест. Отдельно проверить 44 999/45 001 мс, future, `NaN`, перепутанные
`issuedAt/refreshedAt` и storage throw.

Отдельный stage-1 тест держит accepted block больше 45 с без наблюдаемых
mutations, затем моделирует reload. Bridge обязан быть свежим в пределах hard
cap; удаление accept-branch refresh deadline должно сломать тест.

### RQ-5 — ВАЖНО: общий `.error` не доказывает именно развал лобби

**Сценарий отказа:** готового игрока исключили (`on_self_strike`, включая
`kicked_out`) до старта. Сайт показывает error с двумя href: home и search.
Наш `roomDeadLink=.error a[href='/game-search']` считает это смертью лобби,
ставит bridge, кликает search и затем может автоматически вернуть исключённого
игрока в очередь. Это нарушает смысл серверного исключения.

**Доказательство:** selector:
`src/core/selectors.ts:92-95`; действие по любому deadLink:
`src/content/features/queue-requeue.ts:305-319`, `340-353`. Bundle для pre-start
`on_self_strike` всегда вызывает `breakConnection()` и показывает home+search:
`room-main.pretty.js:40161-40197`. В отличие от него обычный `on_stop_game`
через 2 с показывает одну основную search-link:
`room-main.pretty.js:40411-40434`.

**Фикс:** не считать любой search href доказательством disbandment. Надёжный
путь — `disbandmentSeen`; для direct `on_stop_game` разрешать только узкую DOM
форму error без retry и без альтернативной main home-link. Любая неоднозначная
ошибка остаётся пользователю. Тексты сервера и substring matching не применять.

**Лог:** `info: "автовозврат не выполнен: terminal room error не подтверждает
развал"` с category `retryable|kicked_or_ambiguous|session_dropped`, если
категорию можно вывести из структуры DOM без текста.

**Мутационный тест:** ready + error с main home/search links не должен ставить
bridge; ready + узкая форма `on_stop_game` с единственной search-link должен.
Ослабление structural gate до одного `querySelector(roomDeadLink)` обязано
сломать первый тест.

### RQ-6 — ВАЖНО: foreground и trusted backoff могут навсегда остановить exit

**Сценарий отказа:** распущенная комната замёрзла в фоне. Игрок возвращает фокус
кликом в страницу. Возможны два порядка:

1. `pointerdown` обновляет `lastTrustedInputAt`, затем единственный
   `visibilitychange` tick попадает в backoff и возвращает без таймера;
2. `visibilitychange` синхронно вызывает tick раньше pointerdown и навигирует
   поперёк действия пользователя, обходя предохранитель.

Тот же no-retry есть на root в `elsewhereTick()`.

**Доказательство:** trusted listener:
`src/content/features/queue-requeue.ts:617-622`; visibility listener сразу
вызывает tick: `626-637`; room backoff: `322-337`; root hidden/backoff:
`397-417`. У `document.hidden` есть wake-up от visibilitychange, но после
следующего trusted return нового источника событий уже нет.

**Фикс:** trusted backoff всегда планирует wake-up на остаток двух секунд через
общий decision timer RQ-3. Для требуемого сценария focus-click допустим короткий
foreground grace перед первым решением: он даёт page `pointerdown` попасть в
backoff. Переключение через browser chrome без page input само по себе не должно
считаться пользовательским действием внутри страницы.

**Лог:** один `info` на переход состояния:
`"вкладка вернулась на экран — решение отложено на foreground grace"`, затем
ровно один outcome `exit|backoff_expired|context_changed`.

**Мутационный тест:** dispatch visibility restoration, затем trusted
pointerdown без DOM mutations. Синхронной навигации быть не должно; после grace
и backoff должна быть ровно одна навигация. Перестановка обратно на прямой
`tick()` либо удаление scheduled retry обязана сломать тест.

### RQ-7 — ВАЖНО: terminal пути комнаты покрыты неодинаково

Свежий room bundle даёт следующую матрицу до старта матча:

| Путь сайта | Что показывает сайт | Что делает 9.2.1 | Итог игроку |
|---|---|---|---|
| `on_game_disbandment → countdown → on_stop_game` | timer, затем через 2 с error + href search | подвержен hidden catch-up RQ-1, readiness RQ-2 и backoff RQ-6 | может остаться в мёртвой комнате |
| direct `on_stop_game` | через 2 с error + href search | работает только если `roomReady` уже latched; иначе return до deadLink | вручную жмёт search |
| `on_stop_game`, `reason.code=gameOver` | через 2 с прямой redirect на search | без ранее поставленного bridge search не взводится | остаётся на search без автоклика |
| `on_session_dropped` | error, только action reload без href | нет deadLink/grace, return происходит до проверки retry button | вручную reload; автоочереди нет |
| transient `disconnect`: `ping timeout|transport close|transport error`, `socket.active=true` | room скрыт; Socket.IO запускает reconnect | не уходит, что безопасно: комната ещё может жить | видит reconnect UI |
| terminal `disconnect`: `io server disconnect|io client disconnect`, `socket.active=false` | room скрыт; автоматического reconnect нет | нет dead proof, bridge и terminal outcome | может навсегда остаться на скрытой комнате |
| Manager `reconnect_error` после любых попыток | сайт ошибочно подписал handler на Socket, поэтому ожидаемый terminal error после `>4` не появляется | нет собственного watchdog; bridge/outcome отсутствуют | может бесконечно видеть reconnect modal |
| authorization/connect-room/media error | error: href search + action reload | тот же retry veto | вручную выбирает действие |
| pre-start `on_self_strike/kicked_out` | error: home + search | ошибочно может requeue по RQ-5 | серверное исключение обходится автокликом |
| temporary `connect_error`, `socket.active=true` | common connection modal, затем reconnect-attempt modal | не ставит bridge; ждёт recovery, но terminal reconnect handler недостижим | видит переподключение либо бесконечный modal |
| denied `connect_error`, `socket.active=false` | common connection modal; automatic attempt не будет | не ставит bridge и не закрывает episode | может остаться в terminal modal без outcome |
| initial `find-game-for-user` payload/HTTP/no host | error: search + reload | Ready ещё не latched; не вмешивается | вручную выбирает действие |
| localization load failure | error: home + reload | не вмешивается | вручную выбирает действие |
| device failure before connection | common retry modal без search | не вмешивается | вручную retry |
| exception in successful `getUserMedia` path | error: search + reload | Ready обычно ещё не latched; не вмешивается | вручную выбирает действие |

Evidence: socket disconnect/reconnect UI
`room-main.pretty.js:39460-39514`; authorization
`39516-39537`; connect-room error `39643-39658`; session dropped
`40436-40449`; action links без href `40560-40594`; media error
`57215-57246`; `gameOver` redirect `40415-40433`; initial HTTP paths
`32640-32738`; localization failure `32573-32597`; device/common modal
`57196-57207`; media exception `57159-57178`.

Bundle-handler игнорирует `disconnect reason` и `socket.active`:
`room-main.pretty.js:39468-39490`. По контракту Socket.IO v4 automatic reconnect
есть только для `ping timeout|transport close|transport error`; после
`io server disconnect|io client disconnect` нужен явный `socket.connect()`.
Для `connect_error` `socket.active=false` означает отказ сервера без automatic
retry. Источник: Socket.IO v4 Client Socket Instance,
<https://socket.io/docs/v4/client-socket-instance/>.

Кроме того, bundled client — Socket.IO `4.7.5`:
`room-main.pretty.js:58404`. `reconnect_attempt` сайт правильно слушает через
`this.socket.io.on`, но `reconnect_error` ошибочно через `this.socket.on`:
`39481-39514`. Начиная с Socket.IO v3 Socket больше не forward-ит Manager
events; `reconnect_error` существует на `socket.io`. Поэтому ветка
`attemptNumber>4`, `breakConnection()` и terminal error screen фактически
недостижима. Источник: Socket.IO v4 migration/client docs,
<https://socket.io/docs/v4/migrating-from-2-x-to-3-0/>.

Развал **до** нажатия «Готов» должен остаться без автоперехода: это главный
предохранитель от возвращения отсутствующего игрока. Но сейчас единственный
feedback — строка про countdown с `готовность подтверждена: false`, без ответа
в UI: `src/content/features/queue-requeue.ts:249-256`.

**Фикс:** сохранить предохранитель и показать один toast:
`"Возврат не выполнен: вы не подтвердили готовность"` при доказанном terminal
disbandment. Не показывать его в начале countdown, пока игрок ещё может нажать
Ready, и не показывать на reconnect/session errors.
Terminal `socket.active=false` нельзя автоматически превращать в requeue без
причины сервера. Если точная причина нужна в support trail, потребуется узкий
page-world bridge либо site event; по одному скрытому DOM её не выдумывать.
Без такого bridge допустим bounded watchdog с категорией
`room_hidden_no_reconnect_progress`, логом и toast, но без автоклика.

**Лог:** для каждого terminal screen один bounded outcome:
`requeue|not_ready|retryable_connection|ambiguous_error|kicked_guard`.
Молчаливого `return` после доказанной смерти комнаты быть не должно.

**Мутационные тесты:** table-driven DOM fixtures для каждой строки матрицы.
Каждый тест проверяет bridge/navigation/toast и точную terminal category.
Удаление соответствующего structural gate либо категории должно ломать только
свой кейс. Socket lifecycle отдельно параметризуется по `reason` и
`socket.active`: transient-case остаётся открытым до recovery/terminal failure,
terminal-case даёт один no-reconnect outcome и не ставит bridge.
Отдельный emitter-contract тест для зафиксированного v4 поведения посылает пять
`reconnect_error` на Manager и доказывает, что bundle Socket-handler не создаёт
terminal DOM; extension watchdog после bounded no-progress обязан дать outcome
без unsafe requeue. Удаление watchdog должно ломать этот тест.

### RQ-8 — ВАЖНО: текущая наблюдаемость объявляет отсрочку, но не исход

**Сценарий:** пользователь присылает файл после зависания. В нём есть
`"выход ... отложен: игрок только что действовал"` или
`"обнаружен обрыв связи"`, но нет строки, доказывающей, возобновилась ли машина.
На search skeleton вообще нет ни defer, ни terminal строки, потому что deadline
не просыпается.

**Доказательство:** room defer latches:
`src/content/features/queue-requeue.ts:150-157`, `313-337`; search skeleton и
backoff: `562-585`; root storage/backoff возвращают молча: `397-415`.
Статический observability-тест проверяет наличие строк в source, но не их
достижимость: `tests/invariants/observability.test.ts:9-50`.

**Фикс:** создать bounded episode только после arm/condition; обычное отсутствие
pending на root эпизодом не является и не логируется. Каждый defer-state внутри
эпизода должен иметь не больше одного парного persisted outcome; episode
закрывается success, terminal decision, disable или route change. Unload с
живым bridge продолжает тот же trail на следующей странице. Минимальный trail:

`armed(source) → condition confirmed → defer(reason, deadline) → wake(source) →
decision(click|success|not_ready|ambiguous|expired|budget_exhausted)`.

Не писать timer ticks, DOM text, raw timestamps, URL, ники или server message.

**Мутационный тест:** для каждой RQ-1..7 fault injection проверять не только
action, но и ровно одну terminal `info|warn`. Удаление outcome log при сохранном
поведении должно красить observability-тест. Сто DOM flush без pending должны
дать ноль строк; это мутационная защита от логирования `missing` на каждом tick.

### RQ-9 — МЕЛОЧЬ: state machine не route-safe внутри одного document

**Сценарий:** если комната станет SPA либо сайт начнёт переводить на search через
history API, `gameStarted`, `roomExitDone`, `elsewhereDone` переживут route и
подавят следующий эпизод. Pending потребляется только в `enable()`, а центральный
роутер queue-requeue не синхронизирует.

**Доказательство:** состояние и собственный комментарий о риске:
`src/content/features/queue-requeue.ts:120-149`; search reset не сбрасывает room
state: `464-486`; consume только на enable: `638-641`; router синхронизирует
queue-guard/connection-diag, но не requeue: `src/content/index.ts:53-75`.
Текущий POST/full reload сайта маскирует дефект, поэтому severity низкая.

**Фикс:** route-sync с reset per-episode state и consume bridge при входе на
search. Не ждать будущего перехода сайта, чтобы чинить stale state.

**Лог:** только если route обрывает активный episode:
`info: "эпизод автовозврата сброшен: route changed"`.

**Мутационный тест:** в одном document пройти running room → root → second room
и room → SPA search с pending. Удаление route reset/consume обязано оставить
старый latch и сломать тест.

## Полный аудит return без ретрая

### `roomTick()`

| Return | Что разбудит при frozen DOM | Вердикт |
|---|---|---|
| settings off / `gameStarted` (`222-223`) | ничего | terminal safe для текущей full-load route; SPA-риск RQ-9 |
| доказанный running match (`225-238`) | ничего | terminal safe, мост очищен |
| `!roomReady` (`256`) | только новая mutation | баг RQ-2; transient ready уже мог исчезнуть |
| `roomExitDone` (`256`) | navigation | safe после инициированного exit |
| timer visible (`258-275`) | visible countdown создаёт `childList` примерно раз в секунду | hidden catch-up может пропустить финальные samples, RQ-1 |
| seconds `>3` (`282-291`) | ничего | unsafe, если sample старше hidden interval, RQ-1 |
| первое исчезновение timer (`279-302`) | собственный `graceTimer` | корректный owned wake-up |
| dead proof ещё нет / grace не истёк (`305-309`) | тот же graceTimer, если timer исчез | safe в countdown path |
| retry screen (`313-319`) | только mutation/recovery | deliberate safety hold; terminal category обязана быть в логе |
| `document.hidden` (`325-330`) | `visibilitychange` | wake-up есть, но foreground race RQ-6 |
| trusted backoff (`332-337`) | ничего | баг RQ-6 |

### `tick()` на search

| Return | Что разбудит при frozen DOM | Вердикт |
|---|---|---|
| settings off / dispatcher (`476-486`) | не требуется | safe |
| accept block (`489-507`) | mutation/reload | transient-latch и TTL риски RQ-2/RQ-4; нужен refresh deadline |
| `!accepted` (`509`) | mutation | safe по предохранителю |
| search timer (`512-522`) | не требуется | terminal success |
| game loader (`524-537`) | mutation/navigation | safe не вмешиваться, но stuck loader не имеет outcome |
| arm deadline (`542-551`) | не требуется | terminal safe, если до ветки дошёл |
| site modal (`554-559`) | state уже reset | terminal safe и logged; решение передано игроку |
| Play skeleton/invisible (`562-563`) | ничего | баг RQ-3 |
| Play disabled / budget (`564-574`) | ничего | terminal safe и logged |
| click interval (`576`) | ничего | баг RQ-3 |
| trusted backoff (`578-585`) | ничего | баг RQ-3 |
| `document.hidden` (`587-592`) | `visibilitychange` | wake-up есть; foreground race RQ-6 |
| после `safeClick` (`593-608`) | только mutation | баг RQ-3 |

### `elsewhereTick()`

| Return | Что разбудит при frozen DOM | Вердикт |
|---|---|---|
| settings/off-route/no bridge (`398-403`, `412`) | не требуется | safe policy |
| hidden (`404`) | `visibilitychange` | wake-up есть, foreground race RQ-6 |
| trusted backoff (`405`) | ничего | баг RQ-6 |
| storage exception (`407-411`) | ничего | capability terminal, но silent, RQ-8 |
| bad/stale mark (`413-414`) | ничего | safety terminal, но mark не очищен и причина silent |
| navigation (`415-417`) | page load | safe |

## Приоритет исправления

1. Добавить единый owned decision timer с lifecycle cleanup.
2. Закрыть transient readiness/accept latch синхронным exact action signal.
3. Освежать pending по живому условию и отделить sliding freshness от hard cap.
4. Ввести foreground grace и scheduled backoff wake-up.
5. Разделить disbandment и неоднозначные error screens.
6. Добавить terminal toast для доказанного disbandment без Ready.
7. Закрыть complaint trail и route reset.

До исправления RQ-1–RQ-3 версия 9.2.1 не может считаться имеющей надёжный
автовозврат: happy-path тесты доказывают только логику при искусственно
гарантированных тиках, но не liveness production-машины.
