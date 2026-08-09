/**
 * Свой userId на сайте.
 *
 * Зачем: статистика пересечений считается как «мои игры ∩ его игры», а для
 * первой половины нужен собственный id. Сайт держит его в состоянии Vue —
 * из изолированного мира content-скрипта туда не дотянуться, и лезть в мир
 * страницы ради одного числа мы не будем (решение 09.08.2026 про сокет
 * ровно про это).
 *
 * Единственный след в разметке — ссылка на свой профиль в шапке сайта. Но в
 * игровой комнате шапки нет, а кнопка пересечений живёт именно там. Поэтому
 * id читается на любой обычной странице (поиск игры, профиль, разбор) и
 * КЭШИРУЕТСЯ в storage.local: игрок всё равно проходит через страницу
 * поиска перед каждой игрой.
 */
import { browser } from "./env";
import { SITE } from "./selectors";
import { log } from "./log";

const SCOPE = "own-user";
/** Ключ кэша. Не настройка — техническое состояние, живёт локально. */
export const OWN_ID_KEY = "pn_own_user_id";

/** Вытащить id из ссылки вида `/profile/13509`. Чистая функция — тестовый шов. */
export function ownIdFromHref(href: string | null | undefined): number | null {
  const m = /^\/profile\/(\d+)(?:[/?#]|$)/.exec(href ?? "");
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Прочитать свой id из шапки страницы; null — шапки нет (комната, разбор). */
export function readOwnIdFromDom(doc: Document = document): number | null {
  const link = doc.querySelector<HTMLAnchorElement>(SITE.ownProfileLink);
  // getAttribute, а не .href: нужен путь, а не абсолютный адрес.
  return ownIdFromHref(link?.getAttribute("href"));
}

let cached: number | null = null;

/**
 * Свой id: сначала из разметки (она всегда свежее), иначе из кэша.
 *
 * Кэш обновляем только когда разметка дала значение — иначе заход в комнату
 * (где шапки нет) затирал бы уже известный id и кнопка переставала бы
 * работать ровно там, где она нужна.
 */
export async function getOwnUserId(): Promise<number | null> {
  const fromDom = readOwnIdFromDom();
  if (fromDom !== null) {
    if (cached !== fromDom) {
      cached = fromDom;
      try {
        await browser.storage.local.set({ [OWN_ID_KEY]: fromDom });
      } catch {
        /* хранилище недоступно — обойдёмся памятью вкладки */
      }
    }
    return fromDom;
  }
  if (cached !== null) return cached;
  try {
    const got = (await browser.storage.local.get({ [OWN_ID_KEY]: null })) as Record<string, unknown>;
    const id = got[OWN_ID_KEY];
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
      cached = id;
      return id;
    }
  } catch (e) {
    log.warn(SCOPE, "не удалось прочитать кэш своего id", e);
  }
  return null;
}

/** Сбросить память процесса (тесты и выключение фичи). */
export function resetOwnUserIdCache(): void {
  cached = null;
}
