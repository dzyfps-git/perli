/** The home page's parts, in the order and size the user gave them. */

export type HomeSectionId = "drives" | "space" | "reading" | "pinned" | "folders" | "today";

export interface HomeSection {
  id: HomeSectionId;
  hidden?: boolean;
  /** Takes the whole width rather than half. */
  wide?: boolean;
}

export const HOME_SECTIONS: HomeSection[] = [
  { id: "drives", wide: true },
  { id: "space", wide: true },
  { id: "reading", wide: true },
  { id: "pinned" },
  { id: "folders" },
  { id: "today", wide: true },
];

/** The saved order, without parts that are gone, and with parts added since after the part they follow. */
export function cleanSections(saved: unknown): HomeSection[] {
  const known = new Set(HOME_SECTIONS.map((section) => section.id));
  const kept = (Array.isArray(saved) ? saved : []).filter(
    (section, at, all): section is HomeSection =>
      known.has(section?.id) && all.findIndex((other) => other?.id === section.id) === at,
  );
  const result: HomeSection[] = kept.map(({ id, hidden, wide }) => ({ id, ...(hidden ? { hidden } : {}), ...(wide ? { wide } : {}) }));
  HOME_SECTIONS.forEach((section, at) => {
    if (result.some((other) => other.id === section.id)) return;
    const after = at > 0 ? result.findIndex((other) => other.id === HOME_SECTIONS[at - 1].id) : -1;
    result.splice(after + 1, 0, { ...section });
  });
  return result;
}

/** `id` taken out and put back before `before`, or last without one. */
export function movedSection(sections: HomeSection[], id: HomeSectionId, before?: HomeSectionId): HomeSection[] {
  const moving = sections.find((section) => section.id === id);
  if (!moving || id === before) return sections;
  const rest = sections.filter((section) => section.id !== id);
  const at = before ? rest.findIndex((section) => section.id === before) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, moving);
  return rest;
}

/** Where reading or playing stopped, as the viewers keep it: newest last in each. */
export interface ReadingStores {
  book: Record<string, { chapter: number; at: number }>;
  comic: Record<string, number>;
  pdf: Record<string, number>;
  /** Films and songs, in seconds. */
  timed: Record<string, number>;
}

export interface ReadingPlace {
  path: string;
  /** Where it stopped, in words. */
  where: string;
}

/** The kept places, newest of each kind first, taking turns between the kinds. */
export function readingPlaces(stores: ReadingStores, clock: (seconds: number) => string, most = 8): ReadingPlace[] {
  const lists: ReadingPlace[][] = [
    Object.entries(stores.book).map(([path, place]) => ({
      path,
      where: `Chapter ${place.chapter + 1}${place.at > 0 ? ` · ${Math.round(place.at * 100)}%` : ""}`,
    })),
    Object.entries(stores.comic).map(([path, page]) => ({ path, where: `Page ${page + 1}` })),
    Object.entries(stores.pdf).map(([path, page]) => ({ path, where: `Page ${page + 1}` })),
    Object.entries(stores.timed).map(([path, seconds]) => ({ path, where: `At ${clock(seconds)}` })),
  ].map((list) => list.reverse());
  const result: ReadingPlace[] = [];
  const seen = new Set<string>();
  for (let turn = 0; result.length < most && lists.some((list) => turn < list.length); turn++) {
    for (const list of lists) {
      const place = list[turn];
      if (!place || seen.has(place.path.toLowerCase()) || result.length >= most) continue;
      seen.add(place.path.toLowerCase());
      result.push(place);
    }
  }
  return result;
}

/** Milliseconds at the start of the day `now` is in, by the PC's clock. */
export function startOfDay(now: number) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

const DAY = 86_400_000;

/** A drive's free space, one sample a day, oldest first: the day's start and the free bytes. */
export type SpaceLog = [day: number, free: number][];

/** The log with today's free space in, one sample a day, for the last `most` days. */
export function loggedSpace(log: SpaceLog, free: number, now: number, most = 90): SpaceLog {
  const day = startOfDay(now);
  const kept = log.filter(([at]) => at !== day && at > day - most * DAY);
  return [...kept, [day, free] as [number, number]].sort((a, b) => a[0] - b[0]);
}

/**
 * How many days until a drive is full at the pace of the last month, or nothing when it isn't
 * filling up, would take more than two years, or the log is too short to tell.
 */
export function daysToFull(log: SpaceLog, now: number): number | undefined {
  const recent = log.filter(([day]) => day > now - 31 * DAY);
  if (recent.length < 4 || recent[recent.length - 1][0] - recent[0][0] < 7 * DAY) return undefined;
  // The straight line that fits the samples best, in bytes a day.
  const meanDay = recent.reduce((sum, [day]) => sum + day, 0) / recent.length;
  const meanFree = recent.reduce((sum, [, free]) => sum + free, 0) / recent.length;
  const over = recent.reduce((sum, [day, free]) => sum + (day - meanDay) * (free - meanFree), 0);
  const under = recent.reduce((sum, [day]) => sum + (day - meanDay) ** 2, 0);
  const perDay = (over / under) * DAY;
  if (!(perDay < 0)) return undefined;
  const days = recent[recent.length - 1][1] / -perDay;
  return days < 730 ? days : undefined;
}

export function fullText(days: number) {
  if (days < 14) {
    const whole = Math.max(1, Math.round(days));
    return `full in about ${whole} ${whole === 1 ? "day" : "days"}`;
  }
  if (days < 60) return `full in about ${Math.round(days / 7)} weeks`;
  return `full in about ${Math.round(days / 30.4)} months`;
}
