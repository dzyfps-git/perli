import { createSignal } from "solid-js";
import { listTags, type Tag } from "../../api";
import "./tags.css";

export const TAG_COLORS = ["Red", "Orange", "Yellow", "Green", "Teal", "Blue", "Purple", "Pink"];

const [known, setKnown] = createSignal<Tag[]>([]);

/** Every tag, A to Z. */
export const tags = known;

export const refreshTags = () => listTags().then(setKnown).catch(console.error);

export const tagColor = (color: number) => `var(--tag-${color})`;

/** For screen readers. Empty with no tags. */
export function tagNames(ids: number[]) {
  const names = ids.flatMap((id) => known().find((tag) => tag.id === id)?.name ?? []);
  return names.length > 0 ? `Tags: ${names.join(", ")}` : "";
}
