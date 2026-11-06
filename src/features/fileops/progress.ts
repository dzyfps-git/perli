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

export function formatSeconds(seconds: number) {
  if (seconds < SECONDS_PER_MINUTE) return `${Math.ceil(seconds)} s`;
  if (seconds < SECONDS_PER_HOUR) return `${Math.ceil(seconds / SECONDS_PER_MINUTE)} min`;
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  return `${hours} h ${Math.ceil((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)} min`;
}
