/** A film handed between the preview and the small window that plays it on. */

/** A film of the same folder, which can play next. */
export interface Film {
  path: string;
  name: string;
}

export interface Handover extends Film {
  /** Grows with each hand-over, so the small window takes each one once. */
  seq: number;
  /** Where the window streams the film from. */
  url: string;
  /** Where the film was, in seconds, and when that was read (`Date.now()`). */
  time: number;
  at: number;
  playing: boolean;
  speed: number;
  loop: boolean;
  muted: boolean;
  /** The text of the `.srt` or `.vtt` beside it, if there is one. */
  subtitles?: string;
  /** The film's width over its height. */
  aspect: number;
  /** The films after it in its folder, in list order. */
  next: Film[];
}

/** What the small window hands back to the full player. */
export type HandBack = Pick<Handover, "path" | "time" | "at" | "playing" | "speed">;

/** The corner of the screen the small window sits in, and how wide it is. */
export interface MiniPlace {
  corner: "tl" | "tr" | "bl" | "br";
  width: number;
}

export const START_PLACE: MiniPlace = { corner: "br", width: 400 };

/** Seconds before the end that the next film is offered. */
export const UP_NEXT_SECONDS = 10;

/** Where a film read at `time` has got to by `now`: on, at its speed, if it plays. */
export const caughtUp = (film: Pick<Handover, "time" | "at" | "playing" | "speed">, now = Date.now()) =>
  film.playing ? film.time + ((now - film.at) / 1000) * film.speed : film.time;

/** "Up next" shows near the end of a film that is not too short to have an end. */
export const upNextShown = (time: number, length: number, hasNext: boolean) =>
  hasNext && length > UP_NEXT_SECONDS * 2 && length - time <= UP_NEXT_SECONDS;

/** A place read back from settings, or the first one if it is not one. */
export function placeOf(value: unknown): MiniPlace {
  const place = value as Partial<MiniPlace> | null;
  const corner = place?.corner;
  const width = place?.width;
  return corner && ["tl", "tr", "bl", "br"].includes(corner) && typeof width === "number" && width > 0
    ? { corner, width }
    : START_PLACE;
}
