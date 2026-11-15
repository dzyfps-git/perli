/** The home page's parts, in the order and size the user gave them. */

export type HomeSectionId = "drives" | "reading" | "pinned" | "folders" | "today";

export interface HomeSection {
  id: HomeSectionId;
  hidden?: boolean;
  /** Takes the whole width rather than half. */
  wide?: boolean;
}

export const HOME_SECTIONS: HomeSection[] = [
  { id: "drives", wide: true },
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
