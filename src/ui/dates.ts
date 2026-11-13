/** Dates as `yyyy-mm-dd` text, the way the filter keeps them. No time zones come into it. */

const two = (value: number) => String(value).padStart(2, "0");

export const toDay = (year: number, month: number, day: number) => `${year}-${two(month + 1)}-${two(day)}`;

/** The parts of a day, with months from 0, or nothing when the text is not a real date. */
export function parseDay(text: string) {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!found) return undefined;
  const [year, month, day] = [Number(found[1]), Number(found[2]) - 1, Number(found[3])];
  const real = new Date(year, month, day);
  return real.getFullYear() === year && real.getMonth() === month && real.getDate() === day
    ? { year, month, day }
    : undefined;
}

/** The days of a month in rows of weeks that start on Monday. Days of other months are 0. */
export function monthGrid(year: number, month: number) {
  const before = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((before + days) / 7) * 7 }, (_, at) => {
    const day = at - before + 1;
    return day >= 1 && day <= days ? day : 0;
  });
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

/** The month `step` months away, across years. */
export function monthAfter(year: number, month: number, step: number) {
  const moved = new Date(year, month + step, 1);
  return { year: moved.getFullYear(), month: moved.getMonth() };
}
