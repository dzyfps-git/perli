import type { GroupBy } from "../../api";
import type { Kind } from "./fileKinds";

/** What the list can gather rows under headers by, as menus offer it. Folder is for searches. */
export const GROUP_CHOICES: { by: GroupBy; label: string }[] = [
  { by: "none", label: "No groups" },
  { by: "date", label: "Date modified" },
  { by: "kind", label: "Kind" },
  { by: "size", label: "Size" },
  { by: "tag", label: "Tag" },
  { by: "folder", label: "Folder" },
];

/** The kind groups in order. Folders come before them, and files of no kind here after. */
export const KIND_GROUPS: { label: string; kinds: Kind[] }[] = [
  { label: "Pictures", kinds: ["picture", "vector", "design"] },
  { label: "Videos", kinds: ["video"] },
  { label: "Music", kinds: ["audio"] },
  { label: "Documents", kinds: ["pdf", "doc", "text", "sheet", "slides", "markdown", "book"] },
  { label: "Code", kinds: ["code", "web", "data", "script", "config"] },
  { label: "Archives", kinds: ["archive", "disk"] },
  { label: "Apps", kinds: ["app", "installer", "library"] },
];

const SIZE_LABELS: Record<string, string> = {
  folders: "Folders",
  gigantic: "Gigantic, over 4 GB",
  huge: "Huge, 1 to 4 GB",
  large: "Large, 128 MB to 1 GB",
  medium: "Medium, 1 to 128 MB",
  small: "Small, 16 KB to 1 MB",
  tiny: "Tiny, under 16 KB",
  empty: "Empty",
};

/**
 * Where each date group starts, newest first. A row goes in the first one it is not older than,
 * so a group that starts later than the one before it, such as this week on a Monday, stays empty.
 */
export function dateGroups(now: Date) {
  const [year, month, date] = [now.getFullYear(), now.getMonth(), now.getDate()];
  const day = (offset: number) => new Date(year, month, date + offset).getTime();
  // Weeks start on Monday, as the calendar does.
  const weekday = (now.getDay() + 6) % 7;
  return [
    { label: "Today", from: day(0) },
    { label: "Yesterday", from: day(-1) },
    { label: "Earlier this week", from: day(-weekday) },
    { label: "Last week", from: day(-weekday - 7) },
    { label: "Earlier this month", from: new Date(year, month, 1).getTime() },
    { label: "Last month", from: new Date(year, month - 1, 1).getTime() },
    { label: "Earlier this year", from: new Date(year, 0, 1).getTime() },
    { label: "Last year", from: new Date(year - 1, 0, 1).getTime() },
  ];
}

/** What a header says for a group's key. Tag names and folder paths come from elsewhere. */
export function groupLabel(
  by: GroupBy,
  key: string,
  now: Date,
  names: { tag: (id: number) => string | undefined; folder: (path: string) => string },
) {
  if (key === "folders") return "Folders";
  switch (by) {
    case "date":
      return dateGroups(now)[Number(key)]?.label ?? "A long time ago";
    case "kind":
      return KIND_GROUPS[Number(key)]?.label ?? "Other files";
    case "size":
      return SIZE_LABELS[key] ?? key;
    case "tag":
      return key === "none" ? "No tag" : (names.tag(Number(key)) ?? "A tag that is gone");
    case "folder":
      return names.folder(key);
    default:
      return key;
  }
}
