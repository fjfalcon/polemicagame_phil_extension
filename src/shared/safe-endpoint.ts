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
