import type { RiverHour } from "../../api";

/**
 * The Time river: every file under a folder by when it last changed, as a river of days that is
 * wider where more changed. This file holds what can be worked out without a screen.
 */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** The narrowest stretch the river zooms in to. */
export const LEAST_SPAN = 12 * HOUR;

/** The hours counted so far, as sorted times with running sums, to add up any stretch at once. */
export interface River {
  /** Each counted hour's start, in milliseconds since 1970, oldest first. */
  times: number[];
  /** Files and bytes up to and including each hour. */
  files: number[];
  bytes: number[];
}

/** Adds what a walk counted into `known`, by hour. */
export function addHours(known: Map<number, [number, number]>, hours: RiverHour[]) {
  for (const [hour, files, bytes] of hours) {
    const held = known.get(hour);
    known.set(hour, held ? [held[0] + files, held[1] + bytes] : [files, bytes]);
  }
}

export function riverOf(known: Map<number, [number, number]>): River {
  const hours = [...known.keys()].sort((a, b) => a - b);
  const river: River = { times: [], files: [], bytes: [] };
  let files = 0;
  let bytes = 0;
  for (const hour of hours) {
    const [more, size] = known.get(hour)!;
    files += more;
    bytes += size;
    river.times.push(hour * HOUR);
    river.files.push(files);
    river.bytes.push(bytes);
  }
  return river;
}

/** How many hours start before `time`. */
function before(times: number[], time: number) {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Files and bytes that last changed from `from` up to `to`. */
export function sumBetween(river: River, from: number, to: number) {
  const start = before(river.times, from);
  const end = before(river.times, to);
  const at = (sums: number[], index: number) => (index > 0 ? sums[index - 1] : 0);
  return { files: at(river.files, end) - at(river.files, start), bytes: at(river.bytes, end) - at(river.bytes, start) };
}

/** Files in each of `count` equal stretches from `from` to `to`. */
export function columns(river: River, from: number, to: number, count: number): number[] {
  const step = (to - from) / Math.max(1, count);
  return Array.from({ length: count }, (_, at) => sumBetween(river, from + at * step, from + (at + 1) * step).files);
}

/** The values softened over `reach` neighbours each side, so the banks flow instead of stepping. */
export function softened(values: number[], reach: number): number[] {
  if (reach < 1) return values;
  return values.map((_, at) => {
    let sum = 0;
    let weight = 0;
    for (let off = -reach; off <= reach; off++) {
      const value = values[at + off];
      if (value === undefined) continue;
      const share = 1 - Math.abs(off) / (reach + 1);
      sum += value * share;
      weight += share;
    }
    return sum / weight;
  });
}

/** From the first hour counted to the end of the last, with a little room each side. */
export function wholeSpan(river: River): [number, number] {
  if (river.times.length === 0) {
    const now = Date.now();
    return [now - 30 * DAY, now];
  }
  const first = river.times[0];
  const last = river.times[river.times.length - 1] + HOUR;
  const room = Math.max(DAY, (last - first) * 0.03);
  return [first - room, last + room];
}

/** The span zoomed by `factor` (below 1 zooms in) around `at`, kept within `whole` and no narrower than `LEAST_SPAN`. */
export function zoomed([from, to]: [number, number], at: number, factor: number, whole: [number, number]): [number, number] {
  const most = whole[1] - whole[0];
  const span = Math.min(most, Math.max(LEAST_SPAN, (to - from) * factor));
  const share = (at - from) / Math.max(1, to - from);
  return within([at - span * share, at - span * share + span], whole);
}

/** The span moved by `by` milliseconds, kept within `whole`. */
export const panned = ([from, to]: [number, number], by: number, whole: [number, number]) => within([from + by, to + by], whole);

function within([from, to]: [number, number], [first, last]: [number, number]): [number, number] {
  const span = to - from;
  if (span >= last - first) return [first, last];
  if (from < first) return [first, first + span];
  if (to > last) return [last - span, last];
  return [from, to];
}

/** The start of the local day `time` falls in. */
export function dayStart(time: number) {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** The start of the next local day: 23 or 25 hours on when the clocks change that day. */
export function dayEnd(time: number) {
  const day = new Date(dayStart(time));
  day.setDate(day.getDate() + 1);
  return day.getTime();
}

/** A day as the filter form keeps it: `YYYY-MM-DD`, local. */
export function dayKey(time: number) {
  const day = new Date(time);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`;
}

export interface Tick {
  time: number;
  label: string;
  /** A year or a month start: drawn a little stronger. */
  major: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Marks along the bottom, as fine as the span allows with `room` pixels between them. */
export function ticks(from: number, to: number, width: number, room = 90): Tick[] {
  const most = Math.max(2, Math.floor(width / room));
  const span = to - from;
  const found: Tick[] = [];
  const start = new Date(from);
  if (span / (365 * DAY) > most / 2) {
    // Years, every so many.
    const every = Math.max(1, Math.ceil(span / (365 * DAY) / most));
    for (let year = start.getFullYear(); ; year++) {
      const time = new Date(year, 0, 1).getTime();
      if (time > to) break;
      if (time >= from && year % every === 0) found.push({ time, label: String(year), major: true });
    }
  } else if (span / (30 * DAY) > most / 3) {
    const every = Math.max(1, Math.ceil(span / (30.4 * DAY) / most));
    for (let month = new Date(start.getFullYear(), start.getMonth(), 1); month.getTime() <= to; month.setMonth(month.getMonth() + 1)) {
      if (month.getTime() < from || month.getMonth() % every) continue;
      const year = month.getMonth() === 0;
      found.push({ time: month.getTime(), label: year ? String(month.getFullYear()) : MONTHS[month.getMonth()], major: year });
    }
  } else if (span / DAY > most / 6) {
    const every = Math.max(1, Math.ceil(span / DAY / most));
    for (let day = new Date(dayStart(from)); day.getTime() <= to; day.setDate(day.getDate() + 1)) {
      if (day.getTime() < from || (day.getDate() - 1) % every) continue;
      const first = day.getDate() === 1;
      found.push({ time: day.getTime(), label: first ? `${MONTHS[day.getMonth()]} 1` : String(day.getDate()), major: first });
    }
  } else {
    const every = [1, 2, 3, 6, 12].find((hours) => span / (hours * HOUR) <= most) ?? 24;
    for (let hour = Math.ceil(from / HOUR) * HOUR; hour <= to; hour += HOUR) {
      const at = new Date(hour);
      if (at.getHours() % every) continue;
      const midnight = at.getHours() === 0;
      found.push({ time: hour, label: midnight ? `${MONTHS[at.getMonth()]} ${at.getDate()}` : `${String(at.getHours()).padStart(2, "0")}:00`, major: midnight });
    }
  }
  return found;
}
