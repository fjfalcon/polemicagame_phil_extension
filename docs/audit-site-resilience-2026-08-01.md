# Аудит устойчивости к сайту Polemica Notes — 01.08.2026

## Резюме

Проверено текущее рабочее дерево расширения с manifest `9.0.1` против живых
бандлов и страниц `polemicagame.com`.

Во время аудита рабочее дерево параллельно изменилось с `9.0.0` на `9.0.1`:
часть первоначальных находок уже исправлена владельцем/другим агентом. Финальная
сверка и числа ниже относятся к состоянию файлов на момент записи этого отчёта,
включая эти незакоммиченные исправления. Код расширения этим аудитом не менялся.

- КРИТИЧНО: 0.
- ВАЖНО: 5.
- МЕЛОЧЬ: 2.
- Уже закрыто во время аудита: 12 первоначальных расхождений; они перечислены
  отдельно и не входят в счётчик.
- Сейчас подтверждённо не выполняют обещанное действие:
  завершение/продолжение паузы по F8 и коррекция player-menu в role-faker.
- Новая общая проверка `.ended` исправляет victory/miss, но ошибочно считает
  экран паузы дневным.

Критических находок после adversarial-перепроверки нет: не найден текущий путь,
который подтверждённо делает опасный автоклик или выдёргивает игрока из идущего
матча.

## Источники

Скачаны непосредственно с сайта 01.08.2026:

| Источник | Размер | SHA-256 |
|---|---:|---|
| `bundle/game-search.js` | 997060 B | `57238ece03a6f583cbb5cfff1c54d0d3360b89d1c3e736a5b7a06c6f883b98d4` |
| `room/bundle/main.js` | 1633361 B | `92b45577b8a2be9638f4cd7b2b44413a017939077960be448ecf0f125873a4b0` |
| `bundle/profile.js` | 730869 B | `58e2aa8dded8f2a3123bcad60300536b6626550411b75d5a00ce60db236c8f43` |
| `room/bundle/locales/RU.js` | 41340 B | `b5ce5268540d7fa5b4daa954618e4c48939e27510f46feaf1a5f2a730aaa6cec` |

Также скачаны `/`, `/game-search`, `/profile/13509`, `/match/598995`.
Анонимные HTTP-проверки:

```text
GET /rating                           -> 404
GET /ratings                          -> 200
GET /rating/get-list?limit=1          -> 404
GET /ratings/default/get-list?limit=1 -> 200
GET /game-statistics/598995           -> 404
GET /game                             -> 302
```

Бандлы минифицированы в одну строку. Offsets ниже — воспроизводимые UTF-8 byte
offsets конкретного названного маркера внутри цитаты в файлах с указанными
SHA-256. Для читаемости excerpt может начинаться раньше маркера, а whitespace
нормализован; цитата рядом является основным доказательством.

Живая авторизованная комната не использовалась. Гипотезы, для доказательства
которых недостаточно bundle/page contract, в находки не включены.

## Находки

### 1. ВАЖНО: экран паузы ошибочно переводит OBS и роли в день

**Наш код:** `src/core/selectors.ts:260-273`;
`src/content/features/auto-start.ts:617-625`;
`src/content/panels/obs-panel.ts:509-517`.

```ts
export const ENDED_SCREEN_SELECTOR = ".ended";

export function endedScreenVisible(): boolean {
  const el = document.querySelector<HTMLElement>(ENDED_SCREEN_SELECTOR);
  return !!el && el.offsetWidth > 0 && el.offsetHeight > 0;
}
```

Оба потребителя без различения причины делают:

```ts
if (endedScreenVisible()) return "day";
```

**Бандл-доказательство:** `.ended` — общий компонент не только победы/промаха,
но и паузы. `room-main.js`, byte `1429871`:

```js
switch(this.state){
  case Hv.MAFIA_WON:return this.$root.Loc.end_game_mafia;
  case Hv.CIVILIAN_WON:return this.$root.Loc.end_game_civilian;
  case Hv.PAUSE:return this.$root.Loc.pause;
  case Hv.MAFIA_MISSED:return this.$root.Loc.mafia_miss
}
```

Все состояния рендерятся одним root, byte `1431244`:

```js
ao("div",{class:d(["ended",o.contClasses])},[...])
```

Пауза не вызывает `on_start_day`. `room-main.js`, byte `1591766`:

```js
on_start_pause:function(e){
  this.resetVotingInfo(!0),
  this.on_start_stage({type:"pause"}),
  this.$store.commit("updatePauseStatus",!0),...
}
```

**Расхождение:** comment называет `.ended` терминальным экраном, но bundle
использует его для временной паузы в любой фазе.

**Последствие:** пауза, начатая ночью, переключает OBS на day scene и скрывает
роль. После завершения паузы расширение должно заново распознать ночь; на самом
экране паузы состояние уже неверно.

**Фикс:** различать `.ended` по exact localized title/state: victory и
`mafia_miss` → day, `pause` → сохранить текущую фазу. Не выводить фазу только из
общего container class.

**Инварианты:** §4.1, §4.7.

### 2. ВАЖНО: F8 ищет завершение паузы в неправильном UI-контейнере

**Наш код:** `src/content/features/pause-hotkey.ts:252-275`, `415-462`.

```ts
const existing = this.getPauseButton(true);
...
const pause = await this.waitFor(() => this.getPauseButton(true), 700, 50);
```

Аргумент `true` ограничивает поиск menu roots. Helper умеет искать
`use[href*="#pause"]` в document при `false`, но F8-путь его так не вызывает.

**Бандл-доказательство:** judge/owner завершает паузу отдельной gameplay
кнопкой, `room-main.js`, byte `1439952`:

```js
gameIsPaused?(...icon:"pause",...onClick:e.$parent.endPause,...Loc.end_pause)
```

Settings содержит другой item — только начало паузы, byte `1488589`:

```js
class:d({disabled:!pauseAvailable}),onClick:startPause,...Loc.pause
```

No-judge продолжение тоже является отдельным gameplay readiness control;
`room-main.js`, byte `1452112` ссылается на:

```js
continue_game_button_not_ready
```

`RU.js` подтверждает exact labels:

```js
end_pause:"Завершить"
continue_game_button_not_ready:"Продолжить игру"
```

**Расхождение:** начало паузы находится в settings, а оба способа продолжения
игры — вне settings.

**Последствие:** F8 может начать паузу. На паузе судья/владелец не достигает
`Завершить`, а участник no-judge flow — `Продолжить игру`; F8 показывает
`не найдено/недоступна`, действие приходится выполнять мышью.

**Фикс:** до открытия settings искать exact role-specific action в узком
контейнере gameplay controls; settings открывать только для exact `Пауза`.

**Инварианты:** §4.2, §4.5, §4.7.

### 3. ВАЖНО: role-marker игнорирует текущий game ID и включает судью в fallback

**Наш код:** `src/content/features/role-marker.ts:59-81`, `170-193`, `224`.

```ts
const mUrl = location.pathname.match(/\/(?:match|game|room)\/(\d+)/);
...
const names = Array.from(document.querySelectorAll(SITE.player))
```

**Бандл-доказательство:** live room использует query, а не `/game/<id>`.
`room-main.js`, byte `1352656`:

```js
location="/game?role=viewer&game_id=".concat(e.$store.state.gameId)
```

ID также выводится structural block, byte `1444565`:

```js
class:"game-info-block__section section game-id"
```

Судья рендерится player component с marker class, byte `1617025`:

```js
class:d(["element",{"judge-player":o.isPlayerJudge(e)}])
```

Base component root при этом остаётся `.player`.

**Расхождение:** `/game` и `/game?game_id=...` не матчат pathname regexp;
current query и game-info не читаются. Судья не исключён из общего scan.

**Последствие:** marks хранятся под `l:<sorted lineup>`. Другая партия с тем
же видимым составом может получить reads прошлой игры. Судья получает
бессмысленный marker и меняет fallback signature.

**Фикс:** сначала валидировать `URLSearchParams.game_id`, затем exact numeric ID
из `.game-info-block .game-id`; исключить `.judge-player` из markers и lineup.
Старые lineup entries мигрировать неразрушительно.

**Инварианты:** §4.3, §4.11.

### 4. ВАЖНО: queue-guard пропускает поиск, подтвердившийся уже в скрытой вкладке

**Наш код:** `src/content/features/queue-guard.ts:59-99`.

Guard проверяет `isSearching()` только в `visibilitychange` и один раз в
`enable()`. Подписки на search DOM/state нет.

**Бандл-доказательство:** search запускается асинхронно. Server reply handler,
`game-search.js`, byte `889006`:

```js
this.socket.on("on_start_game_search",function(t){
  ... t.success ? e.toggleViewSearching(!0) : ...
})
```

Timer появляется только после этого state switch, byte `847011`:

```js
t.isActiveSearch?n("div",{
  staticClass:"p-play__profile-game p-play__profile-game--search"
},[n("div",{staticClass:"p-play__profile-game-search-time"},...)])
```

**Расхождение:** extension предполагает, что timer уже существует в момент
скрытия вкладки. Bundle доказывает окно между click и server confirmation.

**Последствие:** пользователь нажимает `Играть` и сразу переключает вкладку;
guard видит `searching=false`. Timer появляется позже, но alarm не ставится и
предупреждения о socket timeout нет.

**Фикс:** пока exact `/game-search` скрыта, arm/disarm также по появлению и
исчезновению точного `searchInProgress`.

**Инварианты:** §4.7, §4.10.

### 5. ВАЖНО: `SITE.playerVideo` считает wrapper и child как две камеры

**Наш код:** `src/core/selectors.ts:18`;
`src/content/panels/obs-panel.ts:50-57`;
`src/content/panels/twitch-panel.ts:150-161`.

```ts
playerVideo: ".player__video, .player__video-wrapper",
```

Обе панели считают:

```ts
const webcamCount = document.querySelectorAll(SITE.playerVideo).length;
...
playerCount >= 10 || webcamCount >= 10 ||
(playerCount >= 8 && webcamCount >= 8)
```

**Бандл-доказательство:** wrapper и video одновременно вложены друг в друга.
`room-main.js`, bytes `1361329` и `1417384`:

```js
Uf={key:3,class:"player__video-wrapper"}
```

```js
o.hasVideo?(to(),ao("div",Uf,[
  ...ao("video",{class:"player__video",...})
]))
```

`hasVideo` — per-player contract, byte `1401583`:

```js
hasVideo:function(){return 10===this.id||this.playerView&&this.playerView.hasVideo}
```

**Расхождение:** число DOM matches не равно числу камер. Пять players с video
дают `webcamCount=10`.

**Последствие:** OBS/Twitch считают интерфейс активной игрой уже при пяти
видеоплитках, если присутствует один общий game-control. Панель/auto-mode/chat
могут включиться в неполном лобби или промежуточном room state.

**Фикс:** для count использовать один canonical node, предпочтительно
`video.player__video` или `.player__video-wrapper`; union оставить только под
отдельным именем для манипуляций.

**Инварианты:** §4.1, §4.7.

### 6. МЕЛОЧЬ: коррекция player-menu role-faker полностью мертва

**Наш код:** `src/core/selectors.ts:20`;
`src/content/features/role-faker.ts:104-111`, `140-143`.

```ts
playerMenuWithRole: ".player__menu.with-role",
```

**Бандл-доказательство:** actual menu, `room-main.js`, byte `1416132`:

```js
class:d(["player__menu",o.menuClasses])
```

Class producer, byte `1404528`:

```js
menuClasses:function(){return[
  this.showMenu&&"active",
  this.$store.state.streamerModeStatus&&"in-streamer-mode"
].filter(Boolean)}
```

`with-role` отсутствует во всех скачанных источниках.

**Расхождение:** оба `querySelectorAll(SITE.playerMenuWithRole)` всегда пусты.

**Последствие:** подмена роли и скрытие чужих roles работают, но задуманная
коррекция `menu.style.right="0.5rem"` никогда не применяется. Возможное
перекрытие/смещение menu остаётся без исправления и без сигнала.

**Фикс:** использовать реальный `.player__menu`, scoped к нужным чужим player
tiles; сохранить compare-before-write и restore map.

**Инварианты:** §4.1, §4.7.

### 7. МЕЛОЧЬ: connection-diag не оборачивает inbound handlers уже созданного socket

**Наш код:** `src/content/page/conn-diag-page.ts:107-187`;
`src/manifest/manifest.base.json:32-44` (`document_end`).

Prototype setters оборачивают только будущие присваивания:

```ts
Object.defineProperty(proto, prop, {
  set(this: WebSocket, fn: unknown) { ... }
});
```

**Бандл-доказательство:** Engine.IO назначает property handlers при создании
transport. `game-search.js`, byte `43864`:

```js
this.ws.onopen=function(){e.onOpen()},
this.ws.onclose=function(){e.onClose()},
this.ws.onmessage=function(t){e.onData(t.data)},
this.ws.onerror=function(t){e.onError("websocket error",t)}
```

**Расхождение:** переопределение prototype setter после этих assignments не
заменяет уже сохранённые handlers экземпляра.

**Последствие:** prototype `send` видит исходящие frames, но inbound
open/message/close раннего socket могут отсутствовать в support-log. Это
снижает доказательность диагностики вылетов из очереди.

**Фикс:** ставить MAIN-world probe в `document_start` до site bundle либо
явно логировать capability `inboundHooked=false`, если probe опоздал.

**Инварианты:** §4.7; не возвращать frame bodies/credentials в лог.

## Мёртвый код и селекторы

### SITE

- `SITE.playerMenuWithRole` — подтверждённая находка 6.
- `SITE.substageActive`: current bundle задаёт только
  `substages:["current","next","temp"]`; обе ветки `.active` мертвы. Это
  резерв после рабочего `.current`, поэтому текущего user-visible отказа нет.
- `.stage.current`, `.stage.next`, `.stage.active`: root stage имеет только
  `.stage`; живы соответствующие `.substage.current/.next` arms.
- `SITE.roleSymbols`: inline symbols current bundle не рендерит, роли используют
  внешний sprite. Это emergency fallback; динамический `xlink:href` работает.
- `ownRoleTargets[1]` и `[4]`: требуют ancestor `.my-role`; current `.my-role`
  стоит на самом `.player__role`. Остальные три arms покрывают current markup.
- Arm `.player.desktop-version.hidden...`: current player class producer не
  выдаёт `hidden`, а arm полностью поглощён первым arm без `.hidden`.
- `use[href]` не подтверждён текущим room bundle; live arm —
  `use[xlink:href]`.

### Неиспользуемые SITE-поля

- `SITE.playerIcons`.
- `SITE.playerStats`.
- `SITE.acceptGameDivLoose`.
- `SITE.webcamButtonStartIcon`.
- `SITE.bestMoveTooltip`.

### TEXT

- `TEXT.accept`: нет consumers.
- `TEXT.pause`: F8 использует отдельные `PAUSE_EXACT/RESUME_EXACT`.
- `TEXT.vote`: нет consumers.
- `TEXT.recruiting`: нет consumers; RU key на сайте существует.
- `TEXT.gameMode`: нет consumers и значения не отражают current search modes
  `Обычный`, `Рейтинг`, `Prime`.
- В `TEXT.night` `ночь` поглощается `ноч`; `ход мафии` и `знакомство мафии`
  поглощаются broad `мафи`.
- Ранний RU key `mafia_acts:"Голосование мафии"` перезаписан более поздним
  effective `mafia_acts:"Ход мафии"`.
- `first_night:"Первая ночь"` есть в RU.js, но stage key `first_night` не
  найден в current room flow.

### Socket assumptions

- `queue-peek` принимает `redirect_to_game`, но обычный search flow использует
  `on_game_found` и POST `/game`; `redirect_to_game` найден в lobby component.
  Ветка безвредна, но не подтверждена как search contract.

## Полная сверка SITE

| Поле | Статус текущего contract |
|---|---|
| `player` | Живой `.player`. |
| `playerDesktop` | Основной arm жив; `.hidden` arm мёртв/избыточен. |
| `playerInfo`, `playerName` | Живые `.player__info` и `.info__name`. |
| `playerIcons`, `playerStats` | Own-only aliases, SITE consumers нет. |
| `playerVideoWrapper` | Живой, условный по `hasVideo`. |
| `playerVideo` | Оба arms живы, но overlap даёт находку 5. |
| `playerVideoEl` | Живой точный video. |
| `playerMenuWithRole` | Мёртвый, находка 6. |
| `roleUse` | Current `xlink:href` arm жив. |
| `roleSymbols` | Мёртвый current fallback. |
| `myRole`, `anyRole` | Живы; `.role.role` избыточно повторён. |
| `ownRoleTargets` | Arms 0/2/3 живы; 1/4 мертвы. |
| `stage` | Живые `.stage`, `.substage`. |
| `substageCurrent` | `.substage.current` жив; `.stage.current` мёртв. |
| `substageActive` | Полностью мёртв. |
| `substageNext` | `.substage.next` жив; `.stage.next` мёртв. |
| `acceptGameDivPrimary` | Exact accept arms живы; cursor substring arm broad. |
| `acceptGameDivLoose` | Broad/unused. |
| `acceptGameWrapperDiv` | Живой structural fallback, требует text/deepest gates. |
| `cursorPointerDiv` | Живой broad state class. |
| `welcomeModal` | Живой generic common modal; exact text gates обязательны. |
| `lobbyStageName` | Живой pregame `.new-stage__name`. |
| `invitationLink` | Живой условный; правильно не является обязательным. |
| `searchInProgress` | Живой точный timer descendant; исключает loader skeleton. |
| `searchPanel`, `searchPlayWrap` | Живы. |
| `webcamButton` | Живой, не уникален: camera/mic/settings имеют один class. |
| `webcamButtonStartIcon` | Живой generic/unused. |
| `webcamButtonOffClass` | Живой для camera и mic; требует идентификации button. |
| `roleMenuClickable` | Broad by design; current toggle — `<li>`. |
| `profileAccept` | Живой found-group root. |
| `profileSearchButton` | Живой, используется и disabled/unconfirmed state. |
| `profileSearchClose` | Живой button с child `<img>`. |
| `settingsButton` | Живой generic control, не semantic identity. |
| `obsGameControls` | Button/settings/role arms живы; menu arm мёртв. |
| `endedTitle` | Живой для victory/pause/miss. |
| `statsTable`, `statsTableRoot`, `statsHeader` | Живы. |
| `statsRow`, `statsCellTitle` | Живы внутри scoped stats table. |
| `penaltyDots`, `penaltyDot`, `bestMoveDot`, `bestMoveTooltip` | Own-only; последнее SITE-поле unused. |

В `selectors.ts` нет hard-coded Vue `data-v-*`. `match-stats.ts` хранит
`data-v-33ae8458` только как snapshot attribute, а не selector, поэтому current
поиск от пересборки не зависит.

Camera/settings/role sprite hashes на дату аудита совпадают с bundle:

```text
camera on   516810fd6c1e38f17335.svg
camera off  edf479f3365a51e1beca.svg
mic on      652f9184e845e10a12e5.svg
mic off     3a2b1603137ca0fb3eeb.svg
settings    e3a7cf4ee64b975985ad.svg
role sprite f59bacbc2885635c4d91.svg
```

Это content hashes, не semantic contract. Current fallback order
`[camera, mic, settings]` подтверждён template, но рядовая смена assets/order
его ломает. Неизвестная конфигурация в основном обрабатывается fail-closed.

## Оба RU-словаря

`RU.js` содержит один object literal с повторными keys; действует последнее
определение.

| Key | Раннее | Позднее/effective |
|---|---|---|
| `first_night` | `Первая ночь` | `Первая ночь` |
| `revote` | function `Переголосование: ...` | `Повторное голосование` |
| `mafia_acts` | `Голосование мафии` | `Ход мафии` |
| `checks` | `Проверки` | `Проверки` |

`room-main.js` current `substagesInfo`:

```js
["card_distribution","familiarity_with_mafia","evening","night",
 "mafia_acts","checks","doctor_acts"].includes(...) ? n="night" :
["morning","day","discussion","voting","vote","voting_summary",
 "extra_speeches","farewell_minute"].includes(...) && (n="day")
```

Текущее рабочее дерево уже добавило доказанные RU `аукцион` в night и
`лучший ход`/`промах` в day. Standard labels обоих списков классифицируются.

## Непроверенные EN-маркеры

English locale bundle не был предоставлен и не найден среди скачанных
источников. Все страницы имеют `lang="ru-RU"`; room bundle читает `$root.Loc`.
Identifier или library string в minified JS не доказывает UI label.

Непроверенными остаются:

- night: `night`, `card deal`, `dealing`, `mafia`, `doctor`, `check`,
  `mafia turn`, `mafia introduction`, `checks`, `auction`;
- day: `day`, `morning`, `vote`, `voting`, `results`, `player's speech`,
  `player speech`, `speech`, `additional speech`, `farewell`, `best move`,
  `miss`;
- acceptance: `ready`, `confirm`, `start playing`, `accept`, `join`;
- modal/room: `welcome`, `start watching`, `recruiting players`,
  `show roles`, `hide roles`;
- pause: `pause`, `pause game`, `break`, `resume`, `resume game`.

Они остаются best-effort, а не находками. Проверка требует live EN locale
bundle либо авторизованную EN-сессию с exact labels и DOM context.

## Маршруты и flow

### Подтверждено

- `/game-search` использует отдельный bundle и Socket.IO namespace `/search`.
- Active search появляется асинхронно после `on_start_game_search`.
- Found group — `.p-play__profile-accept`; action `Принять игру`, accepted
  state `Готовы: N/10`.
- `on_game_found` обычного search flow выполняет POST-переход в `/game`.
- Player room pathname — `/game`; viewer/reconnect добавляют query
  `role=viewer&game_id=<id>`.
- Profile/match links в проверенных flows используют full navigation/new tab.
- `/profile/13509` содержит exact `:profile-user='{"id":"13509",...}'`.
- `/match/598995` содержит `<Gamestats :game-data='...'>`; payload parse-first,
  данные игроков в `data.players`.
- `/ratings` и `/ratings/default/get-list` — current plural routes; код `9.0.1`
  уже использует их.
- `/game-statistics/<id>` упоминается profile bundle для другого history type,
  но проверенный `/game-statistics/598995` даёт 404. Одинаковый Gamestats
  contract не доказан, поэтому неподдержка этого route не объявлена находкой.
- URL-router (`popstate` + 500 ms href poll) совместим и с full navigation, и с
  возможными history transitions на поддержанном `/match/:id`.

### Room socket events, сверенные с bundle

```text
connect, disconnect, session_initialized, connect_error, reconnect_error,
on_authorization_failed, on_connect_room, on_error_connect_room,
on_session_dropped, on_detailed_game_state,
update_pause_availability, on_start_pause, on_update_pause_time,
on_finish_pause, on_game_disbandment, start_voting, update_voting,
voting_finished, on_start_night, on_start_day, on_start_stage,
on_finish_stage, on_set_states, on_discussion_state,
on_start_best_move, on_end_best_move, on_voting_result, on_end_game,
game_statistics_saved, on_stop_game, on_self_foul, on_remote_foul,
on_foul_confirmation_required, on_penalty_for_foul_canceled,
on_foul_removed, on_remote_disconnect, on_self_strike, on_remote_strike,
on_judge_action
```

Queue-requeue room stage корректно отличает tech-foul/player-exclusion voting
от game-start readiness и reconnect retry от распущенной комнаты.

## Поведение при потере contract

| Фича | Поведение | Сигнал |
|---|---|---|
| content auto-accept | Exact/scoped detector fail-closed. | В основном debug. |
| welcome skip | До 3 попыток, затем оставляет modal. | Info на лимите. |
| webcam auto-off | Hash/order; при неуверенности обычно fail-closed. | Debug. |
| phase/OBS | Unknown text сохраняет старую фазу; общий `.ended` сейчас даёт находку 1. | Только debug. |
| player-notes | Missing player/name/info тихо не создаёт UI. | Только exceptions. |
| match-data | HTTP non-200 молча; missing attribute только debug. | Нет user signal. |
| match-stats | После 10 с fast poll прекращается, pending ждёт DOM observer. | Нет итогового warn. |
| role-faker | Missing own role теперь fail-closed; dead menu selector молчит. | Debug только own role. |
| pause-hotkey | Fail-closed и показывает notification. | Есть user signal. |
| role-marker | Missing ID использует lineup. | Нет. |
| queue-guard | Missing/late timer не arm. | Нет. |
| queue-peek | Timeout/error bounded; unknown state не кликает. | Ошибка в панели. |
| queue-requeue | Stage 1 переживает reload через validated one-shot bridge; room path bounded. | Info/debug. |
| OBS/Twitch panels | Active-game heuristic может сработать рано из-за overlap. | Нет. |
| `f5-refresh`, `update-notify` | От current site DOM почти не зависят. | Собственные логи. |

## Самодиагностика

`polemicaDiag()` возвращает raw count всех строковых `SITE`. Passive check в
текущем `9.0.1` уже использует exact `/game` и больше не считает `/game-search`
комнатой.

Диагностика всё ещё не видит:

- `ownRoleTargets[]`, потому что arrays пропускаются;
- SSR `:game-data` в повторном HTTP response;
- camera/settings hashes и order;
- `.disbandment-timer`, readiness и room error/retry distinction;
- profile/participants selectors вне `SITE`;
- взаимоисключающие search states;
- семантику count, из-за чего overlap находки 5 выглядит «зелёным»;
- success role visibility после retries;
- route/state applicability: raw `missing` закономерно заполнен на любой
  странице.

Raw snapshot полезен вручную, но не даёт раннего автоматического сигнала о
главных contracts.

## Предложение по канарейкам

### Search

На exact `/game-search` после появления `searchPanel` должен распознаваться
один state:

```text
idle      = profileSearchButton
searching = searchInProgress + profileSearchClose
found     = profileAccept
starting  = .p-play__profile-game-loader
```

Warn только если panel стабилен, но state не распознан.

### Room lobby и active game

- При `.new-stage` ожидать `.new-stage__name`; не требовать conditional
  `.invitation-link`.
- При `.substages` ожидать `.substage.current`.
- Проверять долю players с `.player__info .info__name`.
- Отдельно считать players, wrappers и videos; `videos > players` или
  `wrappers !== videos` логировать как contract drift.
- Controls требовать только обычному player, не viewer/judge.

### Own role и actions

- Own-role canary включать только при `.player.my-player` и уже существующих
  role elements; stable union count 0 → один warn.
- F8 различать `start-pause-menu`, `continue-vote`, `judge-end-pause`.
- Role-faker после hotkey проверять изменённый own `<use>`.
- Queue guard в hidden tab реагировать на позднее появление timer.
- Queue-requeue логировать one-shot bridge create/consume/result.
- Auto-accept при found state и enabled setting: если exact clickable не найден
  2-3 секунды, warn без опасного fallback-клика.

### Match

В parser path логировать только metadata:

```text
matchId, httpStatus, responseBytes,
attributeForm=game-data|data-game|game|none,
jsonParsed=true|false
```

`200 + none` и parse failure → один warn. После успешного parse через 10 секунд
проверить `statsHeader/statsTableRoot/table`; timeout логировать отдельно.

### Формат

```text
diag-contract-failed {
  contract,
  routeKind,
  uiState,
  roleKind,
  elapsedMs,
  counts,
  extensionVersion
}
```

Не логировать ники, `textContent`, full URL, SSR HTML, frame bodies, SID,
query или `authKey`.

## Закрыто во время аудита

Эти расхождения существовали в прочитанном `9.0.0`, были независимо
подтверждены live bundle, но уже отсутствуют в текущем рабочем дереве `9.0.1`:

1. `OWN.tooltip="tooltip"` и global cleanup удаляли Vue-tooltip сайта. Сейчас
   extension class — `pn-tooltip`.
2. Rating fallback использовал 404 `/rating/get-list`; сейчас используется
   `/ratings/default/get-list`.
3. Victory/miss после ночи оставляли OBS/role phase ночными; добавлен `.ended`
   detector. Его текущая overbreadth для pause — новая находка 1.
4. `Аукцион`, `Лучший ход`, `Промах` отсутствовали в RU classifier; добавлены.
5. Spectator `Режим зрителя` / `Начать просмотр` не поддерживался welcome skip;
   exact RU markers добавлены.
6. Role-faker включал fake mode без own role; теперь `changeRole()` возвращает
   success и side effects выполняются только после него.
7. Note/stats/history ошибочно зависели от video wrapper; media gate снят с
   немедийных кнопок, `hasMedia` добавлен в signature.
8. Queue-peek проверял Pro только по `subscription.type`; сейчас учитывается
   `duration > 0`.
9. Search close delegation использовала `target.matches`, хотя live close
   button содержит child `<img>`; сейчас используется `closest`. Утверждение в
   новом comment, что normal `Играть` содержит `<span>`, bundle не подтверждает,
   но сама замена на `closest` безопасна.
10. Background auto-accept не мог матчить live `div.p-play__profile-accept` и
    истекал через 10 секунд. В текущем дереве файл удалён, handlers и permission
    `scripting` сняты; мёртвая страховка больше не заявляется.
11. Stage-1 queue-requeue терял `accepted` при bundle-пути
    `game_not_accepted → window.location.reload()`. Сейчас acceptance ставит
    validated one-shot session bridge, а reload его потребляет.
12. Passive diagnostics считала штатную `/game-search` игровой комнатой через
    `pathname.includes("/game")`; сейчас используется exact `/game`.

## Отклонённые гипотезы

- Основной content auto-accept не сломан: exact `.p-play__profile-accept` и
  `Принять игру` покрыты, inherited parent text дедуплицируется.
- `Играть` не имеет доказанного child `<span>` в actionable normal branch;
  подтверждённым delegation defect был только close `<img>`, уже исправленный.
- OBS не пропускает `Промах` в current `9.0.1`; теперь проблема обратная —
  общий `.ended` захватывает и pause.
- No-video path больше не удаляет и не блокирует немедийные controls; current
  signature учитывает появление/исчезновение media.
- Raw `polemicaDiag().missing` не обязан быть пустым на каждой route: это
  ручной snapshot, а не assertion. Проблема только в отсутствии state-aware
  автоматических canaries.
- `/game-statistics/:id` не объявлен сломанной route: bundle упоминает её, но
  одинаковый data contract не доказан, а проверенный ID возвращает 404.
- Не найден доказанный current document-wide substring fallback, который
  кликает постороннюю кнопку.

## Топ-3

1. Разделить `.ended` на victory/miss и pause, иначе новый phase fix сам
   переключает OBS и роли в неверное состояние ночью.
2. Добавить role-specific gameplay controls для F8, чтобы тот же hotkey
   завершал/продолжал начатую им паузу.
3. Привязать role-marker к реальному `game_id` и исправить active-game count на
   один canonical video node.

## Проверено и чисто

- Content auto-accept exact/scoped/visible/budgeted и соответствует live card.
- Background duplicate и permission `scripting` удалены в текущем дереве.
- Search active detector использует timer descendant и не принимает loader
  skeleton с `--search` за очередь.
- Acceptance/readiness различает `cursor-pointer` и `Готовы: N/10`.
- Stage-1 queue-requeue сохраняет acceptance через reload в валидируемом
  one-shot session bridge.
- Queue-peek endpoint, namespace, framing, start/stop events и форма
  `queues[mode].players` совпадают с bundle.
- Queue-requeue room contracts readiness/disbandment/stage/error-retry
  соответствуют room bundle.
- Reconnect rebuild через `on_detailed_game_state` подтверждён.
- Technical-foul/player-exclusion voting не смешивается с game-start readiness.
- Camera/mic/settings hashes и current order совпадают; unknown configuration
  в большинстве веток fail-closed.
- Role sprite извлекается из live `xlink:href`; hash — emergency fallback.
- `show_roles:"Скрыть роли"` / `hide_roles:"Показать роли"` инвертированы по
  key, но extension правильно следует displayed action.
- Core player/name/role/video/judge classes актуальны.
- Profile SSR `:profile-user`, avatar/username classes и participants links
  `/profile/<id>` актуальны.
- Profile endpoint names и parameter casing `userId`/`user_id` соответствуют
  bundle; rating response array отдельно подтверждён live HTTP.
- Match SSR использует exact `:game-data`; parse-first и `data.players`
  подтверждены downloaded page.
- Match table header/root/table/row/title selectors актуальны.
- `/match/:id` parser и URL-router совместимы с доказанными full navigation и
  new-tab flows.
- `OWN.tooltip` больше не конфликтует с site `.tooltip`.
- RU auction/best-move/miss и spectator modal покрыты current code.
- Missing own role в role-faker теперь fail-closed.
- Passive diagnostics использует exact `/game` и не шумит на `/game-search`.
