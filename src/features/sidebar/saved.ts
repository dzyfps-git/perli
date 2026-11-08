import { saved, stored } from "../filelist/prefs";
import { lookKey, moved, savedPaths, toggled, withLook, type Look, type Looks } from "./placeLists";

export type SectionId = "pinned" | "places" | "recent" | "cloud" | "drives";

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "pinned", label: "Pinned" },
  { id: "places", label: "Places" },
  { id: "recent", label: "Recent" },
  { id: "cloud", label: "Cloud" },
  { id: "drives", label: "Drives" },
];

const savedSections = (key: string) =>
  savedPaths(saved(key)).filter((id): id is SectionId => SECTIONS.some((section) => section.id === id));

export const [pinned, setPinned] = stored("pinned", savedPaths(saved("pinned")));
export const [bookmarks, setBookmarks] = stored("bookmarks", savedPaths(saved("bookmarks")));
export const [hiddenSections, setHiddenSections] = stored("hidden-sections", savedSections("hidden-sections"));
export const [foldedSections, setFoldedSections] = stored("folded-sections", savedSections("folded-sections"));
export const [bookmarksBar, setBookmarksBar] = stored("bookmarks-bar", saved("bookmarks-bar") !== false);
const [looks, setLooks] = stored<Looks>("folder-looks", (saved("folder-looks") as Looks | null) ?? {});

/** Changes whenever any folder's look does, so lists know to repaint. */
export const allLooks = looks;

export const lookOf = (path: string): Look | undefined => looks()[lookKey(path)];

export const setLook = (path: string, change: Look) => setLooks(withLook(looks(), path, change));

export const togglePinned = (path: string) => setPinned(toggled(pinned(), path));

export const movePinned = (path: string, step: -1 | 1) => setPinned(moved(pinned(), path, step));

export const toggleBookmark = (path: string) => setBookmarks(toggled(bookmarks(), path));

const flipped = (list: SectionId[], id: SectionId) =>
  list.includes(id) ? list.filter((section) => section !== id) : [...list, id];

export const toggleSection = (id: SectionId) => setHiddenSections(flipped(hiddenSections(), id));

export const toggleFolded = (id: SectionId) => setFoldedSections(flipped(foldedSections(), id));
