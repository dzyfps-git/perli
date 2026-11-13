import type { Progress } from "../../api";

/** What one item costs beyond its bytes, so a thousand tiny files still move the bar. */
const ITEM_WEIGHT = 4096;
/** How much of each new speed reading counts. Lower is steadier. */
const SMOOTHING = 0.25;
/** Readings closer together than this are mostly noise. */
const MIN_GAP_MS = 200;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

const work = (bytes: number, items: number) => bytes + items * ITEM_WEIGHT;

/** How far along a job is, from 0 to 1. */
export function fraction(progress: Progress) {
  const total = work(progress.totalBytes, progress.totalItems);
  return total > 0 ? Math.min(1, work(progress.bytes, progress.items) / total) : 0;
}

export interface Rate {
  at: number;
  bytes: number;
  work: number;
  /** Bytes per second. */
  speed: number;
  /** Work per second, which also counts items. */
  pace: number;
}

export const startRate = (at: number): Rate => ({ at, bytes: 0, work: 0, speed: 0, pace: 0 });

export function nextRate(rate: Rate, progress: Progress, at: number): Rate {
  const elapsed = at - rate.at;
  if (elapsed < MIN_GAP_MS) return rate;
  const done = work(progress.bytes, progress.items);
  const smooth = (old: number, change: number) => {
    const reading = (change / elapsed) * 1000;
    return old === 0 ? reading : old + (reading - old) * SMOOTHING;
  };
  return {
    at,
    bytes: progress.bytes,
    work: done,
    speed: smooth(rate.speed, progress.bytes - rate.bytes),
    pace: smooth(rate.pace, done - rate.work),
  };
}

/** Seconds, or undefined until there is a pace to go by. */
export function secondsLeft(progress: Progress, rate: Rate) {
  if (rate.pace <= 0) return undefined;
  const total = work(progress.totalBytes, progress.totalItems);
  return Math.max(0, (total - work(progress.bytes, progress.items)) / rate.pace);
}

/** How many speed readings a card keeps for its line. */
export const SPEED_SAMPLES = 40;

/** The newest readings, oldest first. */
export const withSpeed = (speeds: number[], speed: number) => [...speeds, speed].slice(-SPEED_SAMPLES);

/** The speeds as SVG polyline points across `width`, the fastest at the top. */
export function speedLine(speeds: number[], width: number, height: number) {
  const top = Math.max(...speeds);
  if (speeds.length < 2 || top <= 0) return "";
  const step = width / (speeds.length - 1);
  return speeds.map((speed, at) => `${+(at * step).toFixed(1)},${+(height - (speed / top) * height).toFixed(1)}`).join(" ");
}

/** What a finished job does next: nothing, open its folder, or eject its drive. */
export type Then = "none" | "open" | "eject";

/** The next choice on a card's "when done" chip. Eject is there only for a drive that can go. */
export function nextThen(then: Then, ejects: boolean): Then {
  if (then === "none") return "open";
  if (then === "open" && ejects) return "eject";
  return "none";
}

const counted = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`);

/** What the start put right after Perli closed in the middle of a job, or "" for nothing. */
export function sweptText(putBack: number, cleaned: number) {
  const parts = [
    putBack > 0 ? `${counted(putBack, "moved file was", "moved files were")} put back where ${putBack === 1 ? "it was" : "they were"}` : "",
    cleaned > 0 ? `unfinished copies were cleared from ${counted(cleaned, "folder", "folders")}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return "";
  const text = parts.join(", and ");
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

export function formatSeconds(seconds: number) {
  if (seconds < SECONDS_PER_MINUTE) return `${Math.ceil(seconds)} s`;
  if (seconds < SECONDS_PER_HOUR) return `${Math.ceil(seconds / SECONDS_PER_MINUTE)} min`;
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  return `${hours} h ${Math.ceil((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)} min`;
}
