/**
 * Раскладка кнопок действий в игре — ОБЩЕЕ знание попапа и content-скрипта.
 *
 * Живёт в shared, потому что список значений обязан быть один: попап рисует
 * по нему `<select>` и нормализует мусор из storage, content — решает, какой
 * CSS применить. Разъедься они, и настройка молча перестала бы действовать
 * (кейс, который в проекте уже был с twitch_floating_panel_enabled).
 *
 * Зачем настройка вообще: раскладка была зашита в код (решение владельца
 * 09.08.2026 — увести «Завершите речь» от «Выкрикнуть»), а значит любая
 * перестановка стоила бы релиза. Теперь человек двигает кнопки сам, и это же
 * снимает спор о «правильном» месте — у каждого оно своё.
 */
export const CONTROL_POSITIONS = ["left", "center", "right"] as const;

export type ControlPosition = (typeof CONTROL_POSITIONS)[number];

/** Кнопки, которыми управляет настройка (ключ → как её зовут в игре). */
export const CONTROL_KINDS = {
  finish: "Завершите речь",
  outcry: "Выкрикнуть",
  guess: "Лучший ход",
} as const;

export type ControlKind = keyof typeof CONTROL_KINDS;

/**
 * Значения по умолчанию — та самая безопасная раскладка: «Завершите речь» и
 * «Выкрикнуть» разведены по разным краям, чтобы конец речи не попадал по
 * выкрику (жалоба 09.08.2026).
 */
export const DEFAULT_CONTROL_POSITIONS: Record<ControlKind, ControlPosition> = {
  finish: "right",
  outcry: "center",
  guess: "left",
};

/** Значение из настроек с защитой от мусора: неизвестное — дефолт кнопки. */
export function readControlPosition(kind: ControlKind, value: unknown): ControlPosition {
  return (CONTROL_POSITIONS as readonly string[]).includes(String(value))
    ? (value as ControlPosition)
    : DEFAULT_CONTROL_POSITIONS[kind];
}

/** Ключ настройки для кнопки. */
export function controlPositionKey(kind: ControlKind): string {
  return `ctl_pos_${kind}`;
}
