import type { Row } from "../../api";

/**
 * Whether a row read again, after its folder changed, is still the file on show: same place, size,
 * time and cloud state. Then the view stays, with whatever was done in it, such as a filled form.
 */
export const sameFile = (before: Row | undefined, after: Row | undefined, pathOf: (row: Row) => string) =>
  !!before &&
  !!after &&
  pathOf(before) === pathOf(after) &&
  before.size === after.size &&
  before.modified === after.modified &&
  before.isCloud === after.isCloud;
