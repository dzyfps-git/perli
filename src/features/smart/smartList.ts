import type { SearchScope } from "../../api";
import type { FilterForm } from "../filelist/filter";

/**
 * A saved look at a folder: what to search it for, how far, and what to filter by. Opening one
 * only shows files. It never moves or changes any.
 */
export interface SmartFolder {
  name: string;
  folder: string;
  /** Empty for a plain folder with a filter on it. */
  query: string;
  scope: SearchScope;
  filter: FilterForm;
}

const SCOPES: SearchScope[] = ["below", "folder", "drive", "drives"];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The usable ones of what was saved, since storage can hold anything. `blank` is a filter that asks for nothing. */
export function cleanSmart(value: unknown, blank: FilterForm): SmartFolder[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SmartFolder[] => {
    if (typeof item?.name !== "string" || typeof item.folder !== "string") return [];
    const filter = { ...blank, ...(item.filter && typeof item.filter === "object" ? item.filter : {}) };
    return [
      {
        name: item.name,
        folder: item.folder,
        query: typeof item.query === "string" ? item.query : "",
        scope: SCOPES.includes(item.scope) ? item.scope : "below",
        filter: { ...filter, tags: Array.isArray(filter.tags) ? filter.tags.filter(Number.isInteger) : [] },
      },
    ];
  });
}

/** `list` with `smart` in it. One of the same name, in any case, is replaced where it stands. */
export function withSmart(list: SmartFolder[], smart: SmartFolder) {
  const at = list.findIndex((other) => same(other.name, smart.name));
  return at < 0 ? [...list, smart] : list.map((other, index) => (index === at ? smart : other));
}

export const withoutSmart = (list: SmartFolder[], name: string) => list.filter((other) => !same(other.name, name));

/** A new name for the one called `name`. A name already taken by another leaves the list alone. */
export function renamedSmart(list: SmartFolder[], name: string, next: string) {
  if (list.some((other) => same(other.name, next) && !same(other.name, name))) return list;
  return list.map((other) => (same(other.name, name) ? { ...other, name: next } : other));
}

/** True when `smart` is what a view shows now. */
export const showsSmart = (
  smart: SmartFolder,
  shown: { folder: string | undefined; query: string; scope: SearchScope; filter: FilterForm },
) =>
  !!shown.folder &&
  same(smart.folder, shown.folder) &&
  smart.query === shown.query &&
  (!smart.query || smart.scope === shown.scope) &&
  JSON.stringify(smart.filter) === JSON.stringify(shown.filter);
