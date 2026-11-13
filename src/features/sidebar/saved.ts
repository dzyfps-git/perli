import { NO_FILTER } from "../filelist/filter";
import { saved, stored } from "../filelist/prefs";
import { cleanSmart, type SmartFolder } from "../smart/smartList";
import { groupsOf, holds, lookKey, moved, savedPaths, toggled, withGroup, withLook, type Groups, type Look, type Looks } from "./placeLists";

export type SectionId = "pinned" | "places" | "smart" | "recent" | "tags" | "cloud" | "drives";

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "pinned", label: "Pinned" },
  { id: "places", label: "Places" },
  { id: "smart", label: "Smart folders" },
  { id: "recent", label: "Recent" },
  { id: "tags", label: "Tags" },
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
/** Off shows the sidebar as a slim rail of icons, which slides out when the pointer or a key reaches it. */
export const [sidebarOpen, setSidebarOpen] = stored("sidebar-open", saved("sidebar-open") === true);
const [looks, setLooks] = stored<Looks>("folder-looks", (saved("folder-looks") as Looks | null) ?? {});

/** Changes whenever any folder's look does, so lists know to repaint. */
export const allLooks = looks;

export const lookOf = (path: string): Look | undefined => looks()[lookKey(path)];

export const setLook = (path: string, change: Look) => setLooks(withLook(looks(), path, change));

export const togglePinned = (path: string) => setPinned(toggled(pinned(), path));

export const movePinned = (path: string, step: -1 | 1) => setPinned(moved(pinned(), path, step));

export const toggleBookmark = (path: string) => setBookmarks(toggled(bookmarks(), path));

export const [smartFolders, setSmartFolders] = stored<SmartFolder[]>("smart-folders", cleanSmart(saved("smart-folders"), NO_FILTER));

/** What a drop on the bookmarks bar lands on. It is no folder, so nothing moves. */
export const BOOKMARKS = "perli:bookmarks";

export const addBookmarks = (paths: string[]) =>
  setBookmarks(paths.reduce((list, path) => (holds(list, path) ? list : [...list, path]), bookmarks()));

const [groups, setGroups] = stored<Groups>("bookmark-groups", (saved("bookmark-groups") as Groups | null) ?? {});

export const groupOf = (path: string): string | undefined => groups()[lookKey(path)];

export const setGroup = (path: string, group: string | undefined) => setGroups(withGroup(groups(), path, group));

/** The groups that hold a bookmark, in bar order. */
export const bookmarkGroups = () => groupsOf(bookmarks(), groups());

const flipped = (list: SectionId[], id: SectionId) =>
  list.includes(id) ? list.filter((section) => section !== id) : [...list, id];

export const toggleSection = (id: SectionId) => setHiddenSections(flipped(hiddenSections(), id));

export const toggleFolded = (id: SectionId) => setFoldedSections(flipped(foldedSections(), id));
