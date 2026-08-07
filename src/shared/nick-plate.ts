/**
 * Углы плитки для плашки игрока — ОБЩЕЕ знание попапа и content-скрипта.
 *
 * Живёт в shared, потому что список значений обязан быть один: попап
 * рисует по нему `<select>` и нормализует мусор из storage, content —
 * решает, какой CSS применить. Разъедься они, и настройка молча
 * перестала бы действовать (кейс, который в проекте уже был с
 * twitch_floating_panel_enabled).
 */
export const PLATE_POSITIONS = ["default", "top-left", "top-right", "bottom-right"] as const;

export type PlatePosition = (typeof PLATE_POSITIONS)[number];

/** Значение из настроек с защитой от мусора: неизвестное — угол сайта. */
export function readPlatePosition(value: unknown): PlatePosition {
  return (PLATE_POSITIONS as readonly string[]).includes(String(value))
    ? (value as PlatePosition)
    : "default";
}
