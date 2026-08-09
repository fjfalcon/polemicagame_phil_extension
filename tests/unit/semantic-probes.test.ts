import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  gameSearchProbes,
  roomProbes,
  ruLocaleProbes,
  runProbes,
  roomCssProbes,
  siteCssProbes,
  siteRollerAnimationMs,
} from "../contract/semantic-probes";

/**
 * Офлайн-половина семантического контракта: пробы гоняются по РЕАЛЬНЫМ
 * фрагментам бандлов (tests/fixtures/bundle-snippets, вырезаны из живых
 * файлов 06.08.2026), а затем по мутированным копиям — так мутационный
 * критерий каждой пробы проверяется без сети. Живая половина — в
 * tests/contract/site-semantics.test.ts, те же пробы по свежескачанным
 * бандлам.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const snip = (name: string) =>
  fs.readFileSync(path.join(ROOT, "tests/fixtures/bundle-snippets", name), "utf8");

const GS = snip("game-search.txt");
const ROOM = snip("room-main.txt");
const RU = snip("ru-locale.txt");
const CSS = snip("main-css.txt");
const ROOM_CSS = snip("room-css.txt");

describe("пробы зелёные на реальных фрагментах бандлов", () => {
  test.each([
    ["game-search", gameSearchProbes, GS],
    ["room-main", roomProbes, ROOM],
    ["RU-локаль", ruLocaleProbes, RU],
    ["main.css", siteCssProbes, CSS],
    ["room/style.css", roomCssProbes, ROOM_CSS],
  ] as const)("%s", (_name, probes, text) => {
    const failed = runProbes(probes, text).filter((r) => !r.ok);
    expect(failed, failed.map((f) => `${f.name}: ${f.detail}`).join("\n")).toEqual([]);
  });

  test("длительность анимации роллера извлекается", () => {
    expect(siteRollerAnimationMs(ROOM)).toBe(250);
  });
});

/**
 * Мутации: каждая имитирует конкретный дрифт сайта и обязана уронить РОВНО
 * свою пробу. Проба, переживающая свою мутацию, — вакуумная.
 */
describe("каждая проба умирает от своего дрифта", () => {
  const cases: Array<[string, Record<string, (t: string) => { ok: boolean }>, string, string, (t: string) => string]> = [
    // game-search
    ["acceptCursorBinding: инверсия байндинга", gameSearchProbes, "acceptCursorBinding", GS,
      (t) => t.replace('"cursor-pointer":!', '"cursor-pointer":')],
    ["acceptedIsGroupReady: ready → accepted", gameSearchProbes, "acceptedIsGroupReady", GS,
      (t) => t.replace(/\.ready\}/, ".accepted}")],
    ["notAcceptedReloads: reload заменён модалкой", gameSearchProbes, "notAcceptedReloads", GS,
      (t) => t.replace("window.location.reload()", 'x.showModal("y")')],
    ["acceptLabel: подпись переименована", gameSearchProbes, "acceptLabel", GS,
      (t) => t.replace("Принять игру", "Подтвердить участие")],
    ["postFormToGame: POST → GET", gameSearchProbes, "postFormToGame", GS,
      (t) => t.replace('setAttribute("method","post")', 'setAttribute("method","get")')],
    ["decideBlockButtons: «Покинуть игру» переименована", gameSearchProbes, "decideBlockButtons", GS,
      (t) => t.replace("Покинуть игру", "Выйти из игры")],
    ["quitOpensConfirmThenApi: эндпоинт выхода переехал", gameSearchProbes, "quitOpensConfirmThenApi", GS,
      (t) => t.replace("/api/games/quit", "/api/games/leave")],
    ["confirmQuitWiring: подтверждение перестало выходить", gameSearchProbes, "confirmQuitWiring", GS,
      (t) => t.replace("quitGame(!0)", "closeModal()")],
    ["confirmQuitWiring: у модалки появился ban-проп", gameSearchProbes, "confirmQuitWiring", GS,
      (t) => t.replace('ConfirmQuitGameModal",{on:', 'ConfirmQuitGameModal",{attrs:{ban:30},on:')],
    ["confirmQuitButtonLabel: «Покинуть лобби» переименована", gameSearchProbes, "confirmQuitButtonLabel", GS,
      (t) => t.replace("Покинуть лобби", "Да, выйти")],
    ["playDisabledBinding: disabled отвязан от очередей", gameSearchProbes, "playDisabledBinding", GS,
      (t) => t.replace(/attrs:\{disabled:!(\w+)\.selectedCensorshipModes\.length\}/, "attrs:{disabled:!$1.queuesOk}")],
    ["inGameModalWiring: выход из модалки перестал слать quit_game", gameSearchProbes, "inGameModalWiring", GS,
      (t) => t.replace('emit("quit_game")', 'emit("leave_game")')],
    ["searchBtnLoaderBinding: лоадер сменил класс", gameSearchProbes, "searchBtnLoaderBinding", GS,
      (t) => t.replaceAll("p-play__profile-game-loader-gradient", "p-play__profile-game-spinner")],
    ["searchDisabledWhileInGame: userInGame больше не запрещает поиск", gameSearchProbes, "searchDisabledWhileInGame", GS,
      (t) => t.replace(/searchDisabled:function\(\)\{return ((?:\w+|this))\.gameSearchDisabled\|\|(?:\w+|this)\.userInGame/, "searchDisabled:function(){return $1.gameSearchDisabled||$1.busy")],
    // room
    ["readyActiveBoundToVoted: active отвязан от voted", roomProbes, "readyActiveBoundToVoted", ROOM,
      (t) => t.replace(/\{active:(\w+(\.\$parent)?)\.votingForGameStart\.voted\}/, "{active:$1.votingForGameStart.inProgress}")],
    ["envelopeCarriesRoomState: конверт перестал везти состояние", roomProbes, "envelopeCarriesRoomState", ROOM,
      (t) => t.replace('"roomState"===', '"gameState"===')],
    ["pauseIsFrozenTimer: признак паузы переименован", roomProbes, "pauseIsFrozenTimer", ROOM,
      (t) => t.replaceAll(".timer.passed", ".timer.stopped")],
    ["pauseStatusFromTimer: пауза отвязана от таймера", roomProbes, "pauseStatusFromTimer", ROOM,
      (t) => t.replace('gameIsPaused&&Nd.commit("updatePauseStatus"', 'gameIsPaused&&Nd.commit("updateStage"')],
    ["rollerPregameTernary: стадия переименована", roomProbes, "rollerPregameTernary", ROOM,
      (t) => t.replace('"voting_for_game_start"===', '"lobby_gathering"===')],
    ["disbandmentStartsCountdown: роспуск делает больше", roomProbes, "disbandmentStartsCountdown", ROOM,
      (t) => t.replace("startDisbandmentCountdown", "leaveRoomImmediately")],
    ["startStageSetsGameDidStart: коммит пропал", roomProbes, "startStageSetsGameDidStart", ROOM,
      (t) => t.replace("setGameDidStart", "setStageOnly")],
    ["stopGameMatrix: у роспуска появился home", roomProbes, "stopGameMatrix", ROOM,
      (t) => {
        const at = t.indexOf('on("on_stop_game"');
        return t.slice(0, at + 400) + "link_home_redirect" + t.slice(at + 400);
      }],
    ["selfStrikeMatrix: у исключения пропал home", roomProbes, "selfStrikeMatrix", ROOM,
      (t) => {
        const at = t.indexOf('on("on_self_strike"');
        const w = t.slice(at);
        return t.slice(0, at) + w.replace("link_home_redirect", "link_removed");
      }],
    ["sessionDroppedMatrix: у сессии появилась ссылка на поиск", roomProbes, "sessionDroppedMatrix", ROOM,
      (t) => {
        const at = t.indexOf('on("on_session_dropped"');
        return t.slice(0, at + 100) + "link_search_game" + t.slice(at + 100);
      }],
    ["cameraOffBinding: off отвязан от videoTrackAvailable", roomProbes, "cameraOffBinding", ROOM,
      (t) => t.replace("{off:!this.$store.state.videoTrackAvailable}", "{off:!this.$store.state.cameraMuted}")],
    ["roleMenuDirection: ветки поменяны местами", roomProbes, "roleMenuDirection", ROOM,
      (t) => t.replace(
        "roleDisplay?this.$root.Loc.hide_roles:this.$root.Loc.show_roles",
        "roleDisplay?this.$root.Loc.show_roles:this.$root.Loc.hide_roles",
      )],
    ["withoutHoverContinue: класс переехал", roomProbes, "withoutHoverContinue", ROOM,
      (t) => t.replace('class:"without-hover"', 'class:"no-hover"')],
    ["sumRowTitle: «Итог» переименован", roomProbes, "sumRowTitle", ROOM,
      (t) => t.replace('code:"sum",title:"Итог"', 'code:"sum",title:"Сумма"')],
    ["statsCellClasses: title-ячейка сменила класс", roomProbes, "statsCellClasses", ROOM,
      (t) => t.replace(/\["cell","title",(\w+)\.code\]/, '["cell","header",$1.code]')],
    // main.css
    ["tileIsPositioningRoot: плитка перестала быть точкой отсчёта", roomCssProbes, "tileIsPositioningRoot", ROOM_CSS,
      // Без relative у .player наши углы считались бы от документа — плашка
      // улетела бы в угол экрана.
      (t) => t.replace("position:relative", "position:static")],
    ["plateContainerAnchored: контейнер плашки сменил угол", roomCssProbes, "plateContainerAnchored", ROOM_CSS,
      (t) => t.replace("left:.625rem", "right:.625rem")],
    ["cornerMenusAbsolute: угловые контейнеры больше не absolute", roomCssProbes, "cornerMenusAbsolute", ROOM_CSS,
      (t) => t.replace("position:absolute", "position:static")],
    ["statsRowScoped: раскладка строки перестала быть scoped", siteCssProbes, "statsRowScoped", CSS,
      // Сайт «расскопил» правило: наши строки перестают его получать по
      // атрибуту — и таблица держится только на нашем фолбэк-CSS.
      (t) => t.replace(/\.table \.row\[data-v-[a-f0-9]+\]\{/, ".table .row{")],
    ["statsCellScoped: ячейка потеряла flex", siteCssProbes, "statsCellScoped", CSS,
      // Именно `;flex:1`, а не «flex:1»: подстрока живёт и в префиксных
      // -webkit-box-flex/-ms-flex, и наивная замена мутировала бы их.
      (t) => t.replace(";flex:1;", ";flex:none;")],
    ["statsCellWidths: ширины колонок изменились", siteCssProbes, "statsCellWidths", CSS,
      (t) => t.replace("min-width:115px", "min-width:140px")],
    ["deadPlayerBecomesViewer: умерший больше не зритель", roomProbes, "deadPlayerBecomesViewer", ROOM,
      // replaceAll: путь зрителя встречается в окне self_strike дважды
      // (немедленный редирект и ссылка continue_as_viewer).
      (t) => t.replaceAll('"/game?role=viewer&game_id="', '"/spectate?game_id="')],
    ["pauseInitiatorInState: инициатор пропал из состояния игры", roomProbes, "pauseInitiatorInState", ROOM,
      // Единственный источник «кто поставил паузу» — если сайт уберёт поле,
      // фича замолчит, и узнать об этом надо тестом, а не по жалобе.
      (t) => t.replace(/\.pause\.initiatorId/g, ".pause.startedBy")],
    ["pauseInitiatorReachesHandler: id больше не доезжает до обработчика паузы", roomProbes, "pauseInitiatorReachesHandler", ROOM,
      (t) => t.replace("initiatorId:f", "unused:f")],
    ["playerInfoPlate: у плашки пропал сайтовый клик превью", roomProbes, "playerInfoPlate", ROOM,
      // Если сайт уберёт свой onClick, гасить всплытие станет незачем —
      // и это надо заметить, а не гасить чужие клики «на всякий случай».
      (t) => t.replace("showPlayerPreview&&", "noPreview&&").replace("o.showPlayerPreview.apply", "o.noPreview.apply")],
    ["playerNumberBinding: номер отвязан от id игрока", roomProbes, "playerNumberBinding", ROOM,
      (t) => t.replace('["player-number","player-".concat(i.id)]', '["player-number","seat-".concat(i.id)]')],
    ["eliminatedStateClasses: заголосованный больше не помечается классом", roomProbes, "eliminatedStateClasses", ROOM,
      (t) => t.replace('"state-voted"', '"state-lynched"')],
    ["statsFooterSearchLink: «Поиск игры» повёл на главную", roomProbes, "statsFooterSearchLink", ROOM,
      (t) => t.replace('endGameLink:function(){return{link:"/game-search"', 'endGameLink:function(){return{link:"/"')],
    ["gameOverAutoRedirect: авторедиректа больше нет", roomProbes, "gameOverAutoRedirect", ROOM,
      (t) => t.replace('location="/game-search"', 'location="/"')],
    ["streamWindowName: имя окна захвата сменилось", roomProbes, "streamWindowName", ROOM,
      (t) => t.replace('"streamWindow"', '"captureWindow"')],
    // RU
    ["readinessLabels: кнопка получила хоткей в подписи", ruLocaleProbes, "readinessLabels", RU,
      (t) => t.replace('start_game_readiness_button_ready:"Готов"', 'start_game_readiness_button_ready:"R Готов"')],
    ["pauseLabels: «Завершить» переименован", ruLocaleProbes, "pauseLabels", RU,
      (t) => t.replace('end_pause:"Завершить"', 'end_pause:"Закончить"')],
    ["welcomeLabels: зрительская кнопка переименована", ruLocaleProbes, "welcomeLabels", RU,
      (t) => t.replace('start_watching:"Начать просмотр"', 'start_watching:"Смотреть"')],
    ["roleMenuKeysInverted: сайт «починил» инверсию", ruLocaleProbes, "roleMenuKeysInverted", RU,
      (t) => t.replace('show_roles:"Скрыть роли"', 'show_roles:"Показать роли"')],
    ["roleRowTitle: «Роль» переименована", ruLocaleProbes, "roleRowTitle", RU,
      (t) => t.replace('game_stats_role:"Роль"', 'game_stats_role:"Карта"')],
    ["disbandPrefix: префикс отсчёта сменился", ruLocaleProbes, "disbandPrefix", RU,
      // replaceAll: фраза попала в сниппет дважды (окно паузы тоже её задело).
      (t) => t.replaceAll("Игра будет распущена через", "Роспуск через")],
  ];

  test.each(cases)("%s", (_name, probes, probeName, original, mutate) => {
    const mutated = mutate(original);
    expect(mutated, "мутация обязана менять текст — иначе кейс вакуумен").not.toBe(original);
    const before = runProbes(probes, original).find((r) => r.name === probeName);
    const after = runProbes(probes, mutated).find((r) => r.name === probeName);
    expect(before?.ok, "до мутации проба обязана быть зелёной").toBe(true);
    expect(after?.ok, "после мутации проба обязана упасть").toBe(false);
  });

  test("animationDuration: смена длительности видна", () => {
    expect(siteRollerAnimationMs(ROOM.replace(/animationDuration:250/, "animationDuration:400"))).toBe(400);
  });
});
