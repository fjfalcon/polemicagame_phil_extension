# Карта стоимости Polemica Notes — 06.08.2026

## Резюме

Статически проверен commit `2e7aeac` без изменения production-кода. Модель:

- foreground игровая комната, 10 игроков и 10 video;
- сайт непрерывно меняет `class/style` индикаторов звука;
- SharedDomObserver работает на предельных 4 flush/с;
- отдельно указаны default-настройки и optional worst case;
- живой CPU-profile не подменяется статической оценкой.

Главные расходы по произведению `частота × стоимость × вероятность`:

1. **P0, default:** player-notes relevant `childList` запускает полный проход по всем
   плиткам: для 10 стабильных tiles примерно 14 QSA + 130 QS за pass; вместе с
   fallback saturation bound достигает 63 QSA + 585 QS/с.
2. **P0, optional:** OBS и Twitch visibility subscribers без batch-filter суммарно делают
   до 24 document-wide QSA/с на любой route.
3. **P0, default:** auto-accept на поиске делает 6 document-wide QSA за scan, до 5
   scans/с, то есть 30 QSA/с плюс два `O(n²)` deepest-only filter.
4. **P0, optional:** OBS auto-mode не route-gated: на `/game-search` при обычном
   foreground cadence он каждые 2 с может
   сериализовать `document.body.textContent` дважды и способен подтвердить day
   и переключить OBS scene вне игры.
5. **P1, default:** auto-game polling вне игровой комнаты делает nominal 3
   document QS/с, saturation bound с relevant childList - до 15 QS/с.
6. **P1, optional:** requeue refresh выполняет synchronous
   `sessionStorage get → parse → stringify → set` на каждом room/search tick,
   до 4–4.1 writes/с при churn.
7. **P1, optional:** Twitch создаёт два initial sockets, не отключается после
   ухода из game UI и продолжает WS/IRC/DOM work скрытой панелью.
8. **P1, optional:** background OBS делает 240 `GetVersion`/час в connected state,
   пишет connection state 240 раз/час и после исчерпания 10 retries продолжает
   watchdog attempts без общего бюджета.

Значения 4-5 scans/с - saturation upper bounds при relevant mutation на каждом
flush, а не измеренный steady state. Default-находки относятся к настройкам из
`DEFAULT_SETTINGS`; OBS, Twitch и requeue выключены по умолчанию.

Положительные защиты реально работают: один observer, 250мс throttle, cap 4000,
нет production `querySelectorAll("*")`, idempotent style writes в основных
циклах, caches notes indexes живут между flush, network requests в notes
дедуплицированы. Они перечислены в «Проверено и чисто», не как находки.

## Модель Частоты

Shared observer: `src/core/dom.ts:41-58,81-169`.

| Режим | Recurring extension timers + scheduled flushes | Subscriber invocations |
|---|---:|---:|
| Default room, непрерывный attr churn | subscriber flush ≤4/с + router 2/с + player fallback 0.5/с + auto accept route-check 1/с + auto game scan 1/с + orphan watch 0.1/с = до **8.6 scheduled callbacks/с** | 4 subscribers × 4 flush = до **16 calls/с** |
| Default search, churn | тот же верх 8.6/с; queue guard не создаёт timer | 5 subscribers × 4 = до **20 calls/с** |
| Fully optional room | базовые callbacks + OBS nominal 0.5/с + Twitch nominal 1/60с + state-machine timers | 11 active subscribers, до **44 calls/с** |
| Fully optional search/match | базовые 11 плюс соответственно route-specific queue guard или match stats | до 12 active subscribers, до **48 calls/с** |
| Hidden tab с mutations | intended delay 500мс, но browser throttling не гарантирует 2 flush/с | не более nominal 2 × active subscribers; есть scheduling race ниже |
| Background OBS disabled | zero recurring alarms/timers | SW wake только по внешнему event |
| Background OBS connected | heartbeat 3/min + alarm probe 1/min | 4 OBS request/response pairs/min |

`subscriber invocation` не равен full scan: многие callbacks сначала проверяют
batch или route. Таблица ниже разделяет фильтр и reconciliation.
Отдельно browser вызывает callback самого MutationObserver с site-defined
частотой: каждый delivery добавляет records в bounded pending queue и вызывает
дешёвый `schedule()`. Throttle 250мс ограничивает только subscriber `flush()`,
но не число mutation delivery callbacks; статически их частоту ограничить нельзя.

## 1. Инвентарь onDomChange

Всего 13 production subscriptions; `grep` даёт ещё definition в `core/dom.ts`.

| Подписчик | Работа на каждый flush | Ранний выход / batch filter | Узлы и worst frequency |
|---|---|---|---|
| Player notes `player-notes.ts:387-417,3294-3342` | Обход mutation batch; при relevant childList вызывает full `processExistingElements()` | Attribute records пропускаются; target/added/removed проверяются через `closest/matches/querySelector`; first hit stops | Negative batch до 4000 `closest` + subtree probes; relevant pass до 4/с, плюс fallback 0.5/с |
| Auto-accept `auto-start.ts:335-351` | `muts.some(addedNodes)`; ставит 250мс scan timer | Attr-only batch дешёвый; один pending timer | Full scan максимум 4/с observer + 1/с interval |
| Auto game `auto-start.ts:1179-1213` | На addedNodes вызывает start-modal, webcam, role-phase scans | Attr-only batch дешёвый; **route gate отсутствует** | До 4 full game scans/с на childList + 1/с interval на всех routes |
| Tooltip `tooltip.ts:388-436` | Для каждого added Element: `matches` + subtree QSA dot selector | Attribute-only только loop batch; removedNodes не анализируются; route gate нет | `O(records + added elements + Σ subtree)`; overlapping subtree rescans |
| Queue guard `queue-guard.ts:143-156` | Если hidden, один search-timer QS и arm/disarm | Foreground immediate return | Nominal до 2 hidden QS/с до browser throttling; no local timer |
| Queue peek `queue-peek.ts:126-167,833-870,908-929` | `ensureButton()`: panel/button/anchor + 3 state QS, compareDocumentPosition | Нет batch/route filter до внутренних checks | Stable button: 6 QS/flush = **24 QS/с** |
| Queue requeue `queue-requeue.ts:318-542,837-921,1030` | Полный `tick()` route state machine | Setting выключает feature целиком; batch не фильтруется | Room/search до 4 ticks/с; timer добавляет 0.1–3.3 ticks/с по deadline |
| OBS phase `obs-panel.ts:1075-1117` | Для каждого record `closest(PHASE_SCOPE)`; added Element `matches/querySelector`; relevant → debounce detection | Break на first relevant; **до него нет inspection cap**; route gate нет | Capped batch: до 4000 closest/flush = 16k/s visible |
| OBS panel UI `obs-panel.ts:1146-1208` | 150мс debounce, затем `hasActiveGameInterface()` | Нет mutation criterion/route gate | 3 document QSA × 4 = **12 full QSA/с** |
| Twitch UI `twitch-panel.ts:166-178,1186-1194` | Immediate `hasActiveGameInterface()` | Нет batch/route filter | 3 document QSA × 4 = **12 full QSA/с** |
| Role faker `role-faker.ts:157-171` | Два document scans role/menu, closest и conditional style fixes | Subscription существует только пока role faked | До 8 full QSA/с в fake mode |
| Role marker `role-marker.ts:320-349` | Любой flush ставит 250мс timer; scan всех `.player`, per-player marker/name queries | Один timer pending; batch не фильтруется | До 4 scans/с; 10-player O(10) DOM walk |
| Match stats route `match-stats.ts:1572-1616` | Пока есть pending data: route/time gates, readiness checks, потом enhance | Только exact `/match`; no pending → O(1) | Не работает в room/search; retry ≤2/с pending |

### Стоимость Player Notes Pass

Для 10 stable tiles, rotate+mute+hide controls включены, ring у каждого:

| Операция | На pass | При 4 observer pass/с + fallback 0.5/с |
|---|---:|---:|
| Global QSA | 4 | 18/с |
| Per-tile media QSA | 10 | 45/с |
| **Всего QSA** | **14** | **63/с** |
| QS: names + stable controls + ring owner | примерно 130 | **585/с** |
| getComputedStyle/layout stable | 0 | 0 |
| DOM writes stable | 0 | 0 |

Доказательство: `player-notes.ts:1114-1126,1998-2029,3332-3472`.
Это **верх relevant-childList**, не цена чистого `class/style` churn: attribute-only
batch проходит только mutation filter. Реалистичный риск — Vue перестраивает
video/player subtree параллельно со style-анимацией, и тогда каждый flush relevant.

Search с `P=30` participant rows: 4 QSA + `2P` QS/pass, то есть worst 18 QSA
и 270 QS/с с fallback. Profile stable pass: 4 QSA + 5–6 QS, но остаётся
безусловный `button.style.position="relative"` на каждом pass:
`player-notes.ts:1831-1845`.

### Auto-Accept Scan

`clickAcceptButtons()` делает ровно 6 document QSA:

1. broad clickable/accept candidates;
2. all `button`;
3. primary accept selector;
4. wrapper descendants;
5. `div.cursor-pointer`;
6. `.p-play__profile-accept`.

Refs: `auto-start.ts:96-143,184-290`; selectors `selectors.ts:45-49,130`.
Каждый candidate создаёт normalized strings; exact matches делают `closest`;
два массива проходят `some(contains)` deepest-only, то есть `O(M²)+O(U²)`.
Final targets вызывают `isVisible` = computed style + bounding rect.

| Источник | Scans/с | QSA/с |
|---|---:|---:|
| Interval | 1 | 6 |
| Observer added-node debounce | до 4 | до 24 |
| Combined upper bound | **5** | **30** |

Interval и observer не используют общий scheduler, поэтому соседние scans не
коалесцируются.

### OBS Phase Filter

`PHASE_SCOPE` filter лучше прежнего unconditional full detect, но его собственная
стоимость линейна всему retained batch:

- до 4000 `closest()` ancestor walks на flush;
- до 4000 `matches()` и subtree `querySelector()` при одном added Element на
  record;
- до 16 000 closest/с foreground; 8000/с hidden - только nominal предел при
  исполнении 500мс timer без дополнительного browser throttling;
- subtree work = сумма размеров added subtrees, не только record count.

Refs: `obs-panel.ts:1081-1110`; cap `dom.ts:41,83-90`.

Full `detectTimeOfDay()` включает ended visibility/layout, Array.from stage
collection, common-ancestor walks, current/next queries и text normalization:
`obs-panel.ts:667-965`. Без stage container fallback вызывает
`findDeepestTextWith(document.body, ...)` отдельно RU и EN: до двух полных
`document.body.textContent` serializations каждые 2с на **любой** route.

## 2. Таймеры И Частота

### Content: recurring и state-machine loops

| Таймер | Период / предел | Режим и работа |
|---|---|---|
| Shared observer scheduler `dom.ts:103-141` | ≥250мс visible; ≥500мс hidden | Один shared flush; hidden cadence browser-defined, race описан ниже |
| URL router `index.ts:54-94` | 500мс | 2 microtasks/с; unchanged URL = href compare only |
| Orphan watch `orphan-watch.ts:81-101` | 10с | Healthy tick читает `runtime.id` |
| Player notes fallback `player-notes.ts:403-417` | 2с | Tooltip orphan sweep + full route pass, даже на unrelated route |
| Auto-accept `auto-start.ts:335-375` | 1с + observer debounce 250мс | Search full scan; non-search route check only |
| Auto game `auto-start.ts:1179-1219` | 1с + added-node observer | Welcome QS + lobby QS + role gate на всех routes |
| Initial role hide `auto-start.ts:616-643` | 100мс, ≤100 attempts | Обычно один pass; worst 10/с до 10с |
| Webcam switch `auto-start.ts:1080-1118` | 200мс, ≤10 clicks | До 5 QSA/control-identification и clicks/с, ≤2с |
| Role phase/night retries `auto-start.ts:648-699,829-850` | 150мс debounce; 3с + 0.5–1с retries | Bounded <5 retries; два timeout без handles |
| Requeue decision `queue-requeue.ts:118-161` | Один coalesced; floor 50мс | Deadlines 0.3, 1.2, 2.1, 8.25, 10, 12.25с |
| Queue peek HTTP/socket `queue-peek.ts:179-186,296-356` | 5с HTTP; 8с socket; 1.5с stop | Только run; bounded, до 2 sequential WS attempts |
| Queue auto-peek `queue-peek.ts:763-810` | 1.5с one-shot/visibility | Не recurring |
| Connection diag `connection-diag.ts:98-124` | Recursive 5с | Optional, cleaned on route exit |
| OBS fallback `obs-panel.ts:967-1117` | ≥2с + 150/350мс debounce/confirm | **Не route-gated**; visible nominal 0.5 full detect/с, hidden cadence browser-defined |
| OBS panel visibility `obs-panel.ts:1191-1208` | 150мс after flush | Effectively до 4 scans/с |
| Twitch idle `twitch-panel.ts:757-797` | 60с, threshold 6 min | Пока socket active, даже panel hidden |
| Twitch reconnect `twitch-panel.ts:871-891` | 5,10,…30с; ≤10 | Bounded |
| Role marker scan/save `role-marker.ts:133-152,320-375` | 250мс scan; 400мс save | Full player scan; whole-map write |
| Match route readiness `match-stats.ts:1572-1616` | 100мс ≤10с | ≤100 attempts, ≤200 header/table QS |
| Match table wait `match-stats.ts:193-225` | 500мс ≤10с | ≤20 table QS |
| Match auto-height `match-stats.ts:1594-1615` | 5с | Root QS, rows QSA, up to 3 computed styles, title/cell scans |
| Update check `update-notify.ts:154` | one-shot 4с | Network check, not recurring |

UI-only one-shots (toast removal, saved hints, tooltip delay, notifications)
создаются только действием пользователя и не входят в steady-state wake rate.

### Background и alarms

| Механизм | Cadence | Работа |
|---|---:|---|
| OBS heartbeat `background/obs-client.ts:359-367` | 20с | `GetVersion`, request timeout, state write |
| OBS watchdog alarm `background/index.ts:73-80,536-538` | 1 мин | Settings/storage reads + verify/connect |
| OBS reconnect `obs-client.ts:317-356` | 2,4,…20с; 10 attempts | Persist count; WebSocket connect |
| OBS request timeout `obs-client.ts:479-503` | 10с per request | Не clear-ится при success, residual callback |
| Queue guard alarm `background/index.ts:393-452` | one-shot 1 мин | 2 settings reads, tab ping, optional notification |
| Owner ping timeout `background/index.ts:191-202` | 1.5с per contested claim | Не clear-ится при fast response |

OBS disabled + no queue alarm = zero recurring background wakes. Connected OBS:

- 3 heartbeat + 1 watchdog `GetVersion`/мин = 240 request pairs/час;
- 4 `obs_connection_state` writes/мин = 240 writes/час;
- watchdog добавляет примерно 3 storage reads/мин и 1 `alarms.get`/мин;
- WebSocket traffic на Chrome 116 удерживает SW resident вместо обычного idle.

После persisted 10-attempt budget watchdog всё равно вызывает `connect()`;
fresh SW alarm может дополнительно выполнить top-level restore, до двух attempts
на minute wake: `background/index.ts:107-140,695-696`.

## 3. Аллокации

| Hot path | Аллокации |
|---|---|
| Shared observer | До 4000 retained `MutationRecord` refs; новый pending array на flush; один batch shared всеми subscribers (`dom.ts:83-156`) |
| Player notes pass | Array.from players, names array, pending Set/result array даже empty, per-tile signature arrays/strings, lowercase strings, 14 NodeLists |
| Player mutation filter | Up to 4000 closest/matches/subtree NodeLists on negative batch |
| Auto accept | 6 NodeLists→Arrays, normalized strings, Set dedupe, два quadratic `some/contains` passes |
| OBS filter | Up to 4000 ancestor walks and subtree NodeLists; phase detection allocates stages/children arrays and normalized body/stage strings |
| Tooltip observer | NodeList per added Element; overlapping records rescan overlapping subtrees |
| Requeue pending | `JSON.parse` object + `JSON.stringify` string every refresh tick |
| Logs info+ | Rest args array, mapped formatting array, JSON.stringify non-string args, regex redaction, Entry object |
| Match enhance | `O(P+V+A)` phase arrays; `O(PV + DV)` filtering; `O((D+N)P)` DOM nodes; only match route |

`nickIndexCache` и `colorIndexCache` — instance caches с TTL 1с:
`player-notes.ts:795-813,1133-1153`. При continuous passes полный rebuild
notes-map indexes выполняется не чаще примерно 1/с; частоту DOM reconciliation
этот cache не ограничивает. Caches не инвалидируются на все notes-map
replacements, поэтому могут быть stale ≤1с; лишняя invalidation после ID resolve
делает следующий rebuild без изменения notes-derived indexes.

## 4. IO, Storage, Network И Messaging

### Synchronous page storage

`armPending()` (`queue-requeue.ts:544-562`) всегда делает:

`getItem → validate/JSON.parse → refresh object → JSON.stringify → setItem`.

| Состояние | Quiet | Mutation saturation |
|---|---:|---:|
| Accepted search card | decision timer 0.1 write/с | observer до 4/с + timer = **4.1 writes/с** |
| Visible room countdown | site countdown обычно будит observer около 1/с | до **4 writes/с** от unrelated churn |
| Explicit accept | 1 immediate write/click | bounded user action |

Скользящему TTL 45с достаточно refresh раз в 5–10с; mutation-rate write не
добавляет correctness.

### Notes/storage

| IO | Trigger | Cost |
|---|---|---|
| Notes initial load | enable | local get notes/tags/migration; muted-list get |
| Note edit/delete/color | user/lazy migration | runtime message; background full-map get, clone, full-map set, full-map response |
| Cross-tab notes change | each storage event/tab | 4 refresh operations and DOM scans per listening tab |
| Mute/tag edit | user | fresh local get + whole-list/map set |
| Role marks | click burst | immediate full-map set + possible duplicate trailing/pagehide set; cap 50 games |
| Log flush | info traffic | full ring local set, not delta |

Log ring: CAP 600, full-buffer write every 3с under continuous info, urgent error
after 400мс: `core/log.ts:320-390`. At max message 600 code units this is up to
360k message code units plus metadata per write; roughly 20 full writes/min
normal noisy incident, theoretical ~150/min spaced urgent errors.

`debug_logging_enabled=false` disables persistence, но `info+` всё равно
format/redact/buffer; only `log.debug` is skipped before `fmtArgs` by level gate:
`log.ts:369-390`. Disabled debug всё ещё оплачивает evaluation arguments/rest
array at call site, но не JSON serialization внутри logger.

### Network cadence

| Endpoint/path | Cadence/guard |
|---|---|
| `/api/games` | Shared 15с promise/cache; **slow >15с can overlap requests and stale reject clears newer promise** (`player-notes.ts:161-185`) |
| Rating top-1000 | Shared 5 min cache + separate in-flight identity guard |
| Three player stats | Lazy hover, 5 min/player, 30с failure backoff, in-flight dedupe |
| Last games | Lazy hover, 5 min nonempty/1 min empty, in-flight dedupe; failures retry on next hover |
| Match HTML | Once per match-ID transition; AbortController on route change; no timeout/retry |
| Queue peek | Normal 3 HTTP + 1 WS; worst bounded 6 HTTP + 2 sequential WS, each socket ≤8с + stop 1.5с |

Periodic runtime messages не найдены. Queue guard sends arm/cancel transitions;
OBS commands only phase/manual transitions; note operations user-driven.

## 5. Находки

### PERF-1 — P0: player-notes relevant mutation = full global reconciliation

**Evidence:** `player-notes.ts:393-417,3294-3472`.

**Расчёт:** relevant room pass 14 QSA + ~130 QS; saturation bound до 4 observer passes/с +
0.5 fallback = 63 QSA + 585 QS/с. Negative batch до 4000 records сам может
сделать 4000 closest и subtree probes.

**Сценарий:** Vue заменяет player/video subtree на каждом audio/video update;
observer throttle удерживает 4с⁻¹, но каждый flush повторно сканирует все 10
плиток. Main thread конкурирует с media/Vue.

**Направление:** process affected tiles from mutation roots; fallback full sweep
оставить ≤0.5/с. Extension-owned icon/ring child changes не должны trigger full pass.

### PERF-2 — P0: OBS/Twitch global game-UI scans на каждый flush

**Evidence:** `obs-panel.ts:1146-1208`; `twitch-panel.ts:166-178,1186-1194`.

**Расчёт:** каждый subscriber = 3 document QSA × 4 flush/с = 12 QSA/с;
вместе 24/s, 86 400 full selector traversals/hour. Работают вне `/game`.

**Сценарий:** stream features включены, пользователь на search/profile или в
живой комнате; unrelated style churn поддерживает максимальную cadence.

### PERF-3 — P0: auto-accept interval и observer дублируют дорогой scan

**Evidence:** `auto-start.ts:96-143,184-351`.

**Расчёт:** 6 QSA/scan × (1 interval + до 4 observer) = 30 QSA/s плюс quadratic
dedupe и string/closest work.

**Сценарий:** search Vue часто добавляет child nodes; interval попадает рядом с
observer timeout, оба проходят один неизменившийся DOM.

### PERF-4 — P1: default auto-game polling работает вне game route

**Evidence:** `auto-start.ts:875-885,1046-1058,1179-1213,1306-1311`.

**Расчёт:** stable off-game pass делает 1 document QS в `clickStartGameButton`
и до 2 QS в `isInLobby`: nominal interval = 3 QS/с. Relevant added-node flushes
добавляют до 12 QS/с, combined saturation bound - 15 document QS/с.

**Сценарий:** default `skip_start_screen_enabled=true`; пользователь находится
на search/profile, но 1с interval и added-node observer продолжают искать
welcome/lobby markers.

### PERF-5 — P0: OBS phase detector работает вне game route

**Evidence:** monitoring `obs-panel.ts:1075-1142,1291-1317`; fallback body text
`667-809`; switching `967-1067`.

**Расчёт:** visible nominal upper bound 0.5 full detections/с на любой route;
no-stage path до двух body text serializations/detection = 3600 serializations/hour.
Relevant stage churn может дать saturation bound до 4 full detections/с. Hidden
cadence не гарантируется и может быть значительно ниже из-за browser throttling.

**Сценарий:** auto-mode включён, пользователь в поиске; detector fallback day
может не только тратить CPU, но и переключить OBS scene вне игры.

### PERF-6 — P1: sessionStorage refresh привязан к mutation cadence

**Evidence:** `queue-requeue.ts:358-381,544-562,837-861,1030`.

**Расчёт:** до 4 synchronous JSON rewrites/с room и 4.1/с search при TTL 45с.

**Сценарий:** 10 video производят unrelated churn во время countdown; каждый
flush переписывает одинаковый по смыслу mark.

### PERF-7 — P1: Twitch duplicate connect и hidden lifetime

**Evidence:** initial paths `twitch-panel.ts:826-835,1189-1194`; replacement
`904-921`; hide without disconnect `841-853`; reconnect gate `871-891`.

**Расчёт:** 2 initial socket/handshake allocations, первый immediately detached;
далее 60с watchdog, IRC parse и chat DOM продолжаются после route exit.

**Сценарий:** включить Twitch в комнате, затем перейти на search; panel hidden,
но network/DOM work остаётся и chat insertions будят всех subscribers.

### PERF-8 — P1: OBS background probes и budget bypass

**Evidence:** `background/obs-client.ts:317-367,479-503`;
`background/index.ts:73-140,536-538,695-696`.

**Расчёт:** connected 240 probes + 240 state writes/hour. Exhausted state —
1 attempt/min, до 2/min на fresh SW alarm. Request success оставляет no-op 10с
timer, ещё 240 callbacks/hour.

### PERF-9 — P1: match feature timers/styles живут при statistics_enabled=false

**Evidence:** route start `match-stats.ts:1572-1616`; update only removes nodes
`1647-1660`; broad styles `1317-1489`.

**Расчёт:** permanent 5с `applyAutoHeight` loop (720 ticks/hour) на match route,
plus initial 100мс readiness polling до готовности или 10с, несмотря на
выключенный subsetting. 500мс table wait без предшествующего `enhance()` не стартует.

### PERF-10 — P1: hidden observer может застрять за suspended rAF

**Evidence:** `dom.ts:105-111,121-141`.

Foreground throttle timer уже существует; tab hidden; visibility handler не
ставит fallback из-за `timerId`; timer позже очищает ID и ставит rAF, который
hidden browser замораживает. `scheduled=true` блокирует дальнейший schedule.
Cap защищает память, но hidden queue guard/subscribers перестают работать.

### PERF-11 — P1: tooltip scans all added subtrees globally

**Evidence:** `tooltip.ts:388-436`.

**Расчёт:** `O(batch + added elements + Σ subtree)`; one QSA allocation per
added Element, overlapping mutation records могут повторно обходить один subtree.
Always-on feature, no route gate. Removed owner не очищает body tooltip до disable.

### PERF-12 — P2: дополнительные bounded расходы

- `role-marker.ts:291-349`: любой flush → до 4 full player scans/с; game-key
  cache сравнивает pathname, а не same-path `game_id`.
- `pause-hotkey.ts:221-291,462-486`: user-triggered broad candidate scan с
  deepest-only `O(C²)`, повтор до 15 раз за 700мс.
- `player-notes.ts:1831-1845`: unconditional profile style assignment/pass.
- `auto-start.ts:681-698,1213`; `obs-panel.ts:1117`: unnamed one-shot timers.
- `match-stats.ts:1317-1373`: positional CSS misstyles each current table root.
- `role-marker.ts:369-401`: one click + pagehide within 400мс can write full map twice.
- `background/index.ts:282-299`: every browser tab closure reads scene-owner storage.

## 6. Бюджеты И Invariant-Тесты

| Бюджет | Проверка | Мутационный критерий |
|---|---|---|
| Observer core | Exactly one observer; `MAX_PENDING≤4000`; foreground ≥250мс; hidden transition гарантирует timer, не suspended rAF | Добавить observer, поднять cap, снизить delay, вернуть hidden rAF race → fail |
| Subscriber record budget | Один subscriber применяет selector APIs не более чем к 256 records; overflow ставит один debounced reconciliation | Удалить cap/break и пройти 4000 closest → fail |
| Player notes stable room | 10 tiles: ≤14 QSA, ≤130+R QS, 0 layout/computed/write; full pass ≤0.5/с без relevant site identity/media mutation | Unrelated attr/own child mutation запускает full pass или новый selector → fail |
| Player notes cache | Nick/color full-map build ≤1/s; notes-map replacement invalidates once; ID resolution не invalidates без причины | Пересоздать cache/flush или убрать notes invalidation → fail |
| Auto accept | ≤6 QSA/effective scan; interval+observer share scheduler; ≤1 scan/250мс | Одновременный interval+observer даёт 2 scans либо QSA count 7 → fail |
| Search route idle | Auto game polling = 0 вне `isGameRoomPath()`; accept scanner = 0 off search before selectors | Удалить route gate и получить QS/QSA → fail |
| Game UI subscribers | OBS/Twitch full document reconciliation ≤2/с и только внутри `isGameRoomPath()`; unrelated batch = 0 QSA | 100 unrelated batches вызывают QSA или non-game route scans → fail |
| OBS PHASE_SCOPE filter | ≤256 selector probes/batch; fallback body serialization ≤1/detection и 0 вне `isGameRoomPath()` | 4000 records/двойной body text/non-game detection → fail |
| Requeue bridge | Immediate arm/exit + refresh ≤1/5с; 60с countdown остаётся fresh | 100 flush дают >1 write/5с или frozen countdown expires → fail |
| Tooltip | Attribute-only и non-match childList batches = 0 QSA; owner removal removes active body tooltip | Global scan или leaked tooltip → fail |
| Twitch connect | At most one CONNECTING/OPEN socket; выход из `isGameRoomPath()` stops socket/watchdogs; user-hide policy проверяется отдельно | Feature enable creates 2 sockets либо route exit leaves timer/socket → fail |
| Match feature off | `statistics_enabled=false`: zero styles, intervals, delayed rows/inline mutations | Toggle off leaves 5с interval/style → fail |
| Log gate | Level gate before fmt/redaction; full flush ≤1/3с normal; error policy bounded; buffer level не page-controlled | Disabled debug вызывает JSON.stringify; reorder gate; restore buflevel → fail |
| Log IO | Test 600-entry ring: one full write per batch, payload budget explicitly measured | Вторая write <3с без urgent error или unbounded retry → fail |
| Active games request | Separate in-flight marker; never overlap unresolved requests; stale rejection cannot clear newer | Advance 15с with unresolved P1 and observe P2/P3 → fail |
| Background OBS | Connected probe budget ≤3/min total; freshness-write реже текущих 4/min, но как минимум один за интервал меньше `OBS_STATE_MAX_AGE_MS`; heartbeat/watchdog делят freshness; exhausted budget covers alarm/restore; one reconcile/wake | 4 probes/min, timestamp протухает за 2 мин, или 2 connect attempts/alarm → fail |
| Timeout ownership | Successful OBS request and owner ping clear timeout; every feature timer handle cleared on teardown | Residual callback after success/disable → fail |
| FloatingPanel | One rAF/gesture, no layout/storage on pointermove, ≤2 style writes/frame, one persistence on pointerup | Add rect/localStorage in move or multiple rAF → fail |

Статические tests в стиле `tests/invariants/architecture.test.ts` должны считать
call sites/observer options и запрещать known anti-patterns. Cost budgets для
динамических branches лучше проверять jsdom instrumentation wrappers вокруг
`querySelector(All)`, `closest`, `getComputedStyle`, rect и storage.

## 7. Проверено И Чисто

- Ровно один production MutationObserver; один batch array передаётся всем
  subscribers без копий.
- `MAX_PENDING=4000` реально ограничивает retained `MutationRecord` objects;
  число узлов внутри records и размеры удерживаемых поддеревьев этим не ограничены;
  excess - counter, не второй массив.
- Foreground throttle 250мс и slow-flush warning >50мс/не чаще 5с существуют.
- Production `querySelectorAll("*")` отсутствует; найден только комментарий.
- Player-notes attribute-only churn не запускает full tile processing.
- Stable room player pass не делает layout/getComputedStyle и не пишет DOM.
- Ring style/layout reads только при creation/redraw; tooltip geometry только hover.
- `nickIndexCache/colorIndexCache` — реальные instance caches, не создаются на
  каждом flush; full notes-map index rebuild ≤~1/с, но не DOM reconciliation.
- Stats/history/ID network calls не запускаются из DOM scan; основные requests
  имеют TTL/in-flight dedupe и failure backoff.
- Queue-peek HTTP/socket/stop/retry paths bounded; queue guard — one-shot alarm,
  не polling.
- Requeue decision timer один, coalesced, floor 50мс; frozen search deadlines
  покрыты unit tests.
- Auto-accept observer реагирует только на addedNodes, scan timeout named и
  очищается; click targets visibility/budget/scope gated.
- Match enhance не работает в live `/game`; route poll без href change не
  rebuild-ит table.
- Drag/resize rAF-coalesced, no layout/storage per pointermove, listeners symmetric.
- Disabled `log.debug` не вызывает fmtArgs/redaction/JSON внутри logger.
- Notes остаются в storage.local; read failure не превращается в empty map;
  writes background-serialized.
- Background queue alarm хранит tab ID в имени и переживает SW unload; OBS socket
  handlers teardown симметричен.
- OBS disabled + no queue alarm = zero recurring background wakes.

## Приложение: Ручной Замер Владельцем

Живой замер нужен для перевода selector counts в milliseconds, но не для
доказательства структуры выше.

1. Chrome stable, одна fresh profile, DevTools Performance; hardware и browser
   version записать.
2. Один и тот же 2-минутный участок игры: 10 video, обычный speech timer,
   пользователь не двигает панели.
3. Run A: extension 9.4.0 с обычными настройками. Run B: extension disabled и
   page reload. Run C: extension enabled, OBS+Twitch panels enabled.
4. Включить screenshots off, memory on; записать Main, Timings, JS samples.
5. Сравнить total scripting, long tasks, `MutationObserver`,
   `querySelectorAll`, style/layout, storage tasks, GC count/heap delta.
6. Отдельно 2 минуты `/game-search`: idle search и acceptance-card window.
7. Повторить A/B/C по три раза, брать median; первый 10с warm-up исключить.
8. Для attribution можно временно поставить DevTools logpoints/Performance
   marks вокруг shared `flush()` и отдельных callbacks, но не собирать такой
   инструментированный build в release.

Минимальный acceptance budget для владельца: extension median добавляет не
более 5мс scripting на 250мс flush, не создаёт long task >50мс, heap после 2 мин
не растёт монотонно, storage writes в steady room отсутствуют кроме лог-flush.
