# Неофициальный API polemicagame.com (разведка 2026-07-26)

Маршруты вытащены из `bundle/main.js` (53 шт.) и проверены живьём в браузере.
**Оговорки**: API неофициальный — может измениться без предупреждения; проверка
шла под залогиненным аккаунтом — доступность без сессии НЕ подтверждена
(перепроверить перед использованием в фичах). Имена параметров
непоследовательны: где-то `user_id`, где-то `userId` — не «исправлять».

## Проверенные живые эндпоинты (все GET, JSON)

### Статистика игрока (страница профиля)

- `/profile/default/get-statistic?user_id=<id>` — игры/победы по ролям:
  ```json
  {"civilian":{"type":"civilian","label":"Мирный","games_count":2888,"wins_count":1113},
   "sheriff":{...},"mafia":{...},"godfather":{...}}
  ```
- `/profile/default/get-role-statistic?user_id=<id>` — агрегат (массив из 1 объекта):
  ```json
  [{"games_count":4822,"wins_count":2327,"points":2578.45,"extra_points":1027.62,
    "first_killed_count":612,"fouls_count":2963,"tech_fouls_count":125,
    "best_move_points":132.30}]
  ```
- `/profile/default/get-games?userId=<id>&page=1&limit=10` — история игр
  (ВНИМАНИЕ: здесь `userId` camelCase!). Ответ `{rows:[...], totalCount:N}`;
  каждая row: `id` (matchId), `game_mode{value,title}`, `date_start/date_ends`,
  `duration`, `points`, `role{type,title}`, `result{title,code}`,
  `mmr{mmr,mmr_diff}` (бывает `null`). **`rows[0].mmr.mmr` = текущий MMR
  любого игрока** — закрывает остаток техдолга №3 (MMR вне топ-1000).
- `/profile/default/get-statistic-filters` — словари фильтров: types
  (league/lobby/club/competition/tournament), roles, scorings (1.x/2.x/3.x).
  Синтаксис передачи фильтров в get-statistic не разгадан
  (`types[]=league` молча игнорируется) — сайт, вероятно, шлёт иначе.

### Рейтинг и живые игры

- `/ratings/default/get-list?page=<n>` — рейтинг-лист (расширение уже
  использует): `user_id, username, avatar_url, mmr, total_games, points,
  twitch_link, subscription, primeMember`.
- `/current-games/get-current-games` — все текущие лобби/игры: `gameId,
  gameMode, name, hasPassword, gameIsStarted, playersNumber` + массив
  `players` с `{id, username, avatar_url, mmr, stream{link,active},
  subscription, primeMember, quit}`. Позволяет резолвить ник→user_id ещё
  в лобби, ДО старта игры (ранняя миграция заметок на id-ключи).
- `/game-history/get-today-games-count`, `/game-history/get-today-gamers-count`
  — голые числа.

### Страница матча

JSON-эндпоинта данных матча НЕТ (перебор кандидатов — 404). `/match/<id>` —
только SSR-HTML с `data-game='...'`; регэксп-парсинг в match-data.ts —
единственный путь, это подтверждённая необходимость, а не костыль.

## Матчмейкинг и лобби: socket.io, не REST

Постановка в очередь / поиск игры не делает НИ ОДНОГО HTTP-запроса —
всё через socket.io (`/socket.io` в бандле). По HTTP страница поиска лишь
поллит `get-current-games` раз в несколько секунд. События из бандла:

- сервер→клиент: `on_game_found` (push «игра найдена» — мгновенный),
  `on_connected_to_lobby`, `on_lobby_created`, `on_lobby_destroyed`,
  `on_error_connecting_to_lobby`, `redirect_to_game`, `session_initialized`;
- клиент→сервер: `set_readiness` (кнопка «Готов»), `stop_game_search`,
  `connect_to_lobby`, `create_lobby_in_media_room`, `quit_lobby`,
  `quit_game`, `set_lobby_name/password`, `set_judge`, `set_lobby_leader`,
  `kick_out_player`, `update_lobby_data`.

Решение (2026-07-26): автопринятие ОСТАЁТСЯ DOM-кликом. Слать
`set_readiness` в сокет из page-world можно, но это хрупко (ломается любым
обновлением сайта) и отличимо от человека на сервере; DOM-клик — нет.

## Прочие маршруты из бандла (не проверялись, для справки)

auth: `/auth/login|logout|register|social-login`; кабинет:
`/cabinet/update-profile|apply-promocode|...`; `/notifications/clear|see`;
`/tournament/get-games|get-game-statistics|save-statistics`;
`/ratings/default/get-prime-list|get-peaceful-viewer-list`; `/rating/get`
(404 на все опробованные параметры); `/watch-game-stream/has-active-streams`
(`/watch-game-stream/streams` — 404 без параметров); `/re-captcha/get-site-key`;
`/site/perfect-table`, `/api/tables/media-servers`.

## Правила использования в расширении

1. Любая фича на этих эндпоинтах — с TTL-кэшем и честным фолбэком
   (образец — кэш `ratings/default/get-list` в статистике).
2. Не долбить сервер: batch/кэш, никаких запросов в цикле по игрокам без
   дросселя.
3. Перед постройкой фичи перепроверить эндпоинт в анонимной сессии.
