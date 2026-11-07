import type { Filter } from "../../api";

/** A filter as the user typed it, so it reads the same when they come back to it. */
export interface FilterForm {
  name: string;
  /** Such as `jpg, .png`. */
  types: string;
  kinds: Filter["kinds"];
  /** Such as `10 MB`. */
  minSize: string;
  maxSize: string;
  /** `YYYY-MM-DD`, as a date input gives it. */
  from: string;
  to: string;
  /** Tag ids. */
  tags: number[];
}

export const NO_FILTER: FilterForm = {
  name: "",
  types: "",
  kinds: "all",
  minSize: "",
  maxSize: "",
  from: "",
  to: "",
  tags: [],
};

const SIZE_TEXT = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i;
const SIZE_UNITS = "kmgt";

/** Bytes, or undefined if the text is no size. No text is no limit. */
export function parseSize(text: string): number | null | undefined {
  if (!text.trim()) return null;
  const found = text.trim().match(SIZE_TEXT);
  if (!found) return undefined;
  const power = SIZE_UNITS.indexOf(found[2].toLowerCase()) + 1;
  // Past this, a number stops being a whole one that Rust can read.
  return Math.min(Math.round(Number(found[1]) * 1024 ** (found[2] ? power : 0)), Number.MAX_SAFE_INTEGER);
}

const dayTime = (day: string, time: string) => (day ? new Date(`${day}T${time}`).getTime() : null);

/** Sizes must be good, which `sizesAreGood` tells. Dates cover all of their local day. */
export const toFilter = (form: FilterForm): Filter => ({
  name: form.name.trim(),
  extensions: form.types
    .split(/[\s,;]+/)
    .map((text) => text.replace(/^\*?\./, "").toLowerCase())
    .filter(Boolean),
  kinds: form.kinds,
  minSize: parseSize(form.minSize) ?? null,
  maxSize: parseSize(form.maxSize) ?? null,
  modifiedFrom: dayTime(form.from, "00:00:00.000"),
  modifiedTo: dayTime(form.to, "23:59:59.999"),
  tags: form.tags,
});

export const sizesAreGood = (form: FilterForm) =>
  parseSize(form.minSize) !== undefined && parseSize(form.maxSize) !== undefined;

export const filterActive = (form: FilterForm) =>
  JSON.stringify(toFilter(form)) !== JSON.stringify(toFilter(NO_FILTER));
