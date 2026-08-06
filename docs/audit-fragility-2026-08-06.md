# Карта хрупкости Polemica Notes — 06.08.2026

## Резюме

Проверен production на commit `c11051c` (`9.4.0`). Production-код не менялся.
Все четыре живых bundle скачаны заново и отформатированы через
`npx prettier --parser babel`. SHA-256 **совпали** с
`tests/fixtures/site-contract.json`; drift первой строкой отчёта не требуется.

| Bundle | SHA-256 |
|---|---|
| `game-search.js` | `57238ece03a6f583cbb5cfff1c54d0d3360b89d1c3e736a5b7a06c6f883b98d4` |
| `room-main.js` | `92b45577b8a2be9638f4cd7b2b44413a017939077960be448ecf0f125873a4b0` |
| `profile.js` | `58e2aa8dded8f2a3123bcad60300536b6626550411b75d5a00ce60db236c8f43` |
| `RU.js` | `b5ce5268540d7fa5b4daa954618e4c48939e27510f46feaf1a5f2a730aaa6cec` |

Строки bundle ниже относятся к этим exact prettified-файлам в
`/var/folders/3k/3s0rnw9d2pj0fn0tcbwnz2vr0000gn/T/opencode/polemica-fragility-20260803/`.

Главный вывод: текущий contract-suite хорошо сторожит **существование класса** и
RU phase labels, но почти не сторожит **семантику состояния**, структуру SSR,
вложенные payload и socket lifecycle. Bundle hash drift только предупреждает.

Критерий приоритета:

- **P0:** ничем не покрыто и при drift расширение молча врёт либо действует за
  игрока; по правилу задачи сюда же относится полностью молчаливое исчезновение
  фичи без fallback/log. Streaming/privacy и account-bound socket действия тоже P0.
- **P1:** крупная фича деградирует с наблюдаемым отказом/fallback либо выдаёт
  ограниченно неверный результат.
- **P2:** локальная деградация с логом/фолбэком либо ограниченный UX-риск.
- **P3:** косметика, мёртвый fallback, диагностическая или будущая хрупкость.

## Что Уже Сторожится

Не считается дырой и ниже отмечается как существующее покрытие:

- все non-allowlisted классы из `SITE` должны встречаться хотя бы в одном live
  bundle: `tests/contract/site-contract.test.ts:136-165`;
- RU phase markers, fixture labels и `classifyPhaseText`:
  `tests/contract/site-contract.test.ts:167-216`;
- rating `user_id/username`, outer profile statistics и outer game-history
  shapes: `tests/contract/site-contract.test.ts:232-310`;
- vote rounds/lift outcome на реальных fixtures:
  `tests/unit/match-outcome.test.ts`;
- `.ended` pause/miss/victory distinctions: `tests/unit/selectors.test.ts`;
- известные requeue state-machine сценарии: `tests/unit/queue-requeue-*`.

Broad class presence не считается покрытием отношений вроде
`cursor-pointer ⇔ !isGameAccepted`, `active ⇔ voted` или «ровно одна ссылка
search означает direct stop».

Для SSR дополнительно сохранены воспроизводимые anonymous snapshots 06.08.2026:

| Snapshot | SHA-256 | Evidence |
|---|---|---|
| `/match/314446` | `4905da32e4ad5aa07decd8c8516407e72d08a84e4b122c8ce690b8fee2043840` | `match-314446.html:146-152`, `:game-data` на строке 148 |
| `/profile/1` | `2293332771645fd74c4ec2b5017c5408c5fbd149ebda92b4fe5df7b2f9def883` | `profile-1.html:147-148`, `:profile-user` |
| `/game-search` | `ef7e0b835b5d78be599e0f259230bb6946ee519cd7c7c461025c0ce26a272858` | `game-search.html:177,183`, anonymous `current-user` и new-game-service |

## 1. DOM И CSS

| Где у нас | Что предполагаем | Доказательство сайта | Покрытие | При поломке / радиус | Приоритет |
|---|---|---|---|---|---|
| `selectors.ts:10-17`; `player-notes.ts:976-1073,3308-3382`; `camera-flip.ts:33-43` | Игрок, имя, info и media имеют `.player`, `.player__info .info__name`, `.player__video-wrapper`, `video.player__video` | `room-main.pretty.js:44212-44214,44389-44527,44601-44623` | Contract: классы; нет structural test | Молча исчезают заметки, кнопки media и flip; фича деградирует | P1 |
| `selectors.ts:11-12`; `role-marker.ts:90-94` | Судья имеет `.judge-player` и исключается из roster/game key | `room-main.pretty.js:57673` | Только class presence | Марки могут попасть судье, rematch key врёт | P2 |
| `selectors.ts:24-38`; `auto-start.ts:379-405,526-578`; `obs-panel.ts:517-573`; `role-faker.ts:106-169` | Own role — `.player__role.role.role.my-role`/в `.my-player`; sprite читается из `<use href>` | `room-main.pretty.js:43601,44142-44144,44553-44589` | Contract: классы/`use`; нет full structure | Hide/fake role молчит/ретраит; роль может попасть в стрим | **P0** |
| Inline `#stop` `auto-start.ts:423-449,648-699,1139-1143` | `<use href>` с fragment `#stop` означает native-hidden role | Current bundle скрывает role через `v-show(roleDisplay)`, не `#stop`: `room-main.pretty.js:44553-44590` | Ничем; current fallback не доказан | Dead/ложный state signal может рассинхронизировать role tracking | P2 |
| `selectors.ts:22,27,43`; `role-faker.ts:132-169`; `auto-start.ts:741-749` | Legacy `.player__menu.with-role`, inline `<symbol>`, `.substage.active` могут быть fallback | Bundle показывает menu только `active/in-streamer-mode` (`43684-43688`), external sprite (`44553-44589`), substages `current/next/temp` (`45108`) | Explicit allowlist as absent | Fallback мёртв, рабочие пути остаются | P3 |
| `selectors.ts:40-44,64`; `auto-start.ts:721-771`; `obs-panel.ts:677-959` | Stage/substage structure и current/next определяют фазу | `room-main.pretty.js:44857-44864,45108,45161-45188,45243-45420` | Class contract + phase unit/contract | OBS/role могут сохранить неверную фазу; фича врёт | P0 |
| Inline `body.day/body.night` `auto-start.ts:721-725` | Body class имеет приоритет над проверенными stage markers | Bundle использует body classes `fixed/mobile-version`, но `day/night` не найден: `room-main.pretty.js:55372-55375,57574` | Ничем; предположение не доказано | Будущий unrelated body class инвертирует role visibility | P1 |
| `selectors.ts:56,64,71,78`; `queue-requeue.ts:267-289`; `obs-panel.ts:107-121` | `.new-stage` — pregame; непустая `.stage` — match; `.ended` — fixed started; только mafia/civilian classes — finish | Тернарник `voting_for_game_start` и fixed states: `room-main.pretty.js:45206-45243,45499-45589` | Unit сильный; exact ternary не contract | Неверный exit/OBS ownership; действие за игрока | P0 |
| `selectors.ts:80,82,90-91`; `queue-requeue.ts:292-383,697-715` | Timer/readiness: `.disbandment-timer`; tile mark; exact Ready-button + `active` | `room-main.pretty.js:44225-44245,44851-44852,45876-45890,46349-46377`; `RU.pretty.js:353-357` | Unit strong; live semantics не contract | Requeue молчит либо уводит неготового | P0 |
| `selectors.ts:93-103`; `queue-requeue.ts:385-542` | Error actions: no-href = action/retry; narrow one search href = direct stop; multi-button ambiguous | Renderer: `room-main.pretty.js:40560-40594`; producers `39494-39537,40161-40197,40411-40449` | Structural units; producers не contract | Wrong structural match может requeue kicked player | P0 |
| `selectors.ts:105-120,130-132`; `search.ts:25-35`; `queue-guard.ts:26-40`; `queue-peek.ts:126-167`; `queue-requeue.ts:837-921` | Search panel, Play, accepted card, close и live timer сохраняют relationship | `game-search.pretty.js:47188-47191,47357-47539,47608-47623` | Class presence; partial units | Search/peek/guard/requeue молча деградируют | P1 |
| `selectors.ts:46-49`; `auto-start.ts:96-289`; inline `ACCEPT_SCOPE_SELECTOR` `auto-start.ts:109-140` | Accept primary и generic fallback безопасны внутри accept scope и exact text | Current branch: `game-search.pretty.js:47357-47462` | Unit fixtures; uniqueness не live-tested | Future accept-like node может получить wrong click; действие | **P0** |
| Inline `cursor-pointer` `queue-requeue.ts:837-862`; `auto-start.ts:273-282` | Accepted card остаётся в DOM, а `cursor-pointer` означает `!isGameAccepted` | Binding: `game-search.pretty.js:47383-47393`; `isGameAccepted=group.ready`: `49624-49631` | Unit; class presence only in contract | Acceptance/requeue state врёт; возможен автоклик | **P0** |
| Inline `GAME_STARTING_SELECTOR`, `SITE_MODAL_SELECTOR` `queue-requeue.ts:68-78,172-176,879-892` | Loader означает start; любая visible site modal запрещает repeat | Loader `game-search.pretty.js:47361-47375`; modal/overlay `45972-45973,29959` | Нет live semantic test | Fail-closed: requeue останавливается/зависает с логом | P2 |
| `selectors.ts:105,122`; `auto-start.ts:875-960` | `.common-room-modal` и exact action descendant — welcome/player/viewer start | Wiring `room-main.pretty.js:32682-32690,32802-32812,50423-50549` | Player unit; viewer не покрыт | Skip start warning/no-op; bounded action | P1 |
| `selectors.ts:119-120,134`; icon hashes `auto-start.ts:976-1029`; `pause-hotkey.ts:89-105,221-234` | Camera/mic/settings имеют общий class; hash определяет control; при 3 unknown первая — camera | Exports/order: `room-main.pretty.js:21109,21113,21197,21201,21249,47380-47435` | Только class presence; hashes/order ничем | Может нажать camera/mic/settings вместо нужного | **P0** |
| `SITE.webcamButtonOffClass="off"` `selectors.ts:119-120`; `auto-start.ts:1070-1117` | Camera `.off` означает video уже выключено и прекращает автоклики | Binding `.off: !videoTrackAvailable`: `room-main.pretty.js:47393-47404` | Class presence only; state semantics нет | Drift может оставить camera включённой или вызвать лишние camera clicks; privacy/action | **P0** |
| Inline pause selectors `pause-hotkey.ts:54-60,143-177,221-357` | `.controls`, `.game-info-block`, menus, `.without-hover`, settings/pause controls сохраняют relationship | `room-main.pretty.js:46069-46330,46501-46527,47287-47434,49085-49247` | Нет dedicated unit/live behavior | F8 молчит либо открывает/закрывает wrong menu | **P0** |
| Profile inline selectors `player-notes.ts:987-1024,3279-3297` | Username/avatar — `.profileinfo__main-info-*` | `profile.pretty.js:32614-32649` | Ничем; вне `SITE` | Profile notes/color молча исчезают | P1 |
| Participants inline selectors `player-notes.ts:1125-1142` | `a.participants-item[href=/profile/id]`, `.participants-name span` | `game-search.pretty.js:48765-48809` | Ничем; вне `SITE` | Queue nick colors молча исчезают | P2 |
| `nickname-lengths.ts:17-27` | Popup-сборщик видит `.player__info.info/.player__info`, `.info__name`, `.player-number` | `room-main.pretty.js:40777,44603,44621` | Ничем | Popup молча считает пустой/неверный состав | P1 |
| `role-marker.ts:62-97` | Game ID: query, `.game-info-block .game-id`, data attrs, затем roster fallback | Current ID DOM `room-main.pretty.js:46501-46518`; viewer query `40168-40181`; data attrs не подтверждены | Нет resolveGameKey unit | Marks могут переехать между rematch; фича врёт | P1 |
| `selectors.ts:140`; `match-stats.ts:193-213,334-476` | Первый `.game-stats-table .table` — header owner с position/username/role, куда можно добавить phase rows с player cells | Header columns `room-main.pretty.js:54915-54959`; main `54981-55073`; footer `55077-55133`; `.table` `54321-54589` | Ничем structural | Current owner подходит; reorder roots/role removal молча отключит phase enhancement | P1 |
| `selectors.ts:141-147`; `match-stats.ts:1097-1185,1279-1343` | Во всём `.game-stats-table` две последние rows семантически total и MMR | DOM order: последняя row — footer sum, предпоследняя — последняя main row; MMR row отсутствует: `room-main.pretty.js:54981-55133` | Ничем | **Current drift:** sum стилизуется как MMR, achievement/main row как total; CSS nth-last применяется отдельно в каждом root | P2 |
| Fixed Vue scopes `match-stats.ts:159,190,364,636,1192-1269` | `data-v-33ae8458`/`data-v-1db9d42a`, vuescroll classes ещё актуальны | Current scope `data-v-5f3fd140`: `room-main.pretty.js:54593`; old literals отсутствуют | Ничем | Уже молча не работают части CSS; cosmetic lie | P2 |
| SSR `<Gamestats :game-data>` `match-data.ts:65-84` | Server HTML сохраняет tag/attribute/single quotes | Snapshot `match-314446.html:146-152`, SHA выше | Только source invariant, не live extraction | Вся match feature молча исчезает | **P0** |
| Legacy SSR fallbacks `data-game` и `:game` `match-data.ts:65-71` | Старые attribute names остаются допустимыми fallback formats | Current snapshot доказывает только `:game-data`; bundle/HTML не содержит legacy forms | Только static source order | Мёртвые fallback скрывают реальный current contract | P3 |
| SSR `current-user` `queue-peek.ts:198-231` | `/game-search` HTML содержит single-quoted JSON с id/authKey/subscription/Prime | Anonymous syntax: `game-search.html:177`; auth fields косвенно потребляет bundle `49846-50100` | Ничем для authenticated shape | Peek fail-closed с warning | P1 |
| Role sprite markers/path `role-faker.ts:106-129`; `player-notes.ts:3201-3246` | href содержит `/bundle/*.svg#civilian|sheriff|mafia|godfather`; fallback prefixes `/room/bundle/`/`/new-room/bundle/`; hash `f59…` | External `<use>` structure `room-main.pretty.js:44553-44589`; current export `21235-21237`; `/new-room/` не найден | `roleUse` class only; literals ничем | Dynamic discovery обычно спасает; fallback icons исчезают | P2 |
| Role tooltip nesting `role-faker.ts:196-236` | Native tooltip имеет `.tooltip > .content span` | Tooltip root/content/slot `room-main.pretty.js:42650-42699`; role slot span `44567-44584` | Ничем | Sprite меняется, tooltip может остаться старым; faker визуально врёт | P1 |

## 2. UI-Тексты И Локаль

| Где у нас | Что предполагаем | Доказательство сайта | Покрытие | При поломке / радиус | Приоритет |
|---|---|---|---|---|---|
| `selectors.ts:160-232`; `classifyPhaseText:289-356` | RU phase values содержат night/day markers | `RU.pretty.js:349-375,410-412,629,674,808-820` | Live contract + unit | Уже сторожится; drift fail тестом | покрыто |
| EN phase aliases `selectors.ts:175-185,201-213,227-231` | Реальные EN labels совпадают с best-effort списком | EN locale не загружен; RU bundle доказательством не является | Synthetic unit only; contract exempt | На EN OBS/role могут врать | **P0 EN** |
| `TEXT.acceptGameText/Button` `selectors.ts:233-244`; `auto-start.ts:211-255` | Search acceptance текст — `Принять игру`; generic aliases допустимы | Hardcoded `Принять игру`: `game-search.pretty.js:47423-47455`; другие RU aliases не связаны с branch | Unit; exact live label нет | Primary structural path спасает; fallback молчит | P2 |
| `TEXT.welcome/startGameButton` `selectors.ts:245-250`; `auto-start.ts:875-960` | Welcome/viewer labels: «Добро пожаловать», «Начать игру», «Режим зрителя», «Начать просмотр» | `RU.pretty.js:320-323`; wiring `room-main.pretty.js:32682-32690,32802-32812` | Player synthetic; viewer ничем | Start skip деградирует с warning | P1 |
| `TEXT.showRoles/hideRoles` `selectors.ts:251-253`; `auto-start.ts:1159-1174` | Menu text отражает role-display state; locale keys семантически инвертированы | `RU.pretty.js:679-680`; binding `room-main.pretty.js:49028-49031,49124-49151` | Ничем | Tracking stale, role visibility может инвертироваться | **P0** |
| `TEXT.readyButton` `selectors.ts:255-260`; `queue-requeue.ts:292-315,697-715` | Обе readiness labels ровно «Готов», без hotkey prefix | `RU.pretty.js:353-357`; ControlsButton `room-main.pretty.js:46023-46048,47044-47052` | Exact negative/active unit; no live exact | Requeue считает Ready не подтверждённым | P1 |
| `PAUSE_EXACT/RESUME_EXACT` `pause-hotkey.ts:18-47,109-140,294-321` | Proven labels «Пауза», «Продолжить игру», «Завершить» и `.without-hover` | `RU.pretty.js:360,678,808,810`; bindings `room-main.pretty.js:46069-46330,49214-49247` | Ничем | F8 lifecycle ломается/может выбрать generic text | **P0** |
| Unsupported pause aliases `pause-hotkey.ts:18-47` | «Перерыв», «Возобновить», EN и др. безопасны как fallback | Не доказаны current action; generic «Продолжить» есть в другом UI | Ничем | Контейнеры ограничивают, но broad fallback рискован | P2 |
| OBS stage-change `obs-panel.ts:794-849` | Prefix «до смены этапа» и numeric format стабильны | `RU.pretty.js:350,373-375`; use `room-main.pretty.js:45892-45906` | Не входит phase contract | Scene может переключиться поздно/неверно | P1 |
| OBS lift/miss/best-move `obs-panel.ts:817-879,936` | «Итоги подъема» — day; «Промах» — day; «Лучший ход» может быть stage | `RU.pretty.js:411,819`; «лучший ход» найден только в tooltip `200-201` | Miss покрыт; lift/best move нет | Lift fallback частично спасает; best move assumption dead | P1/P3 |
| Role tooltip prefix `role-faker.ts:196-236` | Native tooltip начинается `Ваша роль - ` | Formatter `RU.pretty.js:185-197` | Ничем | Дублированный/mixed tooltip; faker визуально врёт | P2 |
| Match role row `match-stats.ts:341-349` | Заголовок строки ровно `Роль` | `RU.pretty.js:257`; binding `room-main.pretty.js:54636-54650` | Ничем | На rename/EN весь enhance early-return молча | **P0** |
| Search labels «Играть», «Готовы», «Игра запускается», retry | Эти тексты не участвуют в operational matching | `game-search.pretty.js:47374,47416-47420,47563`; retry locale `RU.pretty.js:296-297` | Не нужен exact contract | Text-only drift безопасен | чисто |

## 3. Маршруты И Навигация

| Где у нас | Что предполагаем | Доказательство сайта | Покрытие | При поломке / радиус | Приоритет |
|---|---|---|---|---|---|
| `shared/routes.ts:8-16`; consumers `queue-requeue`, `obs-panel`, `diag` | Room `/game[/…]`, search `/game-search[/…]` | Search POST `/game`: `game-search.pretty.js:50244-50303`; room links `/game-search`: `room-main.pretty.js:39496-39514,40423-40431` | Route unit; no live route contract | Requeue/OBS/diag off | P1 |
| Duplicated gates `content/index.ts:69-75`; `auto-start.ts:184-190`; `queue-guard.ts`; `connection-diag.ts`; `queue-peek.ts` | Все predicates совпадают; auto-start `startsWith` не захватит near-prefix | Current route exact `/game-search` | Нет consistency invariant | `/game-searching` может получить auto-click scan | **P0** |
| `content/index.ts:53-121` | URL router 500мс достаточно; site navigation full-document | App paths используют form/location; History API только libraries | Нет direct router test | SPA drift даёт до 500мс stale state | P2 |
| Search→room full POST assumption `shared/routes.ts:8`; `queue-requeue.ts` | `on_game_found` создаёт POST `/game` с CSRF/game_id | `game-search.pretty.js:50244-50303` и второй handler `55028+` | Ничем | Lifecycle state может пережить будущий SPA/GET | P1 |
| `queue-requeue.ts:517,646`; root bridge | Site room exit ведёт на `location.origin`, затем extension на `/game-search` | `room-main.pretty.js:39561,56133,57360-57379` | Unit route state, navigation mocked | Новый finish path оставит bridge | P1 |
| `match-data.ts:30-31,58`; match consumers | Match route `/match/<segment>`, HTML GET same route | Server-side route; stable real pages, JS bundle не доказывает SSR | Route regex unit only | Match features молча off | P1 |
| `player-notes.ts:982-1025,2439-2483` | Profile route/link `/profile/<digits>` и SSR profile-user | Links `game-search.pretty.js:48779-48781`; snapshot `profile-1.html:147-148` | API contracts partial; SSR/path нет | Profile note resolution деградирует | P2 |
| `role-marker.ts:62-97` | Viewer/game ID query `game_id`; viewer route `/game?role=viewer&game_id=N` | `room-main.pretty.js:40168-40181` | Нет game-key unit | Role marks collide by roster fallback | P1 |
| Manifest `manifest.base.json:11-45`; `messaging.ts:86-90` | Все site origins остаются `*.polemicagame.com` HTTPS | Current main/game/het1 subdomains | Permission invariant internal only | New external origin loses injection/API | P1 |

## 4. HTTP И SOCKET API

| Где у нас | Что предполагаем | Доказательство сайта/API | Покрытие | При поломке / радиус | Приоритет |
|---|---|---|---|---|---|
| `player-notes.ts:138-155,1266-1303` | `GET game.../api/games` → array games, `players[].{id,username,mmr}` | Live anonymous API 06.08; game-search bundle использует `/api/games` | Ничем | Rating fallback; active users теряют ID/MMR | P1 |
| `player-notes.ts:158-217` | Ratings array `user_id,username`; `limit=1000` исполняется | Existing live contract `site-contract.test.ts:233-246` | Shape covered; limit semantics нет | Outside top list unresolved | P2 |
| `player-notes.ts:1305-1375` | Filtered aggregate/role endpoints; `first_killed_count`; scoring 2,3 filters | Profile bundle request construction; live API exact production query | Partial: fields/filters missing | Plausible zeros/wrong percentages | P1 |
| `player-notes.ts:3099-3177` | Games `{rows,totalCount}`, nested `role.type`, `result.code`, nullable `mmr.mmr_diff` | Profile bundle uses same nested fields; live API | Outer only | Рисует civilian/loss/+0 правдоподобно неверно | **P0** |
| `player-notes.ts:2439-2483` | Profile HTML `:profile-user='JSON'`, matching ID/username | Snapshot `profile-1.html:147-148`, SHA в baseline | Ничем | Numeric note lookup fail-closed | P2 |
| `match-data.ts:30-99` | Match HTML status 200 + exact `:game-data`; X-Requested-With harmless | Snapshot `match-314446.html:146-152`, SHA в baseline; fixture payload | Ничем live | Вся match feature молчит | **P0** |
| `queue-peek.ts:198-253` | `/game-search` SSR authenticated current-user and public `/api/search {queues}` | Anonymous page/API and game-search consumption | Ничем | Peek warning/fail-closed | P1 |
| `queue-peek.ts:42-68,277-479` | Raw Engine.IO 3 + Socket.IO parser protocol 4, namespace `/search`, credentials в URL+CONNECT, exact start/state/stop events; stop без args | Protocol constants `game-search.pretty.js:2937,21051-21069`; site client `50048-50100,50150-50252` | Ничем; hash only warns | Может оставить account в queue, отменить реальный поиск или собрать игру | **P0** |
| `match-data.ts`, profile fetches | Same-origin cookies/default credentials; match additionally X-Requested-With | Live anonymous endpoints worked; game-search auth SSR требует session | Частично network contract | Auth policy drift отключает feature | P1 |

## 5. ХРАНИЛИЩА САЙТА

| Где у нас | Что предполагаем | Доказательство/граница доверия | Покрытие | При поломке / радиус | Приоритет |
|---|---|---|---|---|---|
| `queue-requeue.ts:552-670`; `requeue-pending.ts` | `sessionStorage.pn_requeue_pending` переживает reload/navigation; JSON/timestamp валиден | Page-owned; сайт может подделать. Sliding TTL 45с, hard cap 10м | Strong property/unit | Forged fresh mark + matching DOM может инициировать navigation | P1 |
| `player-notes.ts:1750-1769` | `pn_flipped_players` — JSON array short strings | Page-owned; array/type checked, no count/length cap | Ничем | Site создаёт huge set/неожиданные flips | P2 |
| `FloatingPanel.ts:352-417` | `fp:obs-panel`, `fp:twitch-panel` geometry parseable | Page-owned; finite/positive/clamped | Ничем | Cosmetic reposition only | P3 |
| `twitch-panel.ts:57-121` | `fp:twitch-panel:prefs` schema | Page-owned; strict enums/ranges/types | Ничем | Visual preferences changed, no authority | P3 |
| `core/log.ts:33-50,87` | `polemica:loglevel` controls console only | Page-owned; allowlist. Buffer threshold fixed | Нет direct test | Site suppresses/raises console, export unaffected | P3 |
| `core/log.ts:9-10,38` | Comment mentions `polemica:buflevel`, runtime does not read it | No operational dependency | Нет negative invariant | Future privacy regression if restored | P2 |
| Popup `polemica:popupTab` | Extension-origin localStorage, not site-owned | `popup/index.ts:282-305`, allowlisted by actual tabs | Нет direct test | Wrong popup tab only | P3 |

## 6. ФОРМАТЫ ДАННЫХ

| Где у нас | Что предполагаем | Доказательство | Покрытие | При поломке / радиус | Приоритет |
|---|---|---|---|---|---|
| `match-data.ts:65-89` | JSON raw-first; nested `data`; top-level fallback не равен nested | `legacy/match_314446.json`; `docs/fixtures/match_598995.json`; server SSR | Parse order invariant; extractor нет | Match feature молча off/shape mismatch | P0 |
| `match-stats.ts:334-337,670,742`; `tooltip.ts:165-197` | `data.players` uses `position/role:number`; top-level uses `tablePosition/role.type` | Real fixtures and bundle table | Ничем для precedence | Names/roles/cells wrong | P1 |
| `match-outcome.ts:16-94`; `match-stats.ts:920-937` | votes num 0/1/2; null/absent = lift ballot; strict yes>no; departed array | Legacy + match 598995 | Strong real-fixture unit | Защищено | покрыто |
| `match-stats.ts:901-960` | Shots `{night,shooter,victim}`, checks `{night,role,player}`; check roles 0/3 | Real fixtures | Ничем | Undefined origin/wrong night/best move | P1 |
| `match-stats.ts:266-282,742-744,906-907` | Nested role codes `0=don,1=mafia,2=civilian,3=sheriff` | Real fixtures, top-level role.type correspondence | Incidentally only | Wrong colors/attribution silently | P1 |
| `match-stats.ts:162-167` | Raw SSR `winnerCode=0` мирные, `1` mafia; другие значения пока не доказаны | Raw fixtures: `match_314446.json:6,781-855` (`1`, mafia/godfather winners), `match_610180.json:6,605-741` (`0`, civilian/sheriff winners) | Ничем explicit; current mapping подтверждён fixtures | Новый raw code молча считается mafia | P1 |
| Room statistics API `winnerCode` (не direct consumer текущего parser) | Этот отдельный payload использует `1=red`, `2=black`, default neutral | Bundle switch `room-main.pretty.js:54693-54704`; payload загружается отдельным `getStats` path `57299-57323`; locale red/black `RU.pretty.js:245-253` | Ничем, но форматы не смешиваются | Риск будущего смешения двух одноимённых полей | P2 |
| `match-stats.ts:669-731` | Multiple guesses; `mafs/civs/vice/completed`; firstKilled не position | Real fixtures; bundle resolves firstKilled by player id | Ничем renderer | Best-move dots wrong/пропадают | P2 |
| `match-stats.ts:901-918` | maxDay dynamic over votes/shots/checks; arrays may be nonempty; player order usable | Fixtures; bundle has daysNumber | Нет empty/high/sparse/order tests | Empty gives `Math.max=-Infinity`; whole table may fail | P1 |
| `match-stats.ts:1097-1185` | Во всём `.game-stats-table` две последние rows семантически total и MMR | DOM order: последняя row — footer sum, предпоследняя — последняя main row; MMR отсутствует: `room-main.pretty.js:54981-55133` | Ничем | Current ordinal code стилизует footer sum как MMR, последнюю main row как total | P2 |
| `queue-requeue.ts:583-595` | Disband `M{1,3}:SS`, seconds 00–59 | Formatter `room-main.pretty.js:45876-45890` | Strong parser unit; no live formatter contract | Requeue start/disband discrimination | P1 |
| Search `0:SS` | Search stopwatch может быть `0:60`, но нигде не парсится | `game-search.pretty.js:49730-49756` | Liveness unit | Text format drift безопасен | чисто |
| `obs-panel.ts:837-846` | Stage timer numeric RU/EN regex matches actual declensions | `RU.pretty.js:350,373-375` | Ничем | OBS transition detection late/stale | P2 |
| API values `player-notes.ts` | Numeric strings coercible; null MMR means currently `0`; unknown result = loss | Live profile API/profile bundle | Partial outer shape | Plausible false stats/history | P1 |
| Camera/settings hashes `auto-start.ts:976-1029`; `pause-hotkey.ts:89-105` | Hash substring связан с назначением control, order fallback безопасен | Imports/exports и controls `room-main.pretty.js:21109-21249,47380-47435` | Ничем | Wrong click camera/mic/settings | **P0** |
| Role sprite format `role-faker.ts:106-129`; `player-notes.ts:3201-3246` | `/bundle/*.svg#role`, fallback prefix/hash | `<use>` `room-main.pretty.js:44553-44589`; export `21235-21237` | Ничем | Missing role/history icon, без action | P2 |

## 7. ПОВЕДЕНЧЕСКИЕ КОНТРАКТЫ

| Где у нас | Что предполагаем | Доказательство сайта | Покрытие | При поломке / радиус | Приоритет |
|---|---|---|---|---|---|
| `queue-requeue.ts:738-747,837-860` | `game_not_accepted` делает full reload | `game-search.pretty.js:50226-50242` | Unit bridge; live behavior нет | Stage-1 requeue молча ломается | P1 |
| `queue-requeue.ts:837-862` | Accepted card persists and changes class/content | `game-search.pretty.js:47377-47455,49624-49631` | Unit; no semantic contract | State machine врёт/действует | P0 |
| `queue-requeue.ts:879-892` | Loader предшествует random 0–10с POST `/game`; loader зависание считается start | `game-search.pretty.js:50244-50303` | Ничем | Lost POST оставляет вечный «Игра запускается» | P1 |
| Queue-peek terminal recognition | Второй `on_game_found` path имеет 1с и другой payload, но тоже terminal | `game-search.pretty.js:55028+` | Ничем | Сейчас recognition безопасен; универсальный payload-test был бы ложным | P3 |
| `queue-requeue.ts:342-519` | `on_game_disbandment` только запускает countdown; disappearance требует discrimination | `room-main.pretty.js:40002-40004,45876-45890` | Strong unit; no event contract | Regression может выдернуть из match | P0 |
| `queue-requeue.ts:223-235,419-450` | Hidden animation catch-up одним elapsed callback; stale sample нельзя считать start | `room-main.pretty.js:58424-58468,45876-45890` | Regression unit | При удалении защиты requeue навсегда off | P0 |
| `queue-requeue.ts:82-96,444-460` | 12с grace достаточно для появления running DOM stage после исчезновения disband timer | `on_start_stage` ставит `gameDidStart` сразу, но `setStage` откладывает на server `e.countdown` без upper bound: `room-main.pretty.js:56303-56353`; timer очищается по `gameDidStart`: `45876-45890` | Нет adversarial >12с contract | Может уйти из реально начавшегося match | **P0 contract risk** |
| Error classifier | Direct `on_stop_game`, session, auth, strike сохраняют button matrix | `room-main.pretty.js:39494-39537,40161-40197,40411-40449,40560-40594` | Structural units; producers не contract | Wrong action/stranded user | P0/P1 |
| Socket disconnect | `disconnect` DOM одинаков, но reconnect зависит от reason/`socket.active` | Site handler игнорирует reason: `room-main.pretty.js:39468-39490`; Socket.IO 4.7.5 `58404` | Ничем | Terminal disconnect выглядит transient; user stranded | P1 |
| Reconnect errors | Site terminal handler должен жить, но подписан `socket.on` вместо Manager `socket.io.on` | `room-main.pretty.js:39481-39514`; bundled Manager semantics | Ничем | Handler недостижим, бесконечный reconnect modal | P1 |
| Roller partition | `.new-stage`, `.stage`, fixedState mutually exclusive | `room-main.pretty.js:45206-45589` | Unit partial; no bundle semantic contract | Requeue/OBS ownership wrong | P0 |
| OBS timing `obs-panel.ts:967-1032`; shared flush | После вызова `setStage` site transition 250мс, extension debounce 150 + confirm 350мс | Site `animationDuration=250` и commit: `room-main.pretty.js:45709-45720,45929-45940`; shared observer 250мс | Нет cross-timing test | При росте site duration phase confirmation может схватить transitional DOM; role/scene briefly wrong | P0 |
| OBS unknown 8с, ownership stale 90с, poll 2с | Network/state delivery fits heuristic budgets | Bundle не задаёт upper bounds | Ownership units only | Diagnostics/scene stale, usually fail-hold | P2 |
| Search ARM 8с, click 1.2с, pending refresh/TTL | Site search dynamics stay within fail-closed budgets | Search POST up to 10с исключён loader branch; accepted duration server-controlled | Requeue liveness strong; no live duration | Deadline/TTL отказ fail-closed с логом | P2 |
| Shared observer `dom.ts:81-137` | childList+class/style sufficient; text-only consumers own polling | Vue2 text node and Vue3 element-text differ; bundle renderer paths | Only single-observer invariant | Missing wakeups or adding characterData causes perf regression | P1 |
| Role menu behavior | Text branch and roleDisplay state remain aligned | `room-main.pretty.js:49028-49151`; `RU.pretty.js:679-680` | Ничем | Автомат может показать роль вместо скрытия | P0 |
| Queue-peek stop lifecycle | Stop confirmation arrives; close/timeout leaves server state safe | Current game-search protocol only; no sacrificial live transcript | Ничем | Account-bound queue side effect | P0 |

## Радиус Поражения

| Радиус | Точки |
|---|---|
| Действие за игрока | accept generic fallback; camera positional fallback; F8 broad menu; requeue error/readiness/timing; queue-peek start/stop protocol |
| Streaming/privacy | own-role DOM; role menu semantic inversion; OBS phase/timing |
| Фича врёт | history nested fields; role codes; ordinal semantic-row selection across table roots; role-marker fallback key |
| Фича целиком исчезает | SSR `:game-data`; exact `Роль`; route/path drift; profile/current-user SSR |
| Fail-closed с сообщением | queue counts/credentials; unknown modal; many requeue ambiguous screens |
| Косметика | stale Vue scope IDs; floating-panel storage; role sprite fallback |

## Приоритетные Дыры

Это только точки, где existing coverage не доказывает опасную семантику.

1. **P0 — Queue-peek Socket.IO transcript:** account-bound start/stop без одного
   protocol test (`queue-peek.ts:42-68,277-479` ↔
   `game-search.pretty.js:50048-50252`).
2. **P0 — Camera/F8 hashes и order:** selector существует, но wrong control
   может быть кликнут (`auto-start.ts:976-1029`, `pause-hotkey.ts:89-105` ↔
   `room-main.pretty.js:21109-21249,47380-47435`).
3. **P0 — Match SSR:** `:game-data` live extraction не сторожится
   (`match-data.ts:65-84`; bundle не может доказать server HTML).
4. **P0 — Acceptance semantics:** class presence не доказывает связь
   `cursor-pointer ⇔ !group.ready`; drift снова ломает requeue/auto-click
   (`queue-requeue.ts:837-862` ↔ `game-search.pretty.js:47383-47393,49624-49631`).
5. **P0 — RU-only role row:** rename/EN полностью выключает enhance
   (`match-stats.ts:341-349` ↔ `RU.pretty.js:257`,
   `room-main.pretty.js:54636-54650`).
6. **P0 — Role visibility semantic contract:** class/text presence не доказывает
   direction (`selectors.ts:251-253`, `auto-start.ts:1159-1174` ↔
   `RU.pretty.js:679-680`, `room-main.pretty.js:49028-49151`).
7. **P0 — 12с disband/start grace:** bundle допускает server-controlled delay
   без upper bound; wrong decision уводит из матча.
8. **P0 — Error producer matrix:** unit моделирует structure, но live bundle
   producer может изменить button set и превратить fail-closed в wrong action.
9. **P0 — EN locale отсутствует в contract:** phase/role/welcome/pause assumptions
   best-effort и не доказаны.
10. **P1 — Nested HTTP shapes и production filters:** current contract shallow;
    plausible zeros/losses не падают.

## Добивка Contract-Тестов

| Спецификация теста | Что проверяет | Мутационный критерий |
|---|---|---|
| Acceptance state AST/text | В branch `searchState.group`: `cursor-pointer: !isGameAccepted`; `isGameAccepted=group.ready`; unaccepted text `Принять игру` | Инверсия/removal class binding, card replacement, label rename обязаны уронить |
| Search lifecycle | `on_stop_game_search` exact `game_not_accepted → reload`; normal and lobby `on_game_found` отдельно; POST `/game` fields/timings | Rename reason, SPA/GET, missing `game_id`/CSRF, merge двух payload должны уронить |
| Welcome labels by locale key | `welcome/connect_to_game/viewer_mode/start_watching` входят в accepted source markers и реально передаются modal | Rename value/key или removal viewer branch падает |
| Readiness exact contract | Обе readiness values = accepted exact marker; active bound to `voted`; hotkey span не входит в text | `Не готов`, prefix `RГотов`, removal active binding падают |
| Role menu direction | `roleDisplayText` выбирает правильные locale keys для текущего state; source arrays содержат их значения | Swap branch semantics/value или removal marker падает |
| Pause/resume contract | Pause action wired to `startPause`; `continue_game_button_not_ready`/`end_pause` accepted; `.without-hover` structure | Label rename, detach handler, remove `.without-hover`, icon/hash drift падают |
| Stage timer locale | `next_stage_timer` и `before_next_stage(1,2,5,21)` нормализуются parser'ом | Prefix/order/declension/NBSP mutation падает |
| Camera/settings exports + DOM state/order | Все source hashes существуют; known icon maps to correct control; `.off ⇔ !videoTrackAvailable`; unknown reorder не вызывает positional wrong click | Swap camera/mic, reorder 3 buttons, remove settings hash или invert/remove `.off` binding падает |
| Role tooltip structure | Role slot остаётся `.tooltip > .content span`, prefix formatter согласован с parser | Remove content/span, move slot, change RU prefix/punctuation падает |
| F8 DOM transcript | Open settings, find pause, close only own menu; resume ordinary/judge; navigational `<a>` не click | Menu class/structure/label/hash mutation или wrong anchor click падает |
| Room terminal producer matrix | Для каждого handler: event, delay, link/action count, href; strike/session/auth/direct stop distinct | Добавить home/retry к stop, удалить href, сделать strike one-link падает |
| Effective room socket recovery | Для каждого terminal/transient reason существует наблюдаемый recovery/error: корректный Manager handler **или** extension watchdog; внутренний site emitter не замораживается как обязательный defect | Удаление и Manager handler, и watchdog падает; перенос `socket.on`→`socket.io.on` проходит |
| Roller partition | Exact `voting_for_game_start → new-stage`; others → stage; fixedState replaces roller; fixed classes exact | Concurrent states/class rename/ternary inversion падают |
| Roller-vs-OBS timing | Extract site transition duration; extension confirm > duration с margin | Site duration ≥ confirm, removal/reduction confirm падает |
| Disband-vs-server countdown | `gameDidStart` может очистить timer до DOM stage; decision учитывает server `e.countdown`, а не фиксированные 12с | Fixture `e.countdown=12_500` с timer removal и late stage обязан не вызвать navigation; removal safety gate падает |
| Observer invariant + renderer fixtures | Один observer, exact options; Vue2 characterData и Vue3 childList fixtures; text consumers имеют owned polling | Add characterData/drop class/childList/add observer/remove owned polling падает |
| Match SSR live | Stable `/match/id`: exact `:game-data`, raw JSON, matching ID, `data.players/votes/shots/checks`; unit mock отдельно проверяет наш `X-Requested-With` | Attribute/quotes/JSON/ID response drift или removal request header wiring падает |
| Match schema fixtures | Nested vs top players; roles 0..3; shot/check/guess/penalty; empty/high/sparse days | Move arrays top-level, role permutation, rename fields, empty crash падает |
| Raw winner semantics | Fixture-backed label: `0=peaceful`, `1=mafia`; unknown raw code даёт neutral/review, а room API semantics тестируются отдельно | `!==0` для unknown, swap 0/1 или перенос room-API `1/2` mapping в raw parser падает |
| Match table roots | Явно распознать header/main/footer roots; phase rows идут в owner с position/username/role; sum берётся из footer, MMR только если реально есть | Fixtures с reordered/extra main rows и без MMR обязаны всё ещё выбрать semantic sum; мутация реализации к ordinal last-two либо removal role-owner selection падает; безопасное объединение roots допустимо |
| Profile API production queries | Exact filters; aggregate `first_killed_count`; history nested `role.type/result.code/mmr_diff` | Ignore filters, rename nested/field, null→fake zero падает |
| `/api/games` | Array games and `players[].id/username/mmr` | Root wrapper, players→users, id→user_id падает |
| Queue HTTP/SSR | `/api/search` modes+players type; sanitized auth SSR fixture current-user fields | queues rename, string/object players, current-user/auth/subscription rename падает |
| Queue WebSocket transcript | Fake WS: EIO3 handshake, namespace connect, ping/pong, start, every refusal, stop ack, timeout/abort cleanup | Event/namespace/EIO/payload/stop args/cleanup mutation падает |
| Profile/participants SSR | `:profile-user`, ID equality, `/profile/id`, participant child structure | Attribute/link/ID mismatch or broad username parser падает |
| Page-storage property tests | flipped cap, panel box clamp, prefs schema, loglevel not buffer; buflevel negative invariant | Huge arrays, nonfinite geometry, inherited prefs, buffer-level restoration падает |

Live mutating queue socket test не запускать на пользовательском аккаунте:
protocol проверять fake transcript; live — только sacrificial account с
гарантированным `stop_game_search` confirmation.

## Проверено И Чисто

- Все SHA совпали; `npm run test:contract` прошёл: 3/3.
- Non-allowlisted `SITE` classes сейчас присутствуют в live bundles.
- RU phase labels и classifier покрыты live contract; не включены в список дыр.
- Lift ballot и vote rounds 0/1/2 корректно отделены и хорошо покрыты real
  fixtures; `departed` — массив.
- `firstKilled` подтверждён как user ID; production сейчас не трактует его как
  position.
- Число дней не захардкожено; phase IDs exact, поэтому day 1 не матчится с 11.
- Search stopwatch `0:SS` не парсится и не зависит от format.
- Requeue pending валидирует future/corrupt/sliding TTL/hard cap и имеет strong
  tests; page-owned источник явно считается недоверенным.
- Ambiguous room errors fail-closed; strike home+search сейчас не проходит narrow
  classifier.
- Pause и mafia miss не считаются завершением матча; fixed-state distinctions
  покрыты unit tests.
- OBS и queue-requeue имеют owned polling/timers для известных text-only/frozen
  paths; второй production MutationObserver не найден.
- Queue-peek не логирует authKey/body; network failures в HTTP phase fail-closed.
- Extension-owned selectors (`data-phase`, `data-player`, `.penalty-dot`, OWN,
  `data-pn-*`) отделены от site contracts и не объявлены drift сайта.
- Site localStorage media/login/queue keys расширение не читает; collisions с
  нашими page-owned keys не найдены.
- Routes/permissions остаются внутри HTTPS `*.polemicagame.com`; query/fragment
  не попадают в support log.

## Итог

Нынешний live contract отвечает на вопрос «строка/класс ещё где-то есть», но не
на главный вопрос недели: «означает ли она всё ещё то состояние, которое мы ей
приписываем». Первый пакет добивки должен закрыть P0 behavioral contracts:
queue transcript, camera/F8 controls, match SSR/table structure, role visibility,
readiness/error matrices и roller/OBS timing. Только после этого bundle drift
будет превращаться в конкретный failing contract, а не в очередную жалобу без
диагноза.
