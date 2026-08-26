# Архитектурная зрелость Polemica Notes 9.33.1

**Session ID:** ses_fc175c4fdffeOKmH9SZTLvfIyo
**Created:** 8/26/2026, 5:47:21 PM
**Updated:** 8/26/2026, 5:54:08 PM

---

## User

Ты — независимый архитектор и ревьюер браузерных расширений. Оцени текущую инженерную зрелость и архитектуру проекта Polemica Notes по состоянию на версию 9.33.1.

### Контекст проекта

- Репозиторий: https://github.com/fjfalcon/polemicagame_phil_extension
- Manifest V3 расширение (Chrome + Firefox) для polemicagame.com (спортивная мафия).
- Соло-мейнтейнер.
- TypeScript, Feature-based архитектура, ~1066 автотестов (включая мутационные).
- Каждый релиз проходит adversarial review.
- Каждая жалоба приходит с логом, каждый фикс имеет тест, который падает при откате, каждый инцидент оседает в AGENTS.md.

### Ключевые архитектурные факты

1. FeatureManager — тонкий (~120 строк), только enable/update/disable + settingKey. Доменной логики не содержит.
2. Фичи лежат плоско (~25 файлов). Реальный монолит — player-notes.ts (~4000 строк); у автора есть конкретный триггер распила.
3. Состояние намеренно разнесено по разным storage согласно разной семантике (документировано в AGENTS.md §5).
4. Главный инвариант проекта: «запись в DOM из onDomChange — только идемпотентная».

### Что произошло за последний день (26.08.2026)

В течение нескольких часов вышли три инфраструктурных релиза, закрывающие ранее названные пробелы:

**9.33.0 — диагностический дамп и сторож контракта**
- Снимок состояния в экспорте лога: настройки (пароль OBS замаскирован), метрики storage без текстов заметок/чата, статус OBS, список реально активных фич по вкладкам.
- Сторож контракта с сайтом: через 15 сек после входа в комнату — одна строка в лог (плитки/контролы/камеры/спрайт ролей). Нули → предупреждение о дрейфе разметки.

**9.33.1 — инвариант §4 стал исполняемым**
- Fixpoint-харнес (`tests/invariants/dom-fixpoint.test.ts`): фичи гоняются через настоящий SharedDomObserver; DOM обязан затихнуть. Класс блокера «вечный цикл вставки/удаления» теперь ловится механически (откат фикса = 3 красных теста). Есть канарейка на сам харнес.
- Рантайм-сторож шторма в dom.ts: минута безостановочных DOM-проходов вне игровой комнаты → warn в журнале. В комнате молчит.
- Библиотека аудит-промтов: №11 — мета-ревью самих промтов (раз в ~5 релизов); №12 — канарейка-проверка ревьюера подсадной регрессией.

### Позиция автора по оставшимся вопросам (до релизов)

- Наивный рантайм-детектор циклов в игровой комнате бесполезен (легитимный шторм сайта). Поэтому основная ставка — тестовый fixpoint-харнес + мягкий сторож только на тихих маршрутах.
- Реактивная эволюция adversarial после пропусков — нормальный SRE-паттерн, если пропуски оседают в процессе (у них оседают). Проактивная компонента добавлена через мета-ревью промтов и canary, без превращения в календарную церемонию.

### Твоя задача

Дай независимую оценку.

Структура ответа:

1. Общая оценка (1–2 фразы + балл из 10).
2. Что сейчас сделано особенно сильно.
3. Какие реальные остаточные риски/ограничения всё ещё есть (не генерик).
4. Насколько архитектура является следствием процесса, а не наоборот.
5. Итоговый балл с обоснованием: почему не выше и не ниже.
6. Где этот проект стоит относительно типичных open-source расширений и сильных соло-проектов.

Ограничения:
- Не предлагай «единый Store», domain-папки ради папок или большой PageModel поверх чужого Vue без очень веской причины.
- Учитывай соло-мейнтейнера и стоимость дисциплины.
- Отличай доктринальные правила от исполняемых стражей.
- Оценивай способность системы не допускать повторных классов ошибок и быстро диагностировать новые.

Будь прямым. Можно спорить с приведёнными фактами. 

---

## Assistant (Build · GPT-5.6 Sol · 328.2s)

_Thinking:_

**Planning independent repository inspection**

Проверю не только заявленные практики, но и то, чем они реально подкреплены в коде и тестах: архитектурные границы, исполняемые инварианты, диагностику и остаточные точки концентрации риска. Отдельно сопоставлю стоимость этой дисциплины с масштабом соло-проекта.

**Tool: task**

**Input:**
```json
{
  "description": "Assess architecture boundaries",
  "subagent_type": "explore",
  "prompt": "Проведи независимый архитектурный обзор локального репозитория Polemica Notes v9.33.1. Только исследование, ничего не меняй. Thoroughness: very thorough. Проверь FeatureManager, структуру content features, реальные зависимости и монолиты, lifecycle, shared observer, storage boundaries, browser contexts. Не пересказывай AGENTS.md без верификации. Верни: сильные стороны; конкретные остаточные риски с file:line и пользовательским сценарием; насколько архитектура адекватна соло-мейнтейнеру; что из заявлений пользователя подтверждено/не подтверждено."
}
```

**Output:**
```
<task id="ses_fc1758605ffeClOKztUEG1ojX3" state="completed">
<task_result>
# Архитектурный обзор Polemica Notes 9.33.1

## Итог

Архитектура в целом зрелая и заметно усилена эксплуатационным опытом. Для расширения такого размера она адекватна соло-мейнтейнеру, но уже находится у верхней границы комфортной поддержки: инфраструктурные слои хорошие, а несколько крупных feature-модулей и два entry-point-монолита стали основным источником риска.

Критических подтверждённых дефектов текущего happy path я не нашёл. Главные остаточные риски:

1. обещание единственного координатора заметок нарушается fallback-записями;
2. сохранение настроек попапом имеет гонку при быстром возвратном переключении;
3. долговечные карты кроме заметок всё ещё записываются конкурентным RMW;
4. lifecycle/fixpoint-тесты покрывают только часть заявленного инварианта;
5. монолиты и слабая типизация внешних payload уже существенно ограничивают полезность TypeScript.

Проверки:

- `npm run typecheck` — успешно;
- `npm test` — **70 файлов, 1066 тестов, всё успешно**;
- репозиторий после исследования чист, изменений нет.

---

## Сильные стороны

### 1. FeatureManager действительно устраняет большинство lifecycle-гонок

Подтверждено кодом:

- синхронизация сериализована общей очередью;
- ID резервируется до `await enable()`;
- упавший `enable()` откатывается через `disable()`;
- изменения sync/local коалесцируются;
- мастер-выключатель распространяется и на `settingKey: null`.

См. `/Users/fj/dev/Polemica 8.1.1/src/core/feature.ts:29-69`, `/Users/fj/dev/Polemica 8.1.1/src/core/feature.ts:89-135`.

Это хорошая абстракция для соло-разработки: большинство фич имеют единый контракт и не реализуют собственный settings-router.

### 2. Структура content-фич преимущественно плоская и понятная

В entry point зарегистрировано 30 фич, список читается как реестр возможностей:

`/Users/fj/dev/Polemica 8.1.1/src/content/index.ts:52-83`.

Зависимости между фичами ограничены. Найдены только несколько прямых связей:

- `auto-start` → `queue-requeue`;
- `postgame-search` → `queue-requeue`/`requeue-pending`;
- `hotkey-hints` → `outcry-hotkey`;
- `profile-mmr-chart` → `profile-crossover`;
- `tooltip` → `match-stats`.

Большинство общей логики действительно вынесено в `core` и `shared`, а не размазано по фичам.

### 3. Shared observer реально единственный в production-исходниках

Поиск конструкторов подтвердил один production `new MutationObserver`:

`/Users/fj/dev/Polemica 8.1.1/src/core/dom.ts:88`.

Реализация содержит полезные защитные механизмы:

- буфер до 4000 записей;
- ограничение частоты до одного прохода за 250 мс;
- отдельный путь для скрытой вкладки;
- изоляция исключений подписчиков;
- slow-flush и storm diagnostics;
- автоматическое отключение при отсутствии подписчиков.

См. `/Users/fj/dev/Polemica 8.1.1/src/core/dom.ts:61-233`.

Подписчики крупных фич часто дополнительно фильтруют батчи по `childList` или локальному scope. Хорошие примеры:

- `/Users/fj/dev/Polemica 8.1.1/src/content/features/player-notes.ts:543-582`;
- `/Users/fj/dev/Polemica 8.1.1/src/content/panels/obs-panel.ts:1170-1203`;
- `/Users/fj/dev/Polemica 8.1.1/src/content/panels/twitch-panel.ts:1492-1509`;
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/tooltip.ts:458-477`.

### 4. Границы браузерных контекстов в основном проведены правильно

Подтверждены отдельные entry points:

- background;
- content;
- popup;
- три PAGE-probe;
- ранний probe injector.

См. `/Users/fj/dev/Polemica 8.1.1/tsup.config.ts:11-26`.

Каждый собирается в самостоятельный IIFE, поэтому модульное состояние `core/*` действительно не разделяется между background/content/popup. Межконтекстная координация проходит через messaging и storage.

Особенно удачны решения, переживающие смерть Chrome MV3 service worker:

- очередь гарда кодирует `tabId` в имени alarm;
- OBS-состояние, владение сценой и флаги записи лежат в `storage.local`;
- достоверность состояния комнаты запрашивается у content-скриптов.

См. `/Users/fj/dev/Polemica 8.1.1/src/background/index.ts:88-131`, `/Users/fj/dev/Polemica 8.1.1/src/background/index.ts:279-392`, `/Users/fj/dev/Polemica 8.1.1/src/background/index.ts:598-625`.

### 5. Основные storage boundaries реализованы корректно

Подтверждено:

- обычные настройки — `storage.sync`;
- `obs_password` — `storage.local`;
- заметки — `storage.local`;
- sync-копии заметок читаются только как миграционный мост;
- миграция записывает данные и флаг одним `local.set`.

См.:

- `/Users/fj/dev/Polemica 8.1.1/src/core/settings.ts:143-186`;
- `/Users/fj/dev/Polemica 8.1.1/src/core/notes-store.ts:440-497`;
- `/Users/fj/dev/Polemica 8.1.1/src/core/notes-store.ts:500-545`.

Защита от записи пустой карты после ошибки чтения тоже присутствует как в store, так и в background coordinator.

### 6. Попап в нормальном сценарии пишет дифф

Подтверждено:

- `lastKnown` хранит последнюю известную версию;
- popup подписан на `storage.onChanged`;
- перед записью строится `Partial<Settings>`;
- пароль исключается из broadcast.

См. `/Users/fj/dev/Polemica 8.1.1/src/popup/index.ts:967-1044`, `/Users/fj/dev/Polemica 8.1.1/src/popup/index.ts:1311-1340`.

### 7. Тестовый контур необычно сильный для небольшого расширения

1066 успешных тестов — не просто количество: присутствуют unit, property-style проверки, статические архитектурные инварианты и настоящий MutationObserver harness. Отдельно полезны:

- FeatureManager rollback/coalescing:
  `/Users/fj/dev/Polemica 8.1.1/tests/unit/feature-manager.test.ts:28-69`;
- storage/manifest/lifecycle инварианты:
  `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts`;
- fixpoint canary:
  `/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:234-247`.

---

## Конкретные остаточные риски

### 1. Средне-высокий: координатор заметок не является безусловно единственным писателем

`sendRuntime()` гасит любую ошибку доставки и возвращает `undefined`:

`/Users/fj/dev/Polemica 8.1.1/src/core/messaging.ts:37-54`.

После этого `player-notes` записывает всю карту напрямую:

`/Users/fj/dev/Polemica 8.1.1/src/content/features/player-notes.ts:925-945`.

Аналогичный fallback есть у импорта:

`/Users/fj/dev/Polemica 8.1.1/src/popup/index.ts:855-873`.

**Пользовательский сценарий:** background временно не загрузился или упал, но `storage.local` в двух content-вкладках ещё доступен. Обе вкладки переходят на fallback и записывают разные версии полной карты. Последняя запись может удалить изменение первой.

Это осознанный компромисс availability over consistency, но утверждение «одна очередь на браузер» не абсолютно. Для данных, объявленных главной ценностью, это важнейшая оставшаяся архитектурная щель.

### 2. Средний: гонка быстрого возвратного переключения в popup

Сохранения не сериализованы, а `lastKnown` обновляется только после завершения записи:

`/Users/fj/dev/Polemica 8.1.1/src/popup/index.ts:1314-1328`.

**Сценарий:**

1. настройка была `false`;
2. пользователь быстро включает её — уходит async patch `true`;
3. до `onChanged` или завершения записи выключает обратно;
4. второй проход сравнивает DOM `false` со старым `lastKnown=false` и не пишет ничего;
5. первый запрос завершает запись `true`.

При обычном медленном клике проблемы нет, но быстрый double-click способен сохранить не последнее намерение пользователя. Нужна была бы очередь/ревизия сохранений, а не несколько независимых promise.

### 3. Средний: прочие пользовательские карты не защищены глобальным координатором

Мьюты и пользовательские цвета делают read-merge-write непосредственно из content:

`/Users/fj/dev/Polemica 8.1.1/src/content/features/player-notes.ts:848-893`.

Метки ролей записывают всю `roleMarks` напрямую:

`/Users/fj/dev/Polemica 8.1.1/src/content/features/role-marker.ts:108-127`.

Свежий `get` перед `set` уменьшает риск, но не делает операцию атомарной.

**Сценарий:** пользователь почти одновременно ставит разные мьюты, добавляет цвета или role marks в двух игровых вкладках. Обе вкладки могут прочитать одинаковое старое состояние, после чего последняя полная запись вытеснит первую.

То есть граница «координируем долговечный пользовательский ввод» проведена только вокруг основной карты заметок.

### 4. Средний архитектурный: исполняемый fixpoint-инвариант охватывает не все DOM-фичи

Production имеет около двадцати подписок `onDomChange`, но настоящий fixpoint harness импортирует только две профильные фичи:

`/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:65-71`.

Исполняемые пользовательские сценарии относятся к `profile-crossover` и `profile-mmr-chart`:

`/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:135-180`.

`player-notes`, `match-stats`, `auto-start`, OBS/Twitch panels и остальные DOM-писатели этим тестом не прогоняются.

**Сценарий:** в одной из крупных фич появляется безусловная запись `class/style` из callback наблюдателя. Канарейка harness остаётся зелёной, профильные сценарии тоже зелёные, а цикл проявляется только в игре пользователя.

Следовательно, заявленный исполняемый инвариант подтверждён как механизм, но не как полное покрытие всех DOM-писателей.

### 5. Средний: монолиты стали основным bottleneck сопровождения

Крупнейшие файлы:

- `player-notes.ts` — 4111 строк;
- `popup/index.ts` — 1984;
- `match-stats.ts` — 1820;
- `twitch-panel.ts` — 1586;
- `obs-panel.ts` — 1533;
- `auto-start.ts` — 1469;
- `queue-requeue.ts` — 1092;
- `postgame-search.ts` — 1043;
- `background/index.ts` — 952.

Например, `/Users/fj/dev/Polemica 8.1.1/src/content/features/player-notes.ts` одновременно владеет:

- API-кэшами;
- разрешением userId;
- хранением и миграцией заметок;
- мьютами;
- цветами;
- камерой;
- множеством модалок;
- тултипами;
- статистикой;
- route state;
- lifecycle.

Это уже не просто «большая фича», а подсистема без внутренних модульных границ. Для соло-мейнтейнера локальность полезна, но любой change review вынужден охватывать тысячи строк и десятки mutable fields.

### 6. Средний: TypeScript почти не защищает самую нестабильную границу — payload сайта

В `tsconfig` формально включён `strict`, но одновременно:

- `noImplicitAny: false`;
- `noUnusedLocals: false`;
- `noUnusedParameters: false`.

См. `/Users/fj/dev/Polemica 8.1.1/tsconfig.json:7-12`.

Наиболее важные внешние структуры активно используют `any`:

- `/Users/fj/dev/Polemica 8.1.1/src/content/match-data.ts:79`;
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/match-stats.ts:174-174`;
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/match-stats.ts:438-511`;
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/player-notes.ts:198-235`;
- `/Users/fj/dev/Polemica 8.1.1/src/content/panels/obs-panel.ts:364-365`.

**Сценарий:** сайт меняет поле или тип в match/rating API. Компилятор не помогает; защита зависит исключительно от contract/unit fixtures и ручного знания формы.

Тесты существенно компенсируют это, но архитектурное преимущество TS используется не полностью именно на рискованной границе.

### 7. Средне-низкий: FeatureManager сериализует весь запуск одной общей очередью

`sync()` последовательно ожидает каждый `enable()`:

`/Users/fj/dev/Polemica 8.1.1/src/core/feature.ts:96-135`.

**Сценарий:** ранняя async-фича не reject-ится, а зависает на browser API. Все последующие фичи в registration order не включаются. Сейчас ранние async-фичи в основном ждут storage, поэтому вероятность невысока, но failure domain общий для всех 30 фич.

Плюс при исключении из `disable()` manager всё равно удаляет ID из `active`:

`/Users/fj/dev/Polemica 8.1.1/src/core/feature.ts:120-127`.

Если cleanup упал после снятия только части ресурсов, повторное включение может наложить второй экземпляр поверх хвостов первого.

### 8. Средне-низкий: часть «всегда включённых» фич делает работу даже вне своего маршрута

`auto-start` всегда запускает секундный interval:

`/Users/fj/dev/Polemica 8.1.1/src/content/features/auto-start.ts:1290-1298`, `/Users/fj/dev/Polemica 8.1.1/src/content/features/auto-start.ts:1427-1437`.

Он существует на любой странице `polemicagame.com`, даже если пользователь находится на профиле и отключил все его подпроцессы.

`player-notes` при включённой статистике также выполняет полный страховочный проход каждые две секунды:

`/Users/fj/dev/Polemica 8.1.1/src/content/features/player-notes.ts:568-582`.

По отдельности цена умеренная, но архитектурно общий content bundle содержит несколько независимых fallback polling loops. На слабом устройстве их сумма важнее цены самого shared observer.

### 9. Низкий, но конкретный lifecycle-хвост в auto-start

Начальный таймер не сохраняется в handle:

`/Users/fj/dev/Polemica 8.1.1/src/content/features/auto-start.ts:1324`.

`disableGamePage()` его не отменяет:

`/Users/fj/dev/Polemica 8.1.1/src/content/features/auto-start.ts:1327-1365`.

Сейчас callback безопасен: после disable конфигурация сбрасывается, а `queueRolePhaseCheck()` выходит по выключенному флагу. Поэтому пользовательского дефекта здесь не подтверждено. Но утверждение о полной отменяемости всех хвостовых timers буквально не выполняется, а статический lifecycle-тест этого не обнаруживает из-за подсчёта по всему файлу.

### 10. Низкий: сохранилась мёртвая cross-context фича `search`

`searchFeature` навешивает глобальный capture-click listener и шлёт `startSearch/stopSearch`:

`/Users/fj/dev/Polemica 8.1.1/src/content/features/search.ts:13-43`.

Background явно отвечает на эти сообщения no-op:

`/Users/fj/dev/Polemica 8.1.1/src/background/index.ts:529-537`.

**Сценарий:** каждый пользовательский клик по началу/остановке поиска создаёт бессмысленное runtime message. Это не баг поведения, но пример того, что реестр фич ещё содержит совместимый shell после удаления реализации.

### 11. Низкий: PAGE-probe после выключения настройки остаётся обёрткой до reload

Зонд меняет `WebSocket.prototype.onmessage` и `send`:

`/Users/fj/dev/Polemica 8.1.1/src/content/page/room-probe-page.ts:81-122`.

Выключение настройки только запрещает пересылку кадров:

`/Users/fj/dev/Polemica 8.1.1/src/content/features/ws-log.ts:71-86`.

**Сценарий:** пользователь включил полный лог, загрузил игру, затем выключил его. Данные больше не пишутся, но prototype wrapper продолжает участвовать в каждом кадре до перезагрузки страницы. Это соответствует текущему документированному контракту, однако формулировка «зонда нет при выключенной настройке» верна только для следующей загрузки, не для текущего документа.

---

## Адекватность для соло-мейнтейнера

### Оценка: адекватна, но требует ограничения дальнейшего роста монолитов

Хорошо подходят соло-поддержке:

- один прямолинейный реестр фич;
- мало абстракций и DI-слоёв;
- единые settings/messaging/log/DOM primitives;
- сильные регрессионные тесты;
- комментарии рядом с нетривиальными решениями;
- общие Chrome/Firefox исходники;
- локализованная browser-specific разница в manifest overlays.

Плохо масштабируются:

- несколько файлов по 1500–4100 строк;
- module-global state machines без явных объектов;
- route lifecycle частично живёт вне FeatureManager;
- popup смешивает импорт, диагностику, OBS, Twitch и всю форму настроек;
- важные API payload не типизированы;
- lifecycle-инварианты местами проверяются количеством токенов, а не поведением.

Для одного владельца я бы оценил архитектуру как **7/10 сейчас**. Она лучше типичного небольшого extension-кода, но добавление ещё одного крупного продуктового блока без декомпозиции снизит предсказуемость изменений.

Практический порог: новые возможности лучше добавлять отдельными небольшими feature/domain-модулями, а не продолжать расширять `player-notes.ts`, `popup/index.ts`, `obs-panel.ts` и `background/index.ts`.

---

## Что подтверждено и что нет

### Подтверждено

1. Репозиторий действительно версии **9.33.1**:  
   `/Users/fj/dev/Polemica 8.1.1/package.json:3`,  
   `/Users/fj/dev/Polemica 8.1.1/src/manifest/manifest.base.json:4`.

2. FeatureManager реально управляет enable/update/disable по настройкам и сериализует проходы.

3. Production-исходники используют один общий `MutationObserver`.

4. Заметки действительно находятся в `storage.local`; sync используется как read-only migration bridge.

5. `obs_password` действительно отделён в `storage.local`.

6. Popup действительно пишет дифф и слушает внешние изменения.

7. Chrome и Firefox используют общий TS-код, но разные формы background:
   - Chrome service worker;
   - Firefox background scripts.

8. Состояния, которым нужно пережить выгрузку SW, в ключевых сценариях действительно вынесены из module memory в alarm names/storage.

9. Прямые зависимости между content-фичами существуют, но их немного; проект не является плотным dependency spaghetti.

10. Typecheck и весь локальный offline test suite чисты.

### Подтверждено лишь частично

1. **«Все фичи управляются FeatureManager».**  
   Большинство — да. Но URL-router, diagnostics, nickname responder, orphan watch, own-user caching и storage mirror живут рядом с ним вне его lifecycle:  
   `/Users/fj/dev/Polemica 8.1.1/src/content/index.ts:85-156`,  
   `/Users/fj/dev/Polemica 8.1.1/src/content/index.ts:179-237`.

2. **«Единственная очередь записи заметок на браузер».**  
   Нормальный путь — да; fallback content/popup её обходит.

3. **«DOM-идемпотентность стала исполняемым инвариантом».**  
   Harness настоящий, но поведенчески покрывает только две профильные фичи.

4. **«Lifecycle симметричен».**  
   В основных рассмотренных фичах cleanup хороший, но тест — преимущественно лексическая эвристика с большими allowance, а не доказательство всех путей:  
   `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:427-553`.

5. **«Мастер-выключатель гасит всё».**  
   Он гасит FeatureManager-фичи и видимые продуктовые функции, но инфраструктурные responders, router, own-user read/cache и некоторые диагностические механизмы продолжают существовать.

### Не подтверждено или формулировка неточна

1. **«Один JS-бандл».**  
   Не буквально: сборка имеет семь самостоятельных entry bundles. Верно другое — наборы артефактов одинаковы для Chrome/Firefox, а браузерные различия задаются manifest overlays.

2. **Полная независимость content-фич.**  
   Прямые cross-feature импорты есть, а `tooltip` даже берёт палитру из крупного `match-stats` вместо нейтрального shared-модуля:  
   `/Users/fj/dev/Polemica 8.1.1/src/content/features/tooltip.ts:15`.

3. **Живое поведение сайта, OBS, Twitch и реальные Chrome/Firefox lifecycle-события.**  
   В этом обзоре они не проверялись в браузере или на live-сайте; подтверждены только исходники и offline-тесты. Поэтому утверждения о фактической форме текущего DOM/API, реальном поведении браузера после обновления и совместимости PAGE-probes остаются вне независимой runtime-верификации.
</task_result>
</task>
```

**Tool: task**

**Input:**
```json
{
  "description": "Audit executable safeguards",
  "subagent_type": "explore",
  "prompt": "Исследуй локальный Polemica Notes v9.33.1 как независимый reviewer, ничего не меняй. Thoroughness: very thorough. Сфокусируйся на tests/invariants, dom-fixpoint harness, mutation/property/contract tests, канарейках, CI/package scripts и том, действительно ли доктринальные правила стали исполняемыми. Ищи слепые зоны, ложноположительные/ложноотрицательные сценарии, узкие allowlist. Верни подтверждённые сильные стороны и конкретные остаточные риски с file:line."
}
```

**Output:**
```
<task id="ses_fc17585a3ffe02NCJJQAizn1ij" state="completed">
<task_result>
## Итог

Локальный v9.33.1 имеет сильный и заметно зрелый тестовый слой: `npm test` и живые контракты сейчас зелёные, fixpoint-харнес действительно использует production `SharedDomObserver`, а семантические пробы снабжены собственными канарейками.

Однако доктринальные правила стали исполняемыми лишь частично. Главные остаточные риски — тесты не являются обязательным release gate, отдельная типизация тестов уже сломана, fixpoint-харнес покрывает только 2 из 20 production-подписок `onDomChange`, а несколько архитектурных инвариантов остаются узкими лексическими эвристиками.

Ничего не изменял; после прогонов `git status --short` остался пустым.

## Результаты проверки

- `npm test`: **70 файлов, 1066 тестов — passed**
- `npm run test:contract`: **3 файла, 7 тестов — passed**
- `npm run typecheck`: **passed**
- `npx tsc --noEmit -p tests/tsconfig.json`: **failed, 12 TypeScript errors**
- `.github/workflows/`: отсутствует

---

# Конкретные остаточные риски

## Высокие

### 1. Тесты и инварианты не блокируют релиз

`release:assets` запускает только production typecheck и сборку:

- `/Users/fj/dev/Polemica 8.1.1/scripts/release-assets.mjs:65-75`

При этом `npm test`, контрактные тесты, отдельная типизация тестов и `web-ext lint` существуют только как независимые ручные команды:

- `/Users/fj/dev/Polemica 8.1.1/package.json:15-23`

CI workflow в репозитории отсутствует. Следовательно, любой из 1066 тестов, fixpoint-канарейка или архитектурный инвариант может быть красным, а release-команда всё равно соберёт и подпишет артефакты. В строгом смысле правила стали исполняемыми только при добровольном ручном запуске.

### 2. Отдельная типизация тестов уже красная и нигде не запускается автоматически

Конфигурация намеренно включает все тесты и production-код:

- `/Users/fj/dev/Polemica 8.1.1/tests/tsconfig.json:1-12`

Но команда завершилась ошибкой. Среди подтверждённых мест:

- union fixture с CSS-записями без `sha256`:  
  `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-contract.test.ts:74-78`  
  `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-contract.test.ts:187-195`
- возможно `undefined` после `skip`:  
  `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:97-104`
- неверно ослабленный тип mutation probes:  
  `/Users/fj/dev/Polemica 8.1.1/tests/unit/semantic-probes.test.ts:55-56`  
  `/Users/fj/dev/Polemica 8.1.1/tests/unit/semantic-probes.test.ts:189-195`

Обычный `npm run typecheck` этого не видит, поскольку корневой tsconfig включает только `src`:

- `/Users/fj/dev/Polemica 8.1.1/tsconfig.json:22-23`

Это уже не теоретическая слепая зона: документированная проверка тестового кода фактически не чистая.

### 3. Fixpoint-harness не обеспечивает покрытие всех DOM-писателей

Production содержит **20 вызовов** `onDomChange`; fixpoint-файл импортирует и запускает только две профильные фичи:

- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:65-70`
- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:135-180`

Не покрыты настоящим циклом observer → subscriber → собственная mutation, среди прочих:

- `/Users/fj/dev/Polemica 8.1.1/src/content/features/player-notes.ts:549`
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/auto-start.ts:368`
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/auto-start.ts:1316`
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/controls-safety.ts:173`
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/role-marker.ts:373`
- `/Users/fj/dev/Polemica 8.1.1/src/content/panels/obs-panel.ts:1177`
- `/Users/fj/dev/Polemica 8.1.1/src/content/panels/obs-panel.ts:1282`
- `/Users/fj/dev/Polemica 8.1.1/src/content/panels/twitch-panel.ts:1499`

Часть имеет хорошие mocked unit-тесты, но они не возвращают собственные DOM-записи через реальный `MutationObserver`. Например, player-notes подменяет весь `@core/dom`:

- `/Users/fj/dev/Polemica 8.1.1/tests/unit/player-notes-wiring.test.ts:32-42`

Нет реестра или статического инварианта, заставляющего новый DOM-пишущий subscriber добавить fixpoint-сценарий. Поэтому формулировка AGENTS «новая DOM-пишущая фича обязана получить там сценарий» пока остаётся review-дисциплиной.

### 4. Lifecycle-инвариант охватывает только `src/content/features/*.ts`

Основной анализ acquisitions/teardown сканирует исключительно feature-файлы:

- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:523-527`

Панели, core, popup и background исключены, хотя там много таймеров и слушателей, например:

- `/Users/fj/dev/Polemica 8.1.1/src/content/panels/twitch-panel.ts:941-1022`
- `/Users/fj/dev/Polemica 8.1.1/src/content/panels/obs-panel.ts:347-355`
- `/Users/fj/dev/Polemica 8.1.1/src/background/obs-client.ts:96-116`

Кроме того, проверка сравнивает только сырые количества вызовов:

- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:528-536`

Она не доказывает:

- одинаковую ссылку listener;
- одинаковый capture-флаг;
- очистку именно в `disable()`;
- соответствие конкретного timer конкретному clear;
- отсутствие удаления чужого listener.

Allowlist точный по числам, но местами очень широкий — например, **36 unmatched listeners** у player-notes:

- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:463-474`

Это полезная канарейка роста, но не полное исполнение §4.7.

---

## Средние

### 5. Fixpoint может преждевременно признать редкий цикл затихшим

Фикспоинт объявляется после четырёх тихих интервалов по 600 мс:

- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:73-75`
- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:92-103`

То есть отложенный цикл с периодом более примерно 2,4 секунды может пройти как settled до первого позднего хвоста. Особенно это важно для фич с fallback-интервалами и watchdog-таймерами.

Дополнительно тестовый counter наблюдает **все атрибуты**:

- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:83-90`

Production observer наблюдает только `class` и `style`:

- `/Users/fj/dev/Polemica 8.1.1/src/core/dom.ts:102-107`

Это создаёт обратную возможность ложного срабатывания: бесконечная запись `data-*` будет считаться активностью тестовым counter, хотя production observer сам от неё не пробуждается.

### 6. Runtime storm guard отключён именно в игровой комнате

Предупреждение подавляется для любого game-room route:

- `/Users/fj/dev/Polemica 8.1.1/src/core/dom.ts:163-183`

Это снижает шум от штатных игровых мутаций, но одновременно оставляет без runtime-канарейки место, где активно большинство DOM-подписчиков и последствия цикла наиболее дорогие. Guard также считает только непрерывность flush, не источник мутации: вне комнаты интенсивный DOM самого сайта способен дать ложный warn, а в комнате собственный цикл расширения — остаться неотличимым от штатной активности.

### 7. Контрактные тесты маскируют некоторые постоянные 4xx/сломанные ответы как skip

SSR-тест пропускается при любом non-OK статусе, включая постоянный 404:

- `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:19-25`

История пропускается при любом статусе rating seed, отличном от 200:

- `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:57-64`

`/api/games` также skip при любом non-200:

- `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:85-99`

Кроме того, HTTP 200 с не-JSON телом всегда превращается в `TransientNetworkError`, а затем обычно в skip:

- `/Users/fj/dev/Polemica 8.1.1/tests/contract/fetch.ts:51-60`

Это разумно против WAF/CDN, но означает ложнозелёный результат при устойчивом контрактном дрейфе вида «endpoint теперь отдаёт HTML-заглушку 200» или «страница матча окончательно стала 404».

### 8. Контракт `/api/games` не проверяет заявленное поле `mmr`

Название теста обещает `players[].{id,username,mmr}`:

- `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:85`

Фактический assert проверяет только `id` и `username`:

- `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:100-104`

Исчезновение или смена формы `mmr` останется зелёной.

### 9. Проверка SITE-классов ищет класс «где угодно во всех bundle»

Все скачанные bundle объединяются в одну строку:

- `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-contract.test.ts:85-87`

После этого каждый класс SITE ищется в общем тексте:

- `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-contract.test.ts:106-117`

Если room-класс исчезнет из room bundle, но останется в несвязанном profile/game-search bundle, тест пройдёт. Также проверяются отдельные class tokens, но не композиция селектора, nesting или принадлежность нужному компоненту.

Семантические probes закрывают важную часть таких случаев, но только для вручную выбранного подмножества.

### 10. Mutation testing — ручные канарейки, а не систематическая мутация production-кода

В package scripts нет mutation-runner или mutation-score gate:

- `/Users/fj/dev/Polemica 8.1.1/package.json:7-25`

Сильный набор в `semantic-probes.test.ts` мутирует fixture snippets, но не production consumers. Кроме того, комментарий обещает, что мутация уронит «ровно свою пробу»:

- `/Users/fj/dev/Polemica 8.1.1/tests/unit/semantic-probes.test.ts:51-54`

Фактически проверяется только выбранная probe; состояние остальных probes после мутации не проверяется:

- `/Users/fj/dev/Polemica 8.1.1/tests/unit/semantic-probes.test.ts:189-195`

Это не делает тесты плохими, но ограничивает доказательную силу заявленного mutation criterion.

### 11. Runtime contract-watch проверяет только разовый снимок и считает камеры необязательными

После входа выполняется один замер через 15 секунд:

- `/Users/fj/dev/Polemica 8.1.1/src/content/features/contract-watch.ts:91-100`

Broken определяется только нулём tiles или controls:

- `/Users/fj/dev/Polemica 8.1.1/src/content/features/contract-watch.ts:49-52`

Полное исчезновение `SITE.playerVideo` даст `cameras=0`, но guard останется зелёным. Повторного замера на том же route нет, поэтому поздняя перемонтировка или деградация после первых 15 секунд также не обнаруживается.

---

## Узкие статические инварианты

### 12. Несколько тестов можно обойти алиасом или рефакторингом без изменения опасного поведения

Примеры:

- единственный MutationObserver ищется только по точному тексту `new MutationObserver(`:  
  `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:177-187`
- frozen sync bridge анализируется regex до ближайшей `;` и требует прямого присутствия protected token в аргументе:  
  `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:117-130`
- whole-map writers распознаются только по прямым именам `saveNotes`/`saveNotesToStore`:  
  `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:87-114`
- atomic migration доказывается широким многострочным regex, который теоретически способен пересечь границы нескольких вызовов:  
  `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:133-137`

Текущий production-код этим правилам соответствует; риск именно в ложном ощущении общего запрета. Алиас функции, wrapper или `window.MutationObserver` способны обойти часть стражей.

### 13. Тест «every text-matched click list» фактически проверяет только auto-start

Название утверждает общее правило:

- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:164`

Но тест читает только `src/content/features/auto-start.ts`:

- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:165-175`

Другие автокликеры защищены отдельными behavioral tests, но архитектурного discovery-механизма для нового text-matched clicker нет.

### 14. §4.12 проверяет согласованность ключей, но не обязательную upgrade-миграцию

Проверка надёжно сравнивает `Settings` и `DEFAULT_SETTINGS` через AST:

- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:269-275`

Но она не доказывает правило «оживлённая старая настройка требует миграции» и не обнаруживает смену дефолта, которая должна сопровождаться upgrade-решением. Эта часть §4.12 по-прежнему зависит от reviewer-а и знания истории storage.

---

# Подтверждённые сильные стороны

1. **Настоящий observer pipeline и рабочая канарейка.**  
   `@core/dom` намеренно не мокается, а неидемпотентный subscriber действительно не достигает фикспоинта:  
   `/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:65-70`  
   `/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:234-247`

2. **Точно воспроизведён критический профильный блокер.**  
   Есть сценарии своего/чужого профиля, разлогина и совместной работы двух карточек:  
   `/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:135-180`

3. **Runtime storm guard протестирован в обе стороны.**  
   Проверяются и один latched warn вне комнаты, и отсутствие шума в комнате:  
   `/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:182-231`

4. **Architecture suite местами использует AST вместо хрупких regex.**  
   В частности, тело teardown-функции извлекается структурно, а ключи Settings/defaults получаются независимо:  
   `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:26-45`  
   `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:47-83`

5. **Allowlist lifecycle точен по файлу и количеству, а stale entries запрещены.**  
   Это хорошо ограничивает бесконтрольный рост исключений:  
   `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:427-502`  
   `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:537-552`

6. **Семантические контракты существенно сильнее простого поиска строк.**  
   Probes ограничивают окна вокруг handler-ов и проверяют связи state → class/action:  
   `/Users/fj/dev/Polemica 8.1.1/tests/contract/semantic-probes.ts:34-65`  
   `/Users/fj/dev/Polemica 8.1.1/tests/contract/semantic-probes.ts:70-185`

7. **Каждая основная semantic probe имеет отрицательный mutation-case.**  
   Перед мутацией проверяется зелёное состояние, сама мутация обязана менять fixture, после неё целевая probe обязана упасть:  
   `/Users/fj/dev/Polemica 8.1.1/tests/unit/semantic-probes.test.ts:189-200`

8. **Live и offline половины используют одни и те же probes.**  
   Это хороший способ отделить работоспособность детектора от сетевой доступности:  
   `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-semantics.test.ts:18-25`  
   `/Users/fj/dev/Polemica 8.1.1/tests/unit/semantic-probes.test.ts:16-22`

9. **Контракт матча проверяется по реальному SSR, а сложный исход дня — по двум реальным fixture.**  
   `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:14-48`  
   `/Users/fj/dev/Polemica 8.1.1/tests/unit/match-outcome.test.ts:36-56`

10. **Property tests для заметок доменно осмысленны и воспроизводимы.**  
    Они проверяют повторный импорт, идемпотентность, канонизацию и сохранение непустых полей с фиксированными seed:  
    `/Users/fj/dev/Polemica 8.1.1/tests/unit/notes-store.test.ts:276-384`

11. **Многие бывшие “source presence” тесты дополнены wiring/behavior проверками.**  
    Хороший пример — player-notes: отдельно проверяется, что реальная подписка вызывает проход и применяет throttle:  
    `/Users/fj/dev/Polemica 8.1.1/tests/unit/player-notes-wiring.test.ts:108-193`

## Общий вердикт

Инфраструктура v9.33.1 сильная и явно ловит реальные классы регрессий, но формулировка «доктринальные правила стали исполняемыми» пока верна лишь для выбранных критических срезов. Для полноценного enforcement прежде всего не хватает обязательного CI/release gate, зелёной типизации тестов и механизма, гарантирующего fixpoint-сценарий для каждого нового DOM-пишущего subscriber.
</task_result>
</task>
```

**Tool: task**

**Input:**
```json
{
  "description": "Review diagnostics process",
  "subagent_type": "explore",
  "prompt": "Независимо исследуй observability и engineering process в локальном Polemica Notes v9.33.1, без изменений. Thoroughness: very thorough. Проверь diagnostic dump 9.33.0, site contract watchdog, logging privacy/completeness, adversarial review prompts #11/#12, release workflow/docs/history where available. Оцени способность быстро диагностировать новые инциденты и не повторять классы ошибок. Верни конкретные доказательства и остаточные риски с file:line; отличай документацию от механического enforcement."
}
```

**Output:**
```
<task id="ses_fc175859bffem4CT47STp59Ogr" state="completed">
<task_result>
## Итоговая оценка

**Способность диагностировать новый инцидент: выше средней, примерно 7/10.**  
Обычный журнал, диагностический снимок, семантические contract-тесты и исполняемые инварианты дают хорошую первичную картину. Однако наблюдаемость не является полностью надёжной: есть утечки приватных данных, неоднозначная отметка полноты, узкий runtime-watchdog и отсутствие обязательного release-gate.

**Способность не повторять известные классы ошибок: примерно 6/10.**  
Для нескольких дорогостоящих классов есть сильные механические стражи. Но adversarial review, contract-suite, тесты и lint не встроены в выпуск; типизация тестов сейчас красная. Процесс во многом держится на дисциплине владельца и текстовых инструкциях.

### Фактические проверки

- `npm test`: **70 файлов, 1066 тестов — passed**.
- `npm run test:contract`: **3 файла, 7 тестов — passed** на живом сайте 26.08.2026.
- Production `npm run typecheck`: прошёл.
- `npx tsc --noEmit -p tests/tsconfig.json`: **failed** с ошибками в contract- и unit-тестах.
- После проверок `git status --short` остался пустым; файлов не изменено.
- GitHub Actions/другой CI в `.github/` отсутствует.

---

# Что сделано хорошо

## 1. Обычный диагностический журнал действительно пригоден для расследований

Механически реализовано:

- отдельные ключи content-сессий и короткий session-id в каждой строке, позволяющий разделять вкладки:  
  `/Users/fj/dev/Polemica 8.1.1/src/core/log.ts:60-75`;
- кольцо на 600 записей и ограничение сообщения:  
  `/Users/fj/dev/Polemica 8.1.1/src/core/log.ts:76-77`;
- сохранение предыдущего буфера перед первой записью, поэтому F5 и рестарт service worker не обнуляют историю:  
  `/Users/fj/dev/Polemica 8.1.1/src/core/log.ts:147-155`,  
  `/Users/fj/dev/Polemica 8.1.1/src/core/log.ts:306-318`;
- срочный flush ошибок и обычный flush через три секунды:  
  `/Users/fj/dev/Polemica 8.1.1/src/core/log.ts:369-390`;
- ограниченные повторы при отказе storage вместо вечного бодрствования MV3 worker:  
  `/Users/fj/dev/Polemica 8.1.1/src/core/log.ts:266-274`,  
  `/Users/fj/dev/Polemica 8.1.1/src/core/log.ts:337-357`;
- глобальный перехват собственных ошибок с подавлением потока ошибок сайта:  
  `/Users/fj/dev/Polemica 8.1.1/src/core/errors.ts:8-22`,  
  `/Users/fj/dev/Polemica 8.1.1/src/core/errors.ts:24-43`.

Есть отдельные механические проверки важных terminal outcomes автокликов, OBS/Twitch и заметок:  
`/Users/fj/dev/Polemica 8.1.1/tests/invariants/observability.test.ts:9-311`.

Это лучше простого теста «в файле встречается log.info»: местами проверяются латчи, бюджет повторов и отсутствие преждевременного успеха.

## 2. Diagnostic dump 9.33.0 хорошо закрывает вопрос «что вообще включено сейчас»

Экспорт включает:

- версию, UA, время, число строк и признак полноты;
- эффективные настройки;
- размеры групп `storage.local`;
- текущий статус OBS;
- маршрут и реально активные FeatureManager-фичи каждой вкладки сайта.

Код:  
`/Users/fj/dev/Polemica 8.1.1/src/popup/index.ts:123-179`,  
`/Users/fj/dev/Polemica 8.1.1/src/popup/index.ts:181-215`.

Сильная деталь — секции падают независимо, поэтому отказ OBS или одной вкладки не ломает весь экспорт:  
`/Users/fj/dev/Polemica 8.1.1/src/popup/index.ts:132-177`.

Активные фичи берутся из реального `FeatureManager.active`, а не реконструируются из галочек:  
`/Users/fj/dev/Polemica 8.1.1/src/core/feature.ts:29-40`,  
`/Users/fj/dev/Polemica 8.1.1/src/content/index.ts:259-262`.

Маршрут возвращается без query/fragment, что не тащит invite-токены:  
`/Users/fj/dev/Polemica 8.1.1/src/content/index.ts:259-268`.

## 3. Site contract suite заметно сильнее проверки наличия CSS-класса

Live-suite проверяет:

- классы и RU/EN locale;
- реальные HTTP shape;
- SSR `:game-data`;
- вложенные `role.type`, `result.code`, `mmr`;
- смысловые связи в минифицированных бандлах: состояние ↔ класс, событие ↔ действие, матрицы кнопок;
- CSS-геометрию и хэши иконок.

Основные доказательства:

- `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-contract.test.ts:57-198`
- `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-semantics.test.ts:18-96`
- `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:4-105`
- `/Users/fj/dev/Polemica 8.1.1/tests/contract/semantic-probes.ts:1-16`

Особенно полезно, что semantic probes имеют офлайн-мутационные тесты, а не зависят целиком от сети.

## 4. Для повторения DOM-циклов появился настоящий механический барьер

`dom-fixpoint` использует настоящий `SharedDomObserver` и возвращает мутации, созданные самой фичей, обратно подписчику:  
`/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:1-20`,  
`/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:77-107`.

Есть:

- точный регрессионный сценарий блокера 9.32.1;
- совместный сценарий двух профильных фич;
- негативная канарейка, доказывающая, что harness умеет краснеть:  
  `/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts:234-247`;
- runtime-предупреждение после минуты непрерывных проходов вне комнаты:  
  `/Users/fj/dev/Polemica 8.1.1/src/core/dom.ts:155-180`.

Это реальное enforcement, а не только правило в AGENTS.md.

## 5. Release script механически защищает часть критичных ошибок

Механически проверяются:

- совпадение версий package/manifest;
- лимит CWS description;
- production typecheck;
- сборка обоих браузеров;
- обязательная подпись XPI при наличии ключей;
- ненулевой exit без ключей, если не указан явный `--skip-sign`.

Код:  
`/Users/fj/dev/Polemica 8.1.1/scripts/release-assets.mjs:32-55`,  
`/Users/fj/dev/Polemica 8.1.1/scripts/release-assets.mjs:65-98`.

Версия дополнительно закреплена offline-инвариантом:  
`/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:269-302`.

---

# Остаточные риски

## Высокий: diagnostic dump раскрывает секреты внутри `obs_host`

Документация снимка обещает «настройки без секретов», но `formatSettings()` маскирует только ключ `obs_password`, а всё остальное сериализует дословно:

`/Users/fj/dev/Polemica 8.1.1/src/core/diag-snapshot.ts:15-22`.

При этом сам проект явно допускает адрес вида:

```text
ws://user:pass@host:4455/?token=…
```

и для обычных OBS-логов специально использует `safeEndpoint()`:

`/Users/fj/dev/Polemica 8.1.1/src/background/obs-client.ts:18-31`.

Следовательно, экспорт 9.33.0 может положить логин, пароль или query-токен прямо в секцию «Настройки». Это обходит sink-level redaction, потому что diagnostic snapshot добавляется непосредственно в Blob:

`/Users/fj/dev/Polemica 8.1.1/src/popup/index.ts:184-200`.

Тест покрывает только `obs_password` и даже закрепляет правило «остальное как есть»:  
`/Users/fj/dev/Polemica 8.1.1/tests/unit/diag-contract.test.ts:47-62`.

Это реальная privacy-регрессия, а не только недостаток документации.

## Высокий: sink-redaction неполон для секретов с пробелами

Регулярное выражение вырезает только первый непробельный фрагмент значения:

`/Users/fj/dev/Polemica 8.1.1/src/core/log.ts:102-118`.

Например, в сериализованном значении `"password":"abcd efgh"` будет скрыта только часть `abcd`, а `efgh` останется. Пароль OBS формально может содержать пробелы. Тесты проверяют только непрерывные значения:

`/Users/fj/dev/Polemica 8.1.1/tests/unit/log.test.ts:11-53`.

Таким образом, утверждение «секреты чистятся всегда на стоке» пока сильнее механической гарантии.

## Высокий: в persisted-журнал попадают ники игроков вопреки заявленному privacy-инварианту

В AGENTS.md заявлено, что ники игроков в лог не пишутся. Однако camera health пишет их на уровне `info`, то есть они попадают в support-файл:

- `/Users/fj/dev/Polemica 8.1.1/src/content/features/camera-health.ts:218-250`
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/camera-health.ts:369-374`
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/camera-health.ts:401-411`
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/camera-health.ts:451-485`

Дополнительные persisted-ники есть в ошибках статистики и lookup:

- `/Users/fj/dev/Polemica 8.1.1/src/content/features/player-notes.ts:1623-1630`
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/player-notes.ts:3343-3356`
- `/Users/fj/dev/Polemica 8.1.1/src/content/features/player-notes.ts:2511-2512`

Тесты наблюдаемости проверяют отсутствие `textContent` только в auto-start, но нет общего механического запрета на ники:  
`/Users/fj/dev/Polemica 8.1.1/tests/invariants/observability.test.ts:86-89`.

## Высокий: release workflow не запускает тесты, contract-suite, test typecheck или lint

Фактический release-gate выполняет только:

```text
npm run typecheck
npm run build
```

`/Users/fj/dev/Polemica 8.1.1/scripts/release-assets.mjs:65-75`.

Он не запускает:

- `npm test`;
- `npm run test:contract`;
- `npx tsc --noEmit -p tests/tsconfig.json`;
- web-ext lint.

AGENTS.md перечисляет эти команды, но это документация, не enforcement:  
`/Users/fj/dev/Polemica 8.1.1/AGENTS.md:22-29`,  
`/Users/fj/dev/Polemica 8.1.1/AGENTS.md:155-175`.

CI отсутствует. Следовательно, релиз может быть собран и подписан при красных unit/invariant-тестах, сломанной типизации тестов или уже уехавшем контракте сайта.

## Высокий: отдельная типизация тестов сейчас красная

Запуск `npx tsc --noEmit -p tests/tsconfig.json` завершился ошибками. В частности:

- CSS-entries fixture не имеют `sha256`, но код обращается к нему без narrowing:  
  `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-contract.test.ts:74-79`,  
  `/Users/fj/dev/Polemica 8.1.1/tests/fixtures/site-contract.json:24-30`;
- `withPlayers` остаётся possibly undefined:  
  `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:97-101`;
- также есть ошибки mock-типов в нескольких unit-тестах.

При этом AGENTS.md прямо называет эту команду частью тестового процесса:  
`/Users/fj/dev/Polemica 8.1.1/AGENTS.md:157-160`.

Поскольку release и `npm test` её не вызывают, красное состояние остаётся невидимым.

## Средне-высокий: contract-suite может зелёно пропустить исчезнувшие endpoints

Некоторые нетранзиентные ответы трактуются как skip:

- SSR матча пропускается при любом `!res.ok`, включая 404:  
  `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:18-25`;
- `/api/games` также пропускается при любом статусе, отличном от 200:  
  `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:85-93`;
- отсутствие активных игр/игроков превращает проверку shape в skip:  
  `/Users/fj/dev/Polemica 8.1.1/tests/contract/site-ssr-api.test.ts:95-100`.

Это расходится с документированным обещанием «исчезнувший selector/API shape — fail». Перенос или удаление endpoint способен дать зелёный suite с skipped-тестом.

## Средний: fixture update для CSS противоречит собственной политике

В fixture у CSS намеренно нет SHA:

`/Users/fj/dev/Polemica 8.1.1/tests/fixtures/site-contract.json:24-30`.

Но код:

- читает `sha256` у всех bundle entries;
- при `UPDATE_CONTRACT_FIXTURES=1` записывает SHA всем entries.

`/Users/fj/dev/Polemica 8.1.1/tests/contract/site-contract.test.ts:74-79`,  
`/Users/fj/dev/Polemica 8.1.1/tests/contract/site-contract.test.ts:187-196`.

Это одновременно причина TypeScript-ошибки и риск того, что ручное обновление fixture тихо отменит политику «CSS SHA не пригвождаем».

## Средний: runtime contract-watchdog слишком узок, чтобы называться watchdog всего site contract

Он измеряет только комнату и только четыре агрегата:

- плитки;
- широкий OR-селектор controls;
- камеры;
- источник role sprite.

`/Users/fj/dev/Polemica 8.1.1/src/content/features/contract-watch.ts:25-51`.

Предупреждение возникает только при `tiles === 0 || controls === 0`; нулевые камеры сами по себе не считаются поломкой:  
`/Users/fj/dev/Polemica 8.1.1/src/content/features/contract-watch.ts:49-52`.

`obsGameControls` — широкий OR из кнопок, settings и ролей, поэтому исчезновение одного важного класса может быть замаскировано другим:  
`/Users/fj/dev/Polemica 8.1.1/src/core/selectors.ts:233-238`.

Также:

- измерение только одно, через 15 секунд;
- уход раньше отменяет его;
- поиск, профиль, match SSR/API и семантика кнопок runtime-сторожем не покрыты;
- предупреждение существует только в локальном журнале, без telemetry/notification;
- при выключенном persistent logging оно не переживёт страницу.

Код жизненного цикла корректен:  
`/Users/fj/dev/Polemica 8.1.1/src/content/features/contract-watch.ts:54-124`.

Но это датчик нескольких room-selector’ов, не замена live contract-suite.

## Средний: `complete: yes` не означает, что история инцидента действительно полна

Health-path хорошо ловит известный отказ записи, включая отметку от другого контекста:

`/Users/fj/dev/Polemica 8.1.1/src/core/log.ts:254-304`,  
`/Users/fj/dev/Polemica 8.1.1/src/core/log.ts:448-493`.

Но остаются две дыры:

1. При полном отказе `storage.local`, когда не проходит даже маленький health marker, popup не может узнать о сбое в другой вкладке.
2. Нормально провернувшееся кольцо из 600 строк не считается неполным. `health.lost` ставится только если кольцо провернулось во время известного storage failure:  
   `/Users/fj/dev/Polemica 8.1.1/src/core/log.ts:383-388`.

Поэтому шумный, но технически исправно сохранявшийся журнал может потерять начало инцидента и всё равно получить `complete: yes`. Нет счётчика вытесненных строк или диапазона фактического покрытия.

## Средний: diagnostic snapshot показывает только состояние в момент экспорта

Активные фичи, путь вкладки, настройки и OBS снимаются при нажатии «Скачать лог»:

`/Users/fj/dev/Polemica 8.1.1/src/popup/index.ts:130-179`.

Если пользователь после сбоя:

- перешёл на другую страницу;
- обновил вкладку;
- изменил настройку;
- переподключил OBS,

снимок описывает уже новое состояние. В самом dump нет incident-time snapshots и внутренних state machine состояний — только список active IDs. Для краткого первичного triage это полезно, но не доказывает состояние на момент ошибки.

## Средний: storage dump перечисляет все неизвестные ключи, а не только безопасный allowlist

Комментарий обещает заметки как метрики и перечисление технических `pn_/obs_`-ключей, но реализация складывает в `rest` любой ключ, кроме notes и обычных logs:

`/Users/fj/dev/Polemica 8.1.1/src/core/diag-snapshot.ts:31-63`.

Содержимое не раскрывается, однако:

- имена будущих или legacy-ключей могут оказаться user-derived;
- WS chunks перечисляются по отдельным session-key;
- объём секции зависит от любого постороннего/битого состояния storage.

Тест проверяет отсутствие текста заметок, но не ограничивает allowlist ключей:  
`/Users/fj/dev/Polemica 8.1.1/tests/unit/diag-contract.test.ts:65-79`.

## Средний: обычный WS diagnostic dump честнее основного лога, но его полнота не маркируется

Плюсы:

- выключен по умолчанию;
- отсекает Janus/media;
- редактирует authKey;
- ограничен 2 млн символов;
- чистит старые chunks.

`/Users/fj/dev/Polemica 8.1.1/src/core/ws-log.ts:12-22`,  
`/Users/fj/dev/Polemica 8.1.1/src/core/ws-log.ts:38-73`,  
`/Users/fj/dev/Polemica 8.1.1/src/core/ws-log.ts:218-264`.

Но при отказе `collectAll()` просто возвращает пустой массив:  
`/Users/fj/dev/Polemica 8.1.1/src/core/ws-log.ts:270-284`.

Popup интерпретирует пустоту как «настройку не включили или включили поздно», не как возможный отказ чтения:  
`/Users/fj/dev/Polemica 8.1.1/src/popup/index.ts:225-238`.

То есть completeness-защита обычного журнала на отдельный WS-файл не распространяется.

---

# Adversarial review №11/#12: документация против enforcement

## Что хорошо в формулировке

Промт №11 правильно требует учиться на продовых пропусках, связывать каждый пропущенный баг с конкретным промтом и удалять неработающие пункты:

`/Users/fj/dev/Polemica 8.1.1/docs/audit-prompts.md:233-255`.

№12 вводит полезную reviewer-canary: подсадить известную регрессию и не доверять ревьюеру, который её не нашёл:

`/Users/fj/dev/Polemica 8.1.1/docs/audit-prompts.md:257-272`.

Git-history показывает реальную adversarial-волну в `5638ca1`: четыре ревьюера нашли блокеры и высокие дефекты. HEAD `cf16641` добавил fixpoint-canary.

## Чего нет механически

- Нет команды или CI-job, обязательной перед commit/release.
- Нет machine-readable записи reviewer verdict.
- Нет проверки «тот же reviewer сделал контрольный раунд».
- Нет проверки периодичности №11 «раз в ~5 релизов».
- Нет доказательства запуска именно reviewer-canary №12. Указанный прецедент — мутация тестового harness, а не проверка способности adversarial reviewer найти подсаженный дефект.
- Последние отчёты и complaints нужно вручную «вставить или указать»; актуальный AGENTS §8 заканчивается древней историей 8.1.28, поэтому вход №11 не самодостаточен.
- Инструкция №12 предлагает править рабочую копию и затем `git checkout`, но не требует отдельный worktree, проверки чистого status или точечного восстановления. Это создаёт риск стереть законные незакоммиченные изменения.

Итого: №11/#12 — хорошие process aids, но пока **не enforcement**.

---

# Release workflow и историческая дисциплина

## Механически защищено

- version sync;
- production typecheck/build;
- dual target;
- обязательная Firefox-подпись;
- CWS uploadState failure;
- точные permission-инварианты.

Доказательства:

- `/Users/fj/dev/Polemica 8.1.1/scripts/release-assets.mjs:32-98`
- `/Users/fj/dev/Polemica 8.1.1/scripts/publish-chrome.mjs:59-84`
- `/Users/fj/dev/Polemica 8.1.1/tests/invariants/architecture.test.ts:269-329`

## Только документация/ручная дисциплина

- adversarial review;
- unit/invariant tests;
- live contracts;
- test typecheck;
- web-ext lint;
- просмотр fixture diff;
- проверка чистого git status;
- соответствие публикуемого zip текущему commit.

Особенно опасно, что `publish-chrome.mjs` берёт уже существующий zip и текущую версию package, но не проверяет версию manifest внутри zip, свежесть или hash артефакта:

`/Users/fj/dev/Polemica 8.1.1/scripts/publish-chrome.mjs:17-36`.

Можно случайно опубликовать устаревший артефакт, если release-assets не запускался после последнего изменения.

---

# Документация, требующая осторожности

Privacy policy устарела относительно текущего поведения:

- говорит «технические логи — если вы включили», но default logging сейчас `true`:  
  `/Users/fj/dev/Polemica 8.1.1/docs/privacy-policy.md:17-23`,  
  `/Users/fj/dev/Polemica 8.1.1/src/core/settings.ts:94`;
- не описывает отдельный полный WS-лог с ролями, ночными ходами и чатом;
- всё ещё объясняет permission `scripting`, которого в manifest больше нет:  
  `/Users/fj/dev/Polemica 8.1.1/docs/privacy-policy.md:46-55`,  
  `/Users/fj/dev/Polemica 8.1.1/src/manifest/manifest.base.json:6-10`.

README-диагностика также описывает `polemicaDiag()`, тогда как основной актуальный путь — popup export + runtime contract-watch:  
`/Users/fj/dev/Polemica 8.1.1/README.md:146-154`.

---

# Приоритетный вывод

Перед следующим инцидентом система уже способна быстро ответить:

- какая версия и вкладка работала;
- какие фичи реально активны;
- какие настройки действуют;
- жив ли OBS;
- были ли terminal outcomes;
- не уехали ли ключевые room selectors;
- не было ли main-thread freeze или DOM storm.

Но доверять файлу безоговорочно пока нельзя. Главные остаточные проблемы:

1. **секреты из `obs_host` в diagnostic dump;**
2. **неполная sink-redaction;**
3. **ники игроков в persisted logs вопреки политике;**
4. **release не блокируется тестами/contracts/lint;**
5. **test typecheck уже красный;**
6. **adversarial review №11/#12 остаётся недоказуемой ручной процедурой;**
7. **runtime contract-watch покрывает лишь небольшой фрагмент внешнего контракта.**

Таким образом, observability в 9.33.1 стала существенно практичнее, но engineering process ещё не гарантирует, что эти защиты обязательно сработают перед каждым выпуском.
</task_result>
</task>
```

**Tool: glob**

**Input:**
```json
{
  "pattern": "{package.json,src/core/{feature,dom,settings}.ts,src/content/index.ts,tests/invariants/dom-fixpoint.test.ts,docs/audit-prompts.md,.github/workflows/*}"
}
```

**Output:**
```
/Users/fj/dev/Polemica 8.1.1/src/content/index.ts
/Users/fj/dev/Polemica 8.1.1/src/core/feature.ts
/Users/fj/dev/Polemica 8.1.1/src/core/settings.ts
/Users/fj/dev/Polemica 8.1.1/src/core/dom.ts
/Users/fj/dev/Polemica 8.1.1/package.json
/Users/fj/dev/Polemica 8.1.1/docs/audit-prompts.md
/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts
```

**Tool: grep**

**Input:**
```json
{
  "pattern": "\"version\"|mutation|test:contract|typecheck|release:assets",
  "path": "/Users/fj/dev/Polemica 8.1.1",
  "include": "package.json"
}
```

**Output:**
```
Found 4 matches
/Users/fj/dev/Polemica 8.1.1/package.json:
  Line 3:   "version": "9.33.1",

  Line 15:     "typecheck": "tsc --noEmit",

  Line 17:     "test:contract": "vitest run --config vitest.contract.config.ts",

  Line 23:     "release:assets": "node scripts/release-assets.mjs",

```

---

## Assistant (Build · GPT-5.6 Sol · 12.7s)

_Thinking:_

**Verifying key privacy and test gate**

Ключевое уточнение после проверки: новый fixpoint-механизм настоящий, но его охват уже уже формулировки «инвариант стал исполняемым», а release-путь не делает тесты обязательным gate. Дополнительно обнаружены несколько не теоретических privacy-расхождений в новом диагностическом экспорте; перепроверяю их по исходникам перед итоговой оценкой.

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/src/core/diag-snapshot.ts"
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/src/core/diag-snapshot.ts</path>
<type>file</type>
<content>
1: /**
2:  * Диагностический снимок состояния — раздел в экспорте лога (решение
3:  * владельца 26.08.2026 после обсуждения внешнего арх-ревью).
4:  *
5:  * Каждый разбор жалобы начинался с реконструкции: «а что вообще включено,
6:  * что в хранилище, жив ли OBS?». Снимок отвечает на это до первого вопроса.
7:  *
8:  * ПРИВАТНОСТЬ (инвариант аудита 01.08.2026 — лог уезжает в файл для
9:  * поддержки): в снимок НЕ кладутся тексты заметок, история чата и пароль
10:  * OBS. Хранилище описывается МЕТРИКАМИ (счётчики и размеры), не содержимым.
11:  */
12: import type { Settings } from "@shared/types";
13: import { NOTES_KEY } from "./notes-store";
14: 
15: /** Настройки для снимка: секреты маскируются, остальное — как есть. */
16: export function formatSettings(settings: Settings): string[] {
17:   return Object.entries(settings)
18:     .sort(([a], [b]) => a.localeCompare(b))
19:     .map(([key, value]) => {
20:       if (key === "obs_password") return `${key}: ${value ? "<задан>" : "<пуст>"}`;
21:       return `${key}: ${JSON.stringify(value)}`;
22:     });
23: }
24: 
25: export interface StorageMetric {
26:   label: string;
27:   count: number;
28:   bytes: number;
29: }
30: 
31: /**
32:  * Метрики storage.local: размер по группам, содержимое не раскрывается.
33:  * Заметки — одной строкой «N шт, X КБ»; журнал — своей группой; прочие
34:  * pn_/obs_-ключи перечисляются поимённо (их значения — техфлаги, не тексты).
35:  */
36: export function storageMetrics(all: Record<string, unknown>): StorageMetric[] {
37:   const size = (v: unknown): number => {
38:     try {
39:       return JSON.stringify(v)?.length ?? 0;
40:     } catch {
41:       return 0;
42:     }
43:   };
44:   const out: StorageMetric[] = [];
45:   let logCount = 0;
46:   let logBytes = 0;
47:   const rest: StorageMetric[] = [];
48:   for (const [key, value] of Object.entries(all)) {
49:     if (key === NOTES_KEY) {
50:       const notes = value && typeof value === "object" ? Object.keys(value).length : 0;
51:       out.push({ label: `заметки (${NOTES_KEY})`, count: notes, bytes: size(value) });
52:       continue;
53:     }
54:     if (key.startsWith("polemica:logs:")) {
55:       logCount++;
56:       logBytes += size(value);
57:       continue;
58:     }
59:     rest.push({ label: key, count: 1, bytes: size(value) });
60:   }
61:   if (logCount > 0) out.push({ label: "журнал (буферы)", count: logCount, bytes: logBytes });
62:   rest.sort((a, b) => b.bytes - a.bytes);
63:   return [...out, ...rest];
64: }
65: 
66: export function formatMetrics(metrics: StorageMetric[]): string[] {
67:   return metrics.map(
68:     (m) => `${m.label}: ${m.count} шт, ${(m.bytes / 1024).toFixed(1)} КБ`,
69:   );
70: }
71: 
72: /** Раздел снимка с заголовком; секции падают поодиночке, не всем снимком. */
73: export function section(title: string, lines: string[]): string {
74:   return [`── ${title} ──`, ...(lines.length ? lines : ["<пусто>"])].join("\n");
75: }

(End of file - total 75 lines)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/src/core/log.ts",
  "offset": 90,
  "limit": 45
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/src/core/log.ts</path>
<type>file</type>
<content>
90: /** Не из page-storage: см. resolveConsoleLevel. Меняется только кодом расширения. */
91: let bufferLevel: Level = "info";
92: let flushTimer: ReturnType<typeof setTimeout> | null = null;
93: let dirty = false;
94: 
95: /**
96:  * Вырезать из строки то, что похоже на секреты, и обрезать по длине.
97:  * Логи выгружаются в файл, который пользователь отправляет в поддержку —
98:  * ключи сессии, токены и пароли туда попадать не должны (аудит безопасности
99:  * 01.08.2026). Экспортируется, чтобы этим пользовались все, кто логирует
100:  * строки из сети/страницы.
101:  */
102: // \b вокруг коротких слов обязателен: без него «sid» съедал «considered».
103: // Схема (Bearer/Basic) пропускается ПЕРЕД значением, иначе вырезалось слово
104: // схемы, а сам токен оставался в логе.
105: // Разделителей между ключом и значением до восьми: у форматированного JSON
106: // (`"token" : "abcdef"`) их пять, и при лимите в четыре секрет оставался в
107: // логе целиком (тест-набор 01.08.2026, №6). Перенос строки в разделители НЕ
108: // входит: с ним слово на следующей строке лога вырезалось как «значение»
109: // ключа с прошлой — JSON.stringify всё равно держит ключ и значение вместе.
110: // Префикс `(?:[a-z0-9]+[_-])?` обязателен: `\b` перед словом не срабатывает
111: // после подчёркивания, и наш СОБСТВЕННЫЙ ключ `obs_password` уходил в лог
112: // нетронутым (ревью 02.08.2026). Слова вроде «considered» по-прежнему целы:
113: // их защищает `\b` в конце («sidered» — не граница слова).
114: const SECRET_RE =
115:   /(\b(?:[a-z0-9]+[_-])?(?:auth[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|session[_-]?id|sid|authorization)\b["' \t:=]{0,8}(?:(?:Bearer|Basic)\s+)?)([^\s,&"';]{4,})/gi;
116: 
117: export function redactSecrets(input: string, maxLen = 400): string {
118:   return input.replace(SECRET_RE, (_m, k: string) => `${k}…`).slice(0, maxLen);
119: }
120: 
121: /**
122:  * Что мы ОСОЗНАННО не вычищаем (решение владельца, 02.08.2026).
123:  *
124:  * Аудит наблюдаемости предлагал заменять имена сцен OBS и название твич-канала
125:  * на «задано/пусто». Оставили как есть: без имени сцены жалобу «переключилось
126:  * не туда» разобрать нечем, а риск невелик — это собственный лог пользователя,
127:  * который он сам решает отправить. Секреты (ключи, токены, пароли) чистятся
128:  * всегда и на стоке; адрес OBS — только схема+хост+порт, причина обрыва — наша
129:  * категория вместо текста от сервера.
130:  */
131: 
132: function fmtArgs(args: unknown[]): string {
133:   return args
134:     .map((a) => {

(Showing lines 90-134 of 517. Use offset=135 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/scripts/release-assets.mjs",
  "offset": 55,
  "limit": 50
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/scripts/release-assets.mjs</path>
<type>file</type>
<content>
55: }
56: 
57: async function zipTarget(target, outName) {
58:   const out = path.join(dist, outName);
59:   await fs.rm(out, { force: true });
60:   // zip пишет пути относительно cwd — поэтому пакуем изнутри папки таргета.
61:   run("zip", ["-qr", out, "."], { cwd: path.join(dist, target) });
62:   return out;
63: }
64: 
65: async function main() {
66:   const version = await readVersion();
67:   console.log(`\n▶ Сборка релиза ${version}\n`);
68: 
69:   run("npm", ["run", "typecheck"]);
70:   run("npm", ["run", "build"]);
71: 
72:   const assets = [
73:     await zipTarget("chrome", "polemica-chrome.zip"),
74:     await zipTarget("firefox", "polemica-firefox.zip"),
75:   ];
76: 
77:   if (skipSign) {
78:     console.log("\n⚠ Подпись пропущена (--skip-sign): Firefox-пользователи получат только zip.\n");
79:   } else if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
80:     console.error(
81:       "\n✖ Нет ключей AMO. Подпись пропущена, .xpi НЕ собран.\n" +
82:         "  source ~/.config/polemica-notes/amo.env && npm run release:assets\n",
83:     );
84:     process.exitCode = 1;
85:   } else {
86:     const signedDir = path.join(dist, "signed");
87:     // Чистим: web-ext складывает сюда все прошлые версии, и glob ниже мог бы
88:     // подобрать .xpi от предыдущего релиза.
89:     await fs.rm(signedDir, { recursive: true, force: true });
90:     run("npx", ["web-ext", "sign", "-s", "dist/firefox", "-a", "dist/signed", "--channel", "unlisted"]);
91: 
92:     const xpi = (await fs.readdir(signedDir)).find((f) => f.endsWith(".xpi"));
93:     if (!xpi) throw new Error("web-ext отработал, но .xpi не найден");
94:     // Имя от web-ext — со служебным хешем; для релиза даём человеческое.
95:     const target = path.join(dist, `polemica-notes-firefox-${version}.xpi`);
96:     await fs.copyFile(path.join(signedDir, xpi), target);
97:     assets.push(target);
98:   }
99: 
100:   console.log("\n✓ Файлы релиза:");
101:   for (const a of assets) console.log("  " + path.relative(root, a));
102:   console.log(
103:     `\nДальше:\n  gh release create v${version} ${assets
104:       .map((a) => path.relative(root, a))

(Showing lines 55-104 of 112. Use offset=105 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/package.json"
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/package.json</path>
<type>file</type>
<content>
1: {
2:   "name": "polemica-notes",
3:   "version": "9.33.1",
4:   "private": true,
5:   "description": "Расширение для Polemica Game: статистика, заметки, OBS, Twitch",
6:   "type": "module",
7:   "scripts": {
8:     "clean": "rimraf dist .dist-js",
9:     "build:js": "tsup",
10:     "assemble:chrome": "node scripts/assemble.mjs chrome",
11:     "assemble:firefox": "node scripts/assemble.mjs firefox",
12:     "build:chrome": "npm run build:js && npm run assemble:chrome",
13:     "build:firefox": "npm run build:js && npm run assemble:firefox",
14:     "build": "npm run clean && npm run build:js && npm run assemble:chrome && npm run assemble:firefox",
15:     "typecheck": "tsc --noEmit",
16:     "test": "vitest run --config vitest.config.ts",
17:     "test:contract": "vitest run --config vitest.contract.config.ts",
18:     "test:watch": "vitest --config vitest.config.ts",
19:     "lint:ext:chrome": "web-ext lint -s dist/chrome",
20:     "lint:ext:firefox": "web-ext lint -s dist/firefox",
21:     "dev:firefox": "web-ext run -s dist/firefox",
22:     "sign:firefox": "web-ext sign -s dist/firefox -a dist/signed --channel unlisted",
23:     "release:assets": "node scripts/release-assets.mjs",
24:     "chrome:auth": "node scripts/chrome-auth.mjs",
25:     "publish:chrome": "node scripts/publish-chrome.mjs"
26:   },
27:   "devDependencies": {
28:     "@types/chrome": "^0.0.270",
29:     "@types/node": "^26.1.2",
30:     "@types/webextension-polyfill": "^0.12.5",
31:     "fast-check": "^4.9.0",
32:     "fast-glob": "^3.3.3",
33:     "jsdom": "^30.0.1",
34:     "rimraf": "^6.0.1",
35:     "tsup": "^8.3.5",
36:     "typescript": "^5.7.2",
37:     "vitest": "^4.1.6",
38:     "web-ext": "^8.3.0"
39:   },
40:   "dependencies": {
41:     "webextension-polyfill": "^0.12.0"
42:   }
43: }

(End of file - total 43 lines)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts",
  "offset": 55,
  "limit": 205
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/tests/invariants/dom-fixpoint.test.ts</path>
<type>file</type>
<content>
55:       ],
56:       total: 2,
57:     })),
58:     completeHistory: vi.fn(async (_id: unknown, first: { rows: unknown[] }) => ({
59:       rows: first.rows,
60:       truncated: false,
61:     })),
62:   };
63: });
64: 
65: // ВАЖНО: @core/dom НЕ мокается — конвейер настоящий.
66: import { onDomChange } from "@core/dom";
67: import { log } from "@core/log";
68: import { getOwnUserId } from "@core/own-user";
69: import { profileCrossoverFeature, syncProfileCrossoverRoute } from "@content/features/profile-crossover";
70: import { profileMmrChartFeature, syncProfileMmrRoute } from "@content/features/profile-mmr-chart";
71: import type { FeatureContext } from "@core/feature";
72: 
73: const ROUND_MS = 600;
74: const MAX_ROUNDS = 60;
75: const QUIET_ROUNDS = 4;
76: 
77: /**
78:  * Крутит конвейер до фикспоинта. Возвращает {settled, rounds} — ассерты
79:  * снаружи, чтобы канарейка могла утверждать ОБРАТНОЕ.
80:  */
81: async function driveToFixpoint(): Promise<{ settled: boolean; rounds: number }> {
82:   let seen = 0;
83:   const counter = new MutationObserver((m) => {
84:     seen += m.length;
85:   });
86:   counter.observe(document.documentElement, {
87:     childList: true,
88:     subtree: true,
89:     attributes: true,
90:   });
91:   try {
92:     let quiet = 0;
93:     for (let round = 1; round <= MAX_ROUNDS; round++) {
94:       const before = seen;
95:       await vi.advanceTimersByTimeAsync(ROUND_MS);
96:       await Promise.resolve(); // микротаски MutationObserver
97:       if (seen === before) {
98:         quiet++;
99:         if (quiet >= QUIET_ROUNDS) return { settled: true, rounds: round };
100:       } else {
101:         quiet = 0;
102:       }
103:     }
104:     return { settled: false, rounds: MAX_ROUNDS };
105:   } finally {
106:     counter.disconnect();
107:   }
108: }
109: 
110: function mountProfileDom(): void {
111:   document.body.innerHTML =
112:     '<div class="profile__right">' +
113:     '<div class="profile__right-info"></div>' +
114:     '<div class="profile__right-tabs"></div>' +
115:     "</div>";
116: }
117: 
118: beforeEach(() => {
119:   vi.useFakeTimers();
120:   // Скрытая вкладка: @core/dom планирует чистыми setTimeout — конвейер
121:   // полностью под фейковыми таймерами.
122:   Object.defineProperty(document, "hidden", { value: true, configurable: true });
123:   document.body.innerHTML = "";
124:   (getOwnUserId as ReturnType<typeof vi.fn>).mockResolvedValue(13509);
125: });
126: 
127: afterEach(() => {
128:   profileCrossoverFeature.disable();
129:   profileMmrChartFeature.disable();
130:   syncProfileCrossoverRoute(null);
131:   syncProfileMmrRoute(null);
132:   vi.useRealTimers();
133: });
134: 
135: describe("§4 fixpoint: профильные карточки", () => {
136:   test("чужой профиль: «Вместе с вами» рисуется и DOM затихает", async () => {
137:     mountProfileDom();
138:     window.history.replaceState(null, "", "/profile/993");
139:     profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
140:     const r = await driveToFixpoint();
141:     expect(r.settled, `DOM не затих за ${r.rounds} раундов — цикл подписчика`).toBe(true);
142:     expect(document.querySelector(".pn-profile-crossover")?.textContent).toContain(
143:       "Совместных игр",
144:     );
145:   });
146: 
147:   test("СЦЕНАРИЙ БЛОКЕРА: свой профиль — карточка самоудаляется БЕЗ вечного цикла", async () => {
148:     // Ровно тот случай, что прошёл мимо ручных тестов: самоудаление рождает
149:     // мутацию, и старый apply() вставлял карточку заново — навсегда.
150:     mountProfileDom();
151:     window.history.replaceState(null, "", "/profile/13509");
152:     profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
153:     const r = await driveToFixpoint();
154:     expect(r.settled, `DOM не затих за ${r.rounds} раундов — вечный цикл вернулся`).toBe(true);
155:     expect(document.querySelector(".pn-profile-crossover")).toBeNull();
156:   });
157: 
158:   test("разлогин: обе карточки самоудаляются и затихают ВМЕСТЕ", async () => {
159:     (getOwnUserId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
160:     mountProfileDom();
161:     window.history.replaceState(null, "", "/profile/993");
162:     profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
163:     profileMmrChartFeature.enable({ settings: {} } as unknown as FeatureContext);
164:     const r = await driveToFixpoint();
165:     expect(r.settled, `DOM не затих за ${r.rounds} раундов`).toBe(true);
166:     expect(document.querySelector(".pn-profile-crossover")).toBeNull();
167:     expect(document.querySelector(".pn-mmr-chart")).toBeNull();
168:   });
169: 
170:   test("свой профиль: график рисуется, кроссовер уходит — фикспоинт при обеих фичах", async () => {
171:     mountProfileDom();
172:     window.history.replaceState(null, "", "/profile/13509");
173:     profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
174:     profileMmrChartFeature.enable({ settings: {} } as unknown as FeatureContext);
175:     const r = await driveToFixpoint();
176:     expect(r.settled, `DOM не затих за ${r.rounds} раундов`).toBe(true);
177:     expect(document.querySelector(".pn-mmr-chart")?.textContent).toContain("Путь MMR");
178:     expect(document.querySelector(".pn-profile-crossover")).toBeNull();
179:   });
180: });
181: 
182: describe("рантайм-сторож шторма (живой лог, не только тесты)", () => {
183:   test("минута безостановочных проходов вне комнаты — одна warn-строка", async () => {
184:     window.history.replaceState(null, "", "/profile/1");
185:     // Управляемые часы для performance.now: реальное время в фейк-таймерах
186:     // не течёт, а сторожу нужно «прожить» минуту.
187:     let clock = 0;
188:     const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
189:     const off = onDomChange(() => {
190:       document.body.appendChild(document.createElement("div")); // шторм
191:     });
192:     try {
193:       document.body.appendChild(document.createElement("span"));
194:       for (let i = 0; i < 130; i++) {
195:         clock += 600;
196:         await vi.advanceTimersByTimeAsync(600);
197:         await Promise.resolve();
198:       }
199:       const warns = (log.warn as ReturnType<typeof vi.fn>).mock.calls
200:         .map((c) => c.join(" "))
201:         .filter((line) => line.includes("не затихает"));
202:       expect(warns.length, "предупреждение о шторме — ровно одно (латч)").toBe(1);
203:     } finally {
204:       off();
205:       perfSpy.mockRestore();
206:     }
207:   });
208: 
209:   test("в игровой комнате шторм легитимен — сторож молчит", async () => {
210:     window.history.replaceState(null, "", "/game/123");
211:     let clock = 0;
212:     const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
213:     const off = onDomChange(() => {
214:       document.body.appendChild(document.createElement("div"));
215:     });
216:     try {
217:       document.body.appendChild(document.createElement("span"));
218:       for (let i = 0; i < 130; i++) {
219:         clock += 600;
220:         await vi.advanceTimersByTimeAsync(600);
221:         await Promise.resolve();
222:       }
223:       const warns = (log.warn as ReturnType<typeof vi.fn>).mock.calls
224:         .map((c) => c.join(" "))
225:         .filter((line) => line.includes("не затихает"));
226:       expect(warns).toHaveLength(0);
227:     } finally {
228:       off();
229:       perfSpy.mockRestore();
230:     }
231:   });
232: });
233: 
234: describe("канарейка: харнес обязан УМЕТЬ падать", () => {
235:   test("нарочно неидемпотентный подписчик детектируется как нефикспоинт", async () => {
236:     // Тот же класс, что блокер: каждая пачка мутаций — новая запись в DOM.
237:     const off = onDomChange(() => {
238:       document.body.appendChild(document.createElement("div"));
239:     });
240:     try {
241:       document.body.appendChild(document.createElement("span")); // затравка
242:       const r = await driveToFixpoint();
243:       expect(r.settled, "харнес «озеленил» вечный цикл — страж сломан").toBe(false);
244:     } finally {
245:       off();
246:     }
247:   });
248: });

(End of file - total 248 lines)
</content>
```

**Tool: grep**

**Input:**
```json
{
  "pattern": "log\\.(info|warn|error)\\([^\\n]*(nick|nickname|username)|nickname:|nick:",
  "path": "/Users/fj/dev/Polemica 8.1.1/src/content",
  "include": "*.ts"
}
```

**Output:**
```
Found 13 matches
/Users/fj/dev/Polemica 8.1.1/src/content/features/player-notes.ts:
  Line 1335:   private colorForPlayer(id: string | undefined, nick: string | undefined): string {

  Line 1629:       log.error("player-notes", `loadPlayerStats failed for ${username}`, e);

  Line 2512:         log.warn("player-notes", "unsafe username, note not saved", username);

  Line 2711:   ): Promise<{ key: string; nick: string; id?: string } | null> {

  Line 2741:         return { key: idKey(raw), nick: user.username, id: raw };

  Line 2751:         return { key: k, nick: v.nick, id: k.slice(ID_KEY_PREFIX.length) };

  Line 2757:         return { key: idKey(player.user_id), nick: raw, id: String(player.user_id) };

  Line 2763:     return { key: existingNickKey ?? raw, nick: raw };

  Line 2808:           ...(isIdKey(key) ? { nick: createNick } : {}),

  Line 2859:     nick: string;

  Line 2868:         nick:

  Line 2924:     const renderAddResult = (found: { key: string; nick: string; id?: string }) => {

  Line 3351:         log.warn("player-notes", `player ${username} not found in rating`);

```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/src/content/features/contract-watch.ts"
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/src/content/features/contract-watch.ts</path>
<type>file</type>
<content>
1: /**
2:  * Фича: сторож контракта с сайтом (решение владельца 26.08.2026).
3:  *
4:  * Сайт — Vue-SPA без версионирования разметки: селектор может умереть молча,
5:  * и до этой фичи поломку диагностировали раскопками по жалобе. Сторож пишет
6:  * ОДНУ строку на вход в комнату: сколько ключевых узлов нашлось и откуда
7:  * взялся спрайт ролей. Здоровая строка — фон; строка с нулём — готовый
8:  * диагноз («селектор устарел») ещё до жалобы.
9:  *
10:  * Замер — через 15 секунд после входа: комната монтируется асинхронно,
11:  * мерить раньше значит ловить ложные нули. Уход из комнаты до срока
12:  * отменяет замер. Всегда включён (settingKey null): это датчик, пишет
13:  * только в журнал.
14:  */
15: import { log } from "@core/log";
16: import { SITE } from "@core/selectors";
17: import { resolveRoleSpriteBaseUrl } from "../role-sprite";
18: import type { Feature } from "@core/feature";
19: 
20: const SCOPE = "contract";
21: 
22: /** Пауза после входа в комнату до замера. */
23: export const SETTLE_MS = 15_000;
24: 
25: export interface RoomContract {
26:   tiles: number;
27:   controls: number;
28:   cameras: number;
29:   /** Откуда взялся спрайт ролей: живой DOM или зашитый фолбэк. */
30:   spriteSource: "dom" | "fallback";
31: }
32: 
33: /** Замер ключевых селекторов комнаты. Чистая по DOM — тестовый шов. */
34: export function evaluateRoomContract(root: ParentNode = document): RoomContract {
35:   const spriteInDom =
36:     root.querySelector(SITE.roleSymbols) !== null ||
37:     Array.from(root.querySelectorAll(SITE.roleUse)).some((u) => {
38:       const href = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
39:       return ["#civilian", "#sheriff", "#mafia", "#godfather"].some((m) => href.includes(m));
40:     });
41:   return {
42:     tiles: root.querySelectorAll(SITE.playerDesktop).length,
43:     controls: root.querySelectorAll(SITE.obsGameControls).length,
44:     cameras: root.querySelectorAll(SITE.playerVideo).length,
45:     spriteSource: spriteInDom ? "dom" : "fallback",
46:   };
47: }
48: 
49: /** Нули там, где в живой комнате нулей не бывает, — контракт под вопросом. */
50: export function contractLooksBroken(c: RoomContract): boolean {
51:   return c.tiles === 0 || c.controls === 0;
52: }
53: 
54: let enabled = false;
55: let inRoom = false;
56: let settleTimer: ReturnType<typeof setTimeout> | null = null;
57: /** Фолбэк-спрайт проверяется сетью один раз за сессию вкладки. */
58: let spriteProbed = false;
59: 
60: function cancelSettle(): void {
61:   if (settleTimer !== null) {
62:     clearTimeout(settleTimer);
63:     settleTimer = null;
64:   }
65: }
66: 
67: function measure(): void {
68:   const c = evaluateRoomContract();
69:   const line = `комната: плитки=${c.tiles} контролы=${c.controls} камеры=${c.cameras} спрайт=${c.spriteSource}`;
70:   if (contractLooksBroken(c)) {
71:     // Нули — вероятный дрейф разметки сайта: селекторы пора сверять.
72:     log.warn(SCOPE, line, "— похоже на смену разметки сайта");
73:   } else {
74:     log.info(SCOPE, line);
75:   }
76:   // Зашитый фолбэк спрайта — единственный наш URL с hash'ем сборки сайта:
77:   // пересобрали бандл — иконки ролей молча пропали бы. Проверяем раз в сессию.
78:   if (c.spriteSource === "fallback" && !spriteProbed) {
79:     spriteProbed = true;
80:     const base = resolveRoleSpriteBaseUrl();
81:     if (base) {
82:       fetch(base, { method: "HEAD" })
83:         .then((res) => {
84:           if (!res.ok) log.warn(SCOPE, `фолбэк-спрайт ролей не отвечает (${res.status}): ${base}`);
85:         })
86:         .catch(() => log.warn(SCOPE, "фолбэк-спрайт ролей недоступен:", base));
87:     }
88:   }
89: }
90: 
91: /** Маршрут от URL-роутера: в игровой комнате или нет. */
92: export function syncContractWatchRoute(nowInRoom: boolean): void {
93:   if (nowInRoom === inRoom) return;
94:   inRoom = nowInRoom;
95:   cancelSettle();
96:   if (!enabled || !nowInRoom) return;
97:   settleTimer = setTimeout(() => {
98:     settleTimer = null;
99:     measure();
100:   }, SETTLE_MS);
101: }
102: 
103: export const contractWatchFeature: Feature = {
104:   id: "contract-watch",
105:   // Датчик: ничего не делает за игрока, пишет только в журнал.
106:   settingKey: null,
107: 
108:   enable() {
109:     enabled = true;
110:     // Включились уже в комнате (бут вкладки) — таймер с этого момента.
111:     if (inRoom) {
112:       cancelSettle();
113:       settleTimer = setTimeout(() => {
114:         settleTimer = null;
115:         measure();
116:       }, SETTLE_MS);
117:     }
118:   },
119: 
120:   disable() {
121:     enabled = false;
122:     cancelSettle();
123:   },
124: };

(End of file - total 124 lines)
</content>
```

---

## Assistant (Build · GPT-5.6 Sol · 10.0s)

_Thinking:_

**Inspecting camera health and obs_host credentials**

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/src/core/feature.ts"
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/src/core/feature.ts</path>
<type>file</type>
<content>
1: /**
2:  * Единый жизненный цикл фич content-скрипта.
3:  * Заменяет 11 самописных синглтонов с ручным роутингом onMessage в каждом файле.
4:  *
5:  * FeatureManager сам включает/выключает фичи при изменении настроек —
6:  * больше не нужен location.reload() для применения тумблеров.
7:  */
8: import { getSettings, onSettingsChanged } from "./settings";
9: import { log } from "./log";
10: import type { Settings, SettingKey } from "@shared/types";
11: 
12: export interface FeatureContext {
13:   readonly settings: Settings;
14: }
15: 
16: export interface Feature {
17:   /** Уникальный id для логов. */
18:   readonly id: string;
19:   /** Ключ настройки-выключателя; null = фича включена всегда. */
20:   readonly settingKey: SettingKey | null;
21:   /** Включить фичу: повесить слушатели/observers. */
22:   enable(ctx: FeatureContext): void | Promise<void>;
23:   /** Выключить фичу: ОБЯЗАТЕЛЬНО снять все слушатели/observers/интервалы. */
24:   disable(): void;
25:   /** (Опционально) реакция на изменение настроек без выкл/вкл. */
26:   update?(ctx: FeatureContext): void;
27: }
28: 
29: export class FeatureManager {
30:   private features: Feature[] = [];
31:   private active = new Set<string>();
32:   private settings: Settings | null = null;
33:   /** Хвост очереди: sync() никогда не выполняется параллельно сам с собой. */
34:   private queue: Promise<void> = Promise.resolve();
35:   private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
36: 
37:   /** Активные фичи — для диагностического снимка (26.08.2026). */
38:   activeIds(): string[] {
39:     return [...this.active].sort();
40:   }
41: 
42:   register(...f: Feature[]): this {
43:     this.features.push(...f);
44:     return this;
45:   }
46: 
47:   async start(): Promise<void> {
48:     this.settings = await getSettings();
49:     await this.enqueueSync();
50:     this.logSkippedAtBoot();
51:     onSettingsChanged((patch) => {
52:       this.settings = { ...(this.settings as Settings), ...patch };
53:       // Сохранение настроек пишет в sync и local раздельно → два события подряд.
54:       // Склеиваем их, чтобы не гонять sync() дважды на одно нажатие тумблера.
55:       if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
56:       this.coalesceTimer = setTimeout(() => {
57:         this.coalesceTimer = null;
58:         void this.enqueueSync();
59:       }, 50);
60:     });
61:   }
62: 
63:   /** Ставит проход в очередь; параллельных enable() для одной фичи не будет. */
64:   private enqueueSync(): Promise<void> {
65:     this.queue = this.queue.then(
66:       () => this.sync(),
67:       () => this.sync(),
68:     );
69:     return this.queue;
70:   }
71: 
72:   /**
73:    * Одна строка в журнал при буте: какие фичи пропущены настройками и что
74:    * РЕАЛЬНО лежит в хранилище под их ключом. Пропуск по настройке — законное
75:    * молчание, но когда пользователь жалуется «кнопок нет», а в попапе
76:    * «галочки стоят», журнал обязан отвечать сам (жалоба 25.08.2026: полдня
77:    * раскопок вместо одной строки). JSON.stringify показывает и тип: строка
78:    * "true" из битого хранилища видна как «"true"», а не как булево.
79:    */
80:   private logSkippedAtBoot(): void {
81:     const s = this.settings as Settings;
82:     if (s.extension_enabled === false) return; // мастер-выключатель — не «пропуск»
83:     const skipped = this.features
84:       .filter((f) => f.settingKey !== null && !this.isEnabled(f))
85:       .map((f) => `${f.id}(${f.settingKey}=${JSON.stringify(s[f.settingKey as keyof Settings])})`);
86:     if (skipped.length) log.info("feature", "пропущены настройками:", skipped.join(" "));
87:   }
88: 
89:   private isEnabled(f: Feature): boolean {
90:     const s = this.settings as Settings;
91:     // Мастер-выключатель гасит все фичи разом, включая безусловные (settingKey null).
92:     if (s.extension_enabled === false) return false;
93:     return f.settingKey === null || s[f.settingKey] === true;
94:   }
95: 
96:   private async sync(): Promise<void> {
97:     const ctx: FeatureContext = { settings: this.settings as Settings };
98:     for (const f of this.features) {
99:       const shouldEnable = this.isEnabled(f);
100:       const isActive = this.active.has(f.id);
101:       if (shouldEnable && !isActive) {
102:         // Резервируем id ДО await: иначе повторный проход успеет вызвать
103:         // enable() второй раз и оставит второй набор слушателей навсегда.
104:         this.active.add(f.id);
105:         try {
106:           await f.enable(ctx);
107:           log.info("feature", "enabled", f.id);
108:         } catch (e) {
109:           this.active.delete(f.id);
110:           log.error("feature", "enable failed", f.id, e);
111:           // Откат: enable мог успеть навесить часть слушателей/таймеров до
112:           // падения — без disable() они жили бы вечно, а следующий проход
113:           // включил бы фичу ВТОРЫМ экземпляром поверх осиротевшего.
114:           try {
115:             f.disable();
116:           } catch {
117:             /* фича не обязана переживать disable после неполного enable */
118:           }
119:         }
120:       } else if (!shouldEnable && isActive) {
121:         try {
122:           f.disable();
123:         } catch (e) {
124:           log.error("feature", "disable failed", f.id, e);
125:         }
126:         this.active.delete(f.id);
127:         log.info("feature", "disabled", f.id);
128:       } else if (shouldEnable && isActive && f.update) {
129:         try {
130:           f.update(ctx);
131:         } catch (e) {
132:           log.error("feature", "update failed", f.id, e);
133:         }
134:       }
135:     }
136:   }
137: }

(End of file - total 137 lines)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/src/background/obs-client.ts",
  "offset": 1,
  "limit": 42
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/src/background/obs-client.ts</path>
<type>file</type>
<content>
1: /**
2:  * OBS WebSocket (obs-websocket v5) клиент, живущий в background.
3:  * Порт прежнего BackgroundOBSWebSocket с фиксами:
4:  *  - нет стэкающихся таймеров (reconnect/heartbeat гасятся перед новым запуском);
5:  *  - browser.* вместо chrome.*;
6:  *  - рассылка событий через типизированную шину messaging.
7:  */
8: import { browser } from "@core/env";
9: import { log } from "@core/log";
10: import { broadcastToGameTabs, sendRuntime } from "@core/messaging";
11: import type { ObsConnectionState, ObsScene, ObsSceneData } from "@shared/types";
12: 
13: interface ConnSettings {
14:   url: string;
15:   password: string;
16: }
17: 
18: /**
19:  * Адрес OBS для лога: только схема, хост и порт.
20:  *
21:  * В `obs_host` пользователь может вписать `ws://user:pass@host:4455/?token=…`
22:  * — логин, пароль и query оттуда в файл поддержки уезжать не должны (аудит
23:  * наблюдаемости 02.08.2026, LOG-3).
24:  */
25: export function safeEndpoint(url: string): string {
26:   try {
27:     const u = new URL(url);
28:     return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
29:   } catch {
30:     return "(некорректный адрес)";
31:   }
32: }
33: 
34: /**
35:  * Категория неудачной попытки подключения — вместо сырого `Error.message`.
36:  * Текст ошибки может содержать адрес с логином и паролем, а нам нужен только
37:  * класс отказа (аудит наблюдаемости 02.08.2026, OC-1).
38:  */
39: export function failureCategory(e: unknown): string {
40:   const msg = e instanceof Error ? e.message : String(e ?? "");
41:   if (/timeout/i.test(msg)) return "таймаут подключения";
42:   if (/Неверный пароль/i.test(msg)) return "неверный пароль";

(Showing lines 1-42 of 725. Use offset=43 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/src/content/features/camera-health.ts",
  "offset": 205,
  "limit": 55
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/src/content/features/camera-health.ts</path>
<type>file</type>
<content>
205:     const byTrack = deadCause(track);
206:     if (byTrack) {
207:       this.frozenPasses.delete(video);
208:       return byTrack;
209:     }
210:     const now = video.currentTime;
211:     const frozen = isFrozen(this.lastTimes.get(video), now) && !video.paused;
212:     this.lastTimes.set(video, now);
213:     const passes = frozen ? (this.frozenPasses.get(video) ?? 0) + 1 : 0;
214:     this.frozenPasses.set(video, passes);
215:     return passes >= FROZEN_PASSES ? "frozen" : null;
216:   }
217: 
218:   /** Поставить/снять метку обрыва. Идемпотентно (§4 п.1). */
219:   private markTile(tile: HTMLElement, cause: DeadCause | null): void {
220:     const wrapper = tile.querySelector<HTMLElement>(SITE.playerVideoWrapper) ?? tile;
221:     const existing = wrapper.querySelector<HTMLElement>(`.${OVERLAY_CLASS}`);
222:     if (!cause) {
223:       if (existing) {
224:         existing.remove();
225:         // Снятие тоже в журнал: пара «оборвалось → ожило» и есть картина
226:         // инцидента; без второй половины лог читается как вечный обрыв.
227:         log.info(SCOPE, `видео ожило: «${tileNick(tile)}»`);
228:       }
229:       return;
230:     }
231:     if (existing) return;
232:     const badge = document.createElement("div");
233:     badge.className = OVERLAY_CLASS;
234:     badge.dataset.pnCause = cause;
235:     badge.title = "Видео от игрока не приходит — похоже, у него оборвалась связь";
236:     badge.style.cssText =
237:       "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
238:       "pointer-events:none;z-index:5;background:rgba(0,0,0,.25)";
239:     badge.innerHTML =
240:       '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#ff6b6b" ' +
241:       'stroke-width="2" stroke-linecap="round" style="filter:drop-shadow(0 0 3px rgba(0,0,0,.9))">' +
242:       '<path d="M1 1l22 22"/>' +
243:       '<path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>' +
244:       '<path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>' +
245:       '<path d="M10.71 5.05A16 16 0 0 1 22.58 9"/>' +
246:       '<path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>' +
247:       '<path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>' +
248:       '<line x1="12" y1="20" x2="12" y2="20"/></svg>';
249:     wrapper.appendChild(badge);
250:     log.info(SCOPE, `видео оборвалось: «${tileNick(tile)}» (${cause})`);
251:   }
252: 
253:   private removeOverlays(): void {
254:     document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
255:   }
256: 
257:   // ─────────── кнопка «Перезагрузить камеры» ───────────
258: 
259:   private syncButton(): void {

(Showing lines 205-259 of 518. Use offset=260 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/src/content/features/camera-health.ts",
  "offset": 355,
  "limit": 65
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/src/content/features/camera-health.ts</path>
<type>file</type>
<content>
355:     s.src = browser.runtime.getURL("media-probe-page.js");
356:     s.onload = () => {
357:       s.remove();
358:       this.probeInjected = true;
359:       onReady();
360:     };
361:     s.onerror = () => {
362:       s.remove();
363:       showToast("Не удалось поставить обработчик видео — попробуй перезагрузить страницу");
364:       log.warn(SCOPE, "media-probe-page.js не загрузился");
365:     };
366:     (document.head || document.documentElement).appendChild(s);
367:   }
368: 
369:   /** Ники плиток с меткой обрыва — картина «до» и «после» для журнала. */
370:   private deadNicks(): string[] {
371:     return Array.from(document.querySelectorAll<HTMLElement>(`.${OVERLAY_CLASS}`)).map((badge) => {
372:       const tile = badge.closest<HTMLElement>(SITE.player);
373:       return tile ? tileNick(tile) : "?";
374:     });
375:   }
376: 
377:   private sendCmd(action: "refresh" | "reconnect"): void {
378:     this.stage = action;
379:     this.ensureProbe(() => {
380:       try {
381:         window.postMessage({ source: MEDIA_CMD_SOURCE, action }, location.origin);
382:       } catch {
383:         this.reconnecting = false;
384:         this.stage = null;
385:       }
386:     });
387:     // Страховка: зонд не ответил (страница перерисовалась, скрипт умер) —
388:     // кнопка не должна остаться заблокированной навсегда.
389:     this.verdictTimer = setTimeout(() => {
390:       if (this.reconnecting) {
391:         this.reconnecting = false;
392:         this.stage = null;
393:         this.syncButton();
394:         showToast("Видео не ответило на переподключение — похоже, нужен F5");
395:         log.warn(SCOPE, `зонд не ответил на команду ${action}`);
396:         log.flushNow();
397:       }
398:     }, VERDICT_DELAY_MS);
399:   }
400: 
401:   private reconnect(): void {
402:     if (this.reconnecting) return;
403:     // Гейт от гонки: речь могла начаться между проходами наблюдателя.
404:     if (ownSpeechInProgress()) {
405:       showToast("Идёт твоя речь — после неё");
406:       return;
407:     }
408:     this.reconnecting = true;
409:     this.syncButton();
410:     // Картина «до» — без неё по журналу не понять, что именно чинили.
411:     log.info(SCOPE, `кнопка камер: мёртвых плиток ${this.deadNicks().length} [${this.deadNicks().join(", ")}]`);
412:     showToast("Обновляю видео…");
413:     // ЛЕСЕНКА. Сначала мягкий шаг: updateStreams() дожимает отложенные
414:     // подписки и не рвёт ничего — у остальных даже не мигнёт. Жёсткое
415:     // пересоздание — только если мягкого не хватило.
416:     this.sendCmd("refresh");
417:   }
418: 
419:   private onProbeResult(e: MessageEvent): void {

(Showing lines 355-419 of 518. Use offset=420 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/src/content/features/camera-health.ts",
  "offset": 440,
  "limit": 50
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/src/content/features/camera-health.ts</path>
<type>file</type>
<content>
440:         reason === "media_not_connected"
441:           ? "Видеосвязь ещё не поднята — переподключать нечего"
442:           : "Не удалось обновить видео — сайт изменился или матч не идёт. Поможет F5",
443:       );
444:       return;
445:     }
446: 
447:     if (step === "refresh") {
448:       log.info(SCOPE, "мягкий шаг прошёл (updateStreams), жду кадры");
449:       // Дожатой подписке нужна пара секунд; если метки сошли — жёсткий шаг
450:       // не нужен вовсе, и ни у кого ничего не мигнуло.
451:       this.verdictTimer = setTimeout(() => {
452:         this.verdictTimer = null;
453:         const still = this.deadNicks();
454:         if (still.length === 0) {
455:           this.reconnecting = false;
456:           this.stage = null;
457:           this.syncButton();
458:           log.info(SCOPE, "хватило мягкого шага — соединения не трогали");
459:           log.flushNow();
460:           showToast("Видео обновлено");
461:           return;
462:         }
463:         log.info(SCOPE, `мягкого шага мало, остались [${still.join(", ")}] — пересоздаю сессию`);
464:         showToast("Не помогло мягко — переподключаю видео целиком…");
465:         this.sendCmd("reconnect");
466:       }, SOFT_WAIT_MS);
467:       return;
468:     }
469: 
470:     log.info(SCOPE, "медиа-сессия пересоздана");
471:     // Вердикт «помогло/нет» — по меткам обрыва спустя пару секунд: если
472:     // мёртвые плитки остались, честно говорим, что кнопка не всесильна.
473:     this.verdictTimer = setTimeout(() => {
474:       this.verdictTimer = null;
475:       this.reconnecting = false;
476:       this.stage = null;
477:       this.syncButton();
478:       const still = this.deadNicks();
479:       // Итог — в журнал и сразу на диск: это и есть доказательство «работает /
480:       // не работает» для разбора без повторной игры.
481:       log.info(
482:         SCOPE,
483:         still.length === 0
484:           ? "итог: все плитки ожили"
485:           : `итог: не ожили [${still.join(", ")}] — проблема на их стороне`,
486:       );
487:       log.flushNow();
488:       showToast(
489:         still.length > 0

(Showing lines 440-489 of 518. Use offset=490 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/fj/dev/Polemica 8.1.1/tests/tsconfig.json"
}
```

**Output:**
```
<path>/Users/fj/dev/Polemica 8.1.1/tests/tsconfig.json</path>
<type>file</type>
<content>
1: {
2:   "extends": "../tsconfig.json",
3:   "compilerOptions": {
4:     "types": ["node", "chrome", "vitest/globals", "vitest/jsdom"],
5:     "paths": {
6:       "@core/*": ["src/core/*"],
7:       "@shared/*": ["src/shared/*"],
8:       "@content/*": ["src/content/*"]
9:     },
10:     "noEmit": true
11:   },
12:   "include": ["./**/*.ts", "../vitest*.config.ts", "../src/**/*.ts"]
13: }

(End of file - total 13 lines)
</content>
```

**Tool: glob**

**Input:**
```json
{
  "pattern": ".github/workflows/**",
  "path": "/Users/fj/dev/Polemica 8.1.1"
}
```

**Output:**
```
No files found
```

---

## Assistant (Build · GPT-5.6 Sol · 55.6s)

_Thinking:_

**Assessing project strengths and risks**

_Thinking:_

**Highlighting maturity contradictions and privacy issues**

_Thinking:_

**Clarifying architecture-process relationship and scoring**

## 1. Общая оценка

**8,2/10.** Это зрелый эксплуатационно-ориентированный проект: архитектура хорошо удерживает уже известные классы отказов и заметно сокращает время диагностики новых. Но формулировка «инварианты стали исполняемыми» пока верна не для всей системы, а для тщательно выбранных критических участков.

## 2. Что сделано особенно сильно

- **FeatureManager соответствует масштабу проекта.** `src/core/feature.ts` действительно остаётся тонким координатором lifecycle, а не скрытым сервис-локатором или доменным god object. Очередь синхронизации, резервирование feature ID до `await enable()` и rollback через `disable()` закрывают реальные гонки без лишней архитектуры.

- **Storage разделён по семантике, а не по удобству API.** Заметки, настройки, секрет OBS, временное состояние и состояние, переживающее смерть MV3 service worker, размещены осознанно. Для расширений это важнее красивой модели Store.

- **SharedDomObserver является настоящей инфраструктурной границей.** Единственный production `MutationObserver`, батчинг, ограничение буфера, режим фоновой вкладки и изоляция подписчиков дают контролируемый контур вокруг самого опасного внешнего интерфейса проекта: нестабильного DOM чужого Vue-приложения.

- **Fixpoint-харнес технически честный.** `tests/invariants/dom-fixpoint.test.ts` не мокает `@core/dom`, возвращает собственные DOM-мутации фич обратно через настоящий observer и имеет отрицательную канарейку. Это существенно сильнее regex-теста или правила в `AGENTS.md`.

- **Диагностика ориентирована на расследование, а не на количество логов.** Экспорт показывает эффективные настройки, storage-метрики, OBS и реально активные feature ID по вкладкам. Раздельные content-сессии и terminal outcomes позволяют восстанавливать цепочку событий, а не только видеть исключение.

- **Внешний контракт сайта защищён несколькими слоями.** Fixtures, live contract-suite, semantic probes, мутационные канарейки и runtime-снимок комнаты дополняют друг друга. Это правильнее, чем пытаться построить большой PageModel над чужим Vue.

- **Инциденты превращаются в локальные ограничения системы.** `AGENTS.md` здесь не просто справочник: часть его правил уже материализована в primitives, тестах, storage migration policy и release checks. Для соло-проекта это очень сильная форма институциональной памяти.

- **Архитектура экономна.** Плоский каталог фич и небольшое число общих механизмов выглядят лучше искусственного деления на domain/application/infrastructure для расширения такого масштаба.

## 3. Реальные остаточные риски

### Release-процесс не замыкает исполняемые стражи

`release:assets` запускает production typecheck и build, но не запускает:

- `npm test`;
- `npm run test:contract`;
- типизацию тестов;
- `web-ext lint`.

CI workflow также отсутствует. Следовательно, 1066 тестов и fixpoint-канарейка являются исполняемыми, но не обязательными для выпуска. Для соло-мейнтейнера отсутствие CI само по себе допустимо; отсутствие тестов в единственной release-команде уже является архитектурным разрывом между заявленным процессом и enforcement.

Причём `npx tsc --noEmit -p tests/tsconfig.json` сейчас не проходит. Production typecheck и 1066 тестов зелёные, live contract-suite зелёный, но отдельная типизация тестов даёт ошибки. Это конкретное доказательство того, что ручной шаг уже выпал из регулярного контура.

### Fixpoint-инвариант исполнен не полностью

Production содержит примерно двадцать подписок `onDomChange`, а поведенческий fixpoint-харнес прогоняет две профильные фичи: `profile-crossover` и `profile-mmr-chart`.

Не покрыты тем же настоящим observer-loop, среди прочих:

- `player-notes`;
- `auto-start`;
- `role-marker`;
- OBS/Twitch panels;
- `controls-safety`.

Канарейка доказывает работоспособность харнеса, но нет механизма, который заставляет каждую новую DOM-пишущую подписку получить сценарий. Поэтому точная формулировка такая: **критический класс цикла теперь механически ловится в покрытых сценариях**, а не «для всех DOM-писателей проекта».

### Диагностический дамп имеет privacy-регрессии

В `src/core/diag-snapshot.ts:15-22` маскируется только `obs_password`. При этом проект явно допускает `obs_host` вида `ws://user:pass@host/?token=...` и в обычном OBS-логе специально очищает его через `safeEndpoint()`. В snapshot такой адрес экспортируется целиком.

Также sink-redaction в `src/core/log.ts:114-118` обрезает секрет по первому пробелу. Пароль с пробелами может быть скрыт частично.

Наконец, `camera-health.ts` пишет в persisted `info` ники игроков, хотя `AGENTS.md` утверждает, что ники в файл не попадают. Например, журналируются списки мёртвых плиток и результаты переподключения.

Это наиболее неприятный текущий разрыв: privacy-правило сформулировано доктринально, но универсального исполняемого стража на него нет.

### Runtime contract-watch является узким датчиком

Он делает один снимок через 15 секунд и предупреждает только при нулевых `tiles` или `controls`. Нулевые камеры сами по себе не считаются поломкой. Поздний drift после первого измерения также не обнаруживается.

Это полезная строка первичной диагностики, но не сторож всего site contract и не замена live-suite.

### Live contracts иногда могут стать ложно-зелёными

Некоторые постоянные 404/non-200 и ответы 200 с HTML трактуются как сетевой skip. Это разумная защита от WAF и нестабильности сайта, но удалённый endpoint способен превратиться в skipped test вместо fail.

### Основной монолит уже является зоной риска

`player-notes.ts` примерно на 4100 строк объединяет storage, миграции, API resolution, мьюты, цвета, камеры, модалки, статистику и route state. Пока это компенсируется знанием автора и плотными тестами, но стоимость доказательства локальности изменения уже высока.

Триггер распила вместо немедленной реорганизации является разумной позицией. Однако файл уже не просто «большая фича», а самостоятельная подсистема без внутренних модульных границ.

### Есть остаточные гонки долговечных данных

Основной путь записи заметок координируется background-очередью, но при ошибке messaging content и popup переходят к прямой whole-map записи. Две вкладки в fallback-режиме могут потерять одно из параллельных изменений.

Похожий read-modify-write без глобальной сериализации остаётся у role marks, мьютов и пользовательских цветов. Вероятность невелика, но сценарий конкретный и относится к долговечному пользовательскому состоянию.

### Adversarial review остаётся преимущественно человеческим протоколом

Промты №11 и №12 хороши как process aids. Но репозиторий механически не подтверждает:

- запуск review перед каждым релизом;
- контрольный раунд тем же reviewer;
- периодичность мета-ревью;
- успешное прохождение reviewer-canary.

Это не обесценивает практику. Это означает, что она зависит от дисциплины одного человека сильнее, чем тестовые инварианты.

## 4. Архитектура как следствие процесса

Здесь архитектура в значительной степени является **кристаллизованной историей инцидентов**.

Shared observer, local storage заметок, атомарные миграции, alarm-based MV3 state, terminal logging и fixpoint-harness появились не из предварительной доктрины, а из конкретных отказов. Для такого проекта это преимущество: архитектура оптимизирована под реальные failure modes, а не под абстрактную чистоту.

Но причинность уже работает в обе стороны:

- процесс находит новый класс ошибки;
- архитектура локализует место, где поставить защиту;
- тест или primitive превращает урок в повторяемое ограничение;
- следующий review проверяет уже более узкую поверхность.

Слабое место этой модели видно там, где урок остаётся текстом: privacy логов, полнота fixpoint-покрытия, обязательность review и release-gates. Там архитектура ещё не приняла эстафету у процесса.

Иными словами: **проект зрел не потому, что у него “правильные слои”, а потому, что он умеет переводить эксплуатационные знания в код. Но перевод пока не стопроцентный.**

## 5. Итоговый балл

**8,2/10.**

Почему не выше:

- тесты не встроены в обязательный release gate;
- типизация тестов уже красная;
- fixpoint enforcement покрывает только часть DOM-писателей;
- новый диагностический экспорт имеет реальные privacy-расхождения;
- крупные stateful-модули повышают стоимость доказательства корректности;
- часть adversarial-процесса остаётся недоказуемой ручной дисциплиной.

Почему не ниже:

- основные браузерные failure modes поняты и явно смоделированы;
- критичные пользовательские данные имеют продуманную storage-семантику;
- lifecycle и MV3 ограничения учитываются лучше, чем в большинстве расширений;
- тесты проверяют поведение и инварианты, а не только функции;
- есть настоящие отрицательные канарейки;
- диагностика позволяет быстро отличать внутренний дефект от drift сайта;
- проект системно снижает вероятность повторения уже пережитых классов ошибок.

## 6. Положение относительно других проектов

**Относительно типичных open-source расширений:** верхние несколько процентов. Большинство расширений не имеют ни моделирования MV3 lifecycle, ни contract-suite к чужому сайту, ни property tests, ни контролируемого DOM-observer, ни пригодного support-лога.

**Относительно сильных соло-проектов:** верхний эшелон, но не эталон полностью самопринуждающейся инженерной системы. Эталонный уровень потребовал бы, чтобы заявленные проверки нельзя было случайно обойти штатным release-путём, а privacy-инварианты и полнота критического покрытия контролировались механически.

Главное достоинство Polemica Notes не число тестов и не FeatureManager. Это высокая скорость превращения инцидента в постоянную защиту. Главный остаточный риск состоит в том, что несколько наиболее важных обещаний пока всё ещё зависят от памяти и дисциплины того же человека, который пишет и выпускает код.

---

