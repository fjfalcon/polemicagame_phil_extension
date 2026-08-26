/**
 * Адрес OBS для журнала/снимка: только схема+хост+порт. В `obs_host` бывает
 * `ws://user:pass@host/?token=…` — логин, пароль и query не должны попадать
 * в файл, который пользователь отправляет в поддержку (AGENTS.md §5).
 * Вынесен из obs-client 26.08.2026: снимку состояния (попап) нужен тот же
 * фильтр, а тянуть весь OBS-клиент в бандл попапа незачем.
 */
export function safeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "(некорректный адрес)";
  }
}

/**
 * Нормализация obs_host ПРИ СОХРАНЕНИИ (SEC26-1): userinfo и query
 * отрезаются навсегда. Пароль OBS живёт отдельным полем (и только в local),
 * obs-websocket v5 авторизуется хендшейком — креды в URL не нужны ничему,
 * а `obs_host` синкается в облако и уезжает в бэкап-файл.
 */
export function sanitizeObsHost(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  // Без схемы («localhost:4455») URL-парсер увидел бы схему «localhost:» и
  // произвёл мусор — такие строки чистим руками, не «нормализуя».
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    return t.replace(/^[^@/]*@/, "").split("?")[0].split("#")[0];
  }
  try {
    const u = new URL(t);
    // ПУТЬ сохраняем: obs-websocket за реверс-прокси живёт на /websocket и
    // подобных (adversarial 27.08, №5) — режем только userinfo/query/fragment.
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}${path}`;
  } catch {
    // Непарсибельное — минимум срезаем userinfo и query руками.
    return t.replace(/\/\/[^@/]+@/, "//").split("?")[0].split("#")[0];
  }
}
