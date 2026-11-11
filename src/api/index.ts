// The only place the UI talks to Rust.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export { getVersion as appVersion } from "@tauri-apps/api/app";

export interface Opened {
  /** Names this folder's rows in later `fetchRows` calls. */
  request: number;
  /** The resolved full path. */
  path: string;
  count: number;
  /** Hidden entries in the folder, shown or not. */
  hiddenCount: number;
  loadMs: number;
  /** Rows to select straight away, when this is a new order of the same folder. */
  selected?: number[];
}

export interface Row {
  name: string;
  size: number;
  /** Milliseconds since 1970. */
  modified: number;
  /** Milliseconds since 1970. */
  created: number;
  isDir: boolean;
  isHidden: boolean;
  /** Its content is in the cloud, so opening it fetches it. */
  isCloud: boolean;
  /** The user asked to always keep it on this device. */
  isPinned: boolean;
  /** A folder Windows gives an icon of its own. */
  isCustom: boolean;
  /** Where a deleted item came from, or where a search found the row. Otherwise empty. */
  location: string;
  /** Ids of its tags. */
  tags: number[];
}

export interface Tag {
  id: number;
  name: string;
  /** Which of the `--tag-` colors. */
  color: number;
}

export type SortKey = "name" | "modified" | "created" | "type" | "size" | "location";

export interface Sort {
  /** `found` is the order a search found its rows in, which no column stands for. */
  key: SortKey | "found" | "tags";
  descending: boolean;
}

export type Grouping = "foldersFirst" | "filesFirst" | "mixed";

/** Conditions a view's rows must all meet. */
export interface Filter {
  /** Part of the name, in any case. */
  name: string;
  /** In lowercase with no dots. Any one of them will do. */
  extensions: string[];
  kinds: "all" | "files" | "folders";
  minSize: number | null;
  maxSize: number | null;
  /** Milliseconds since 1970. */
  modifiedFrom: number | null;
  /** Milliseconds since 1970. */
  modifiedTo: number | null;
  /** A row must carry all of these. */
  tags: number[];
}

/** Which rows a view shows and in what order. */
export interface Order extends Sort {
  group: Grouping;
  showHidden: boolean;
  filter: Filter;
}

export interface Start {
  /** The folder from the command line. It replaces the saved session for this run. */
  folder: string | null;
  /** Names to select in `folder`. */
  select: string[];
  session: string | null;
  home: string | null;
}

export interface DriveSpace {
  free: number;
  total: number;
}

export interface Places {
  folders: { kind: string; path: string }[];
  drives: { name: string; path: string; network: boolean }[];
  /** Folders a sync app keeps, such as OneDrive. */
  clouds: { name: string; path: string }[];
}

/** Rows of one snapshot. */
/** A file or folder from Windows' list of recently opened ones. */
export interface Recent {
  name: string;
  path: string;
  isDir: boolean;
}

/** A newer release, found by `checkUpdate`. */
export interface UpdateOffer {
  version: string;
  notes: string | null;
}

export interface Selection {
  view: number;
  request: number;
  rows: number[];
}

/** What the UI can ask of the file engine. Folders are paths, and files are always rows. */
export type Task =
  | { kind: "copy" | "move"; selection: Selection; folder: string }
  | { kind: "rename"; selection: Selection; name: string }
  | { kind: "renameAll"; selection: Selection; names: string[] }
  | { kind: "new"; folder: string; directory: boolean }
  | { kind: "template"; folder: string; extension: string }
  | { kind: "ownTemplate"; folder: string; name: string }
  | { kind: "saveTemplate" | "zip"; selection: Selection }
  | { kind: "unzip"; selection: Selection; ownFolder: boolean; only?: string }
  | { kind: "paste"; folder: string }
  | { kind: "drop"; folder: string; action?: DropAction }
  | { kind: "recycle" | "delete" | "restore" | "purge"; selection: Selection }
  | { kind: "empty" };

export interface Progress {
  bytes: number;
  totalBytes: number;
  items: number;
  totalItems: number;
  current: string;
}

export type Answer = "replace" | "keepBoth" | "merge" | "skip" | "retry" | "elevate" | "permanent" | "cancel";

export interface Facts {
  size: number;
  /** FILETIME ticks. */
  modified: number;
  folder: boolean;
}

export type Question =
  | { kind: "conflict"; name: string; source: Facts; target: Facts; choices: Answer[] }
  | { kind: "problem"; path: string; message: string; choices: Answer[] }
  | { kind: "noBin"; path: string; choices: Answer[] };

export type JobEvent = { id: number } & (
  | { kind: "started"; title: string; origin: number | null; newItem: boolean; recycle: boolean }
  | ({ kind: "progress" } & Progress)
  | { kind: "asked"; question: Question }
  | ({
      kind: "finished";
      /** Folders whose contents changed. */
      touched: string[];
      /** Full paths of what the job made. */
      created: string[];
      /** Sources a move left alone because they changed while it ran. */
      kept: string[];
      cancelled: boolean;
      /** The undo step this job added. */
      step: number | null;
    } & Undoable)
);

/** What Undo and Redo can do now. */
export interface Undoable {
  /** The step Undo would reverse next. */
  latestStep: number | null;
  redo: boolean;
}

export interface Measured {
  items: number;
  bytes: number;
}

/** An app that can open a file type. */
export interface App {
  id: string;
  name: string;
  /** Windows suggests it for the type. The rest only say they can open it. */
  recommended: boolean;
  /** A file whose picture stands for the app. */
  icon: string | null;
}

/** How many of the items have something. */
export type Share = "all" | "none" | "some";

/** What the Properties sheet starts from. Times are milliseconds since 1970, of the first item. */
export interface ItemFacts {
  paths: string[];
  folders: number;
  files: number;
  /** A drive itself. */
  isRoot: boolean;
  size: number;
  modified: number | null;
  created: number | null;
  accessed: number | null;
  /** Among the files only. */
  readOnly: Share;
  hidden: Share;
  kind: string | null;
  defaultApp: string | null;
  /** Reading it would download it. */
  onlineOnly: boolean;
}

/** Free drive letters, Z first, and the network drives mapped now. */
export interface DriveLetters {
  free: string[];
  mapped: { letter: string; remote: string }[];
}

export interface SendTarget {
  name: string;
  path: string;
  /** A drive takes a plain copy. The rest are Windows' own targets, such as a zip. */
  isDrive: boolean;
}

/** A file type Windows offers under New. */
export interface NewType {
  extension: string;
  name: string;
}

/** Files being dragged over the window, in physical pixels inside it. */
export type FileDrag =
  /** A drag came in over the window: how many things, and the first one's name. */
  | { kind: "enter"; count: number; name: string; folder: boolean }
  | { kind: "over"; x: number; y: number }
  /** `right` means the right button dragged, so the user gets to pick what happens. */
  | { kind: "drop"; x: number; y: number; right: boolean }
  | { kind: "leave" };

/** What a drop can do, when the user picks it from a menu. */
export type DropAction = "move" | "copy" | "link";

/** What a view wants from its search: a new query, the same one again, or the rows found so far. */
export type SearchStep = "start" | "again" | "grown";

/** A picture of a file, with plain alpha. */
export interface Thumb {
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/** What a Windows menu or Properties window is for. */
export type ShellTarget = { kind: "rows"; selection: Selection } | { kind: "folder"; path: string };

const HEADER_BYTES = 34;
const TAG_BYTES = 4;
const THUMB_HEADER_BYTES = 8;
const FLAG_FOLDER = 1;
const FLAG_HIDDEN = 2;
const FLAG_CLOUD = 4;
const FLAG_PINNED = 8;
const FLAG_CUSTOM = 16;
const UINT32_RANGE = 2 ** 32;
const FILETIME_TICKS_PER_MS = 10_000;
const FILETIME_TO_UNIX_MS = 11_644_473_600_000;

const names = new TextDecoder("utf-16le");
/** Most rows have no tags, and they can all share this. */
const NO_TAGS: number[] = [];

export const startState = () => invoke<Start>("start_state");

export const saveSession = (text: string) => invoke<void>("save_session", { text });

export const listPlaces = () => invoke<Places>("list_places");

export const checkUpdate = () => invoke<UpdateOffer | null>("check_update");

/** Ends Perli once the installer starts. */
export const installUpdate = () => invoke<void>("install_update");

export const recentFiles = (limit: number) => invoke<Recent[]>("recent_files", { limit });

/** The first lines of a row that reads as text, or null. */
export const peekText = (view: number, request: number, row: number) =>
  invoke<string | null>("peek_text", { view, request, row });

export const driveSpace = (path: string) => invoke<DriveSpace>("drive_space", { path });

export const mapDrive = () => invoke<void>("map_drive");

export const disconnectDrive = () => invoke<void>("disconnect_drive");

export const driveLetters = () => invoke<DriveLetters>("drive_letters");

/** Windows asks for a name and password itself when the server wants them. */
export const mapNetworkDrive = (letter: string, remote: string, remember: boolean) =>
  invoke<void>("map_network_drive", { letter, remote, remember });

export const unmapDrive = (letter: string) => invoke<void>("unmap_drive", { letter });

/** Positions in `names` of the ones that fit `query`, best first. */
export const rankNames = (query: string, names: string[]) => invoke<number[]>("rank_names", { query, names });

export const isDefaultApp = () => invoke<boolean>("is_default_app");

export const setDefaultApp = (on: boolean) => invoke<void>("set_default_app", { on });

export const typeNames = (extensions: string[]) =>
  invoke<Record<string, string>>("type_names", { extensions });

/** Turns `~` and `%NAME%` in typed text into a real path. */
export const expandPath = (text: string) => invoke<string>("expand_path", { text });

export const isFile = (path: string) => invoke<boolean>("is_file", { path });

/** `shown` is the request of the folder on screen, whose rows must outlive this open. */
export const openFolder = (view: number, request: number, shown: number, path: string, order: Order) =>
  invoke<Opened>("open_folder", { view, request, shown, path, order });

/** Puts the shown folder in a new order as a new snapshot. `selected` rows follow their files. */
export const arrangeView = (
  view: number,
  request: number,
  shown: number,
  order: Order,
  selected: number[],
) =>
  invoke<{ count: number; selected: number[] }>("arrange_view", { view, request, shown, order, selected });

/**
 * Reads the shown folder again. `select` names the new selection, or `selected` rows keep theirs.
 * With `search`, the rows are what a search under the folder has found.
 */
export const reloadView = (
  view: number,
  request: number,
  shown: number,
  path: string,
  order: Order,
  selected: number[],
  select: string[],
  search: { step: SearchStep; query: string } | null,
) =>
  invoke<{ count: number; hiddenCount: number; selected: number[] }>("reload_view", {
    view,
    request,
    shown,
    path,
    order,
    selected,
    select,
    search,
  });

/** `waiting` means it has rows to spare and goes on once the user scrolls closer to them. */
export type SearchWalk = "going" | "waiting" | "done";

/** More of a view's search is ready. */
export const onSearchGrew = (handler: (view: number, walk: SearchWalk) => void) =>
  listen<{ view: number; walk: SearchWalk }>("search-grew", (event) =>
    handler(event.payload.view, event.payload.walk),
  );

/** `origin` is the view that asked, which selects what the job makes. */
export const startJob = (task: Task, origin?: number) => invoke<void>("start_job", { task, origin });

/** With `step`, this only undoes that step, and only while it is the newest. */
export const undoJob = (origin?: number, step?: number) => invoke<void>("undo_job", { origin, step });
export const redoJob = (origin?: number) => invoke<void>("redo_job", { origin });
export const undoState = () => invoke<Undoable>("undo_state");
/** With jobs running, this keeps the window open past the close limit. True if it did. */
/** `request` is the number `onCloseAsked` gave, so a late answer can't hold a newer request. */
export const holdClose = (request: number) => invoke<boolean>("hold_close", { request });
export const onCloseAsked = (handler: (request: number) => void) =>
  listen<number>("close-asked", (event) => handler(event.payload));
export const cancelJobsAndClose = () => invoke<void>("cancel_jobs_and_close");
export const pauseJob = (id: number) => invoke<void>("pause_job", { id });
export const resumeJob = (id: number) => invoke<void>("resume_job", { id });
export const cancelJob = (id: number) => invoke<void>("cancel_job", { id });

/** `all` uses the same answer for every later case of this kind. */
export const answerJob = (id: number, answer: Answer, all: boolean) =>
  invoke<void>("answer_job", { id, reply: { answer, all } });

export const onJobEvent = (handler: (event: JobEvent) => void) =>
  listen<JobEvent>("job", (event) => handler(event.payload));

/** What is wrong with each of `names`, which line up with the selected rows. */
export const checkRenames = (selection: Selection, names: string[]) =>
  invoke<(string | null)[]>("check_renames", { selection, names });

/** The selected rows' names, and whether each is a folder. */
export const rowFacts = (selection: Selection) => invoke<[string, boolean][]>("row_facts", { selection });

export const measureSelection = (selection: Selection) => invoke<Measured>("measure_selection", { selection });

export const binSummary = () => invoke<Measured>("bin_summary");

export const setClipboard = (selection: Selection, cut: boolean) =>
  invoke<{ names: string[]; sequence: number }>("set_clipboard", { selection, cut });

export const cancelCut = (sequence: number) => invoke<void>("cancel_cut", { sequence });

export const clipboardSequence = () => invoke<number>("clipboard_sequence");

/** True if a paste would make something: files, an image or text. */
export const clipboardCanPaste = () => invoke<boolean>("clipboard_can_paste");

/** The first row at or after `start` whose name starts with `prefix`, wrapping around. */
export const findRow = (view: number, request: number, prefix: string, start: number) =>
  invoke<number | null>("find_row", { view, request, prefix, start });

export const listTags = () => invoke<Tag[]>("list_tags");

export const createTag = (name: string, color: number) => invoke<Tag>("create_tag", { name, color });

export const editTag = (id: number, name: string, color: number) => invoke<void>("edit_tag", { id, name, color });

export const deleteTag = (id: number) => invoke<void>("delete_tag", { id });

/** Puts `tag` on the selected rows, or takes it off. */
export const setTag = (selection: Selection, tag: number, on: boolean) =>
  invoke<void>("set_tag", { selection, tag, on });

/** The tags all the selected rows have. */
export const commonTags = (selection: Selection) => invoke<number[]>("common_tags", { selection });

/** The rows whose names fit `pattern`, such as `*.jpg;*.png`. */
export const rowsMatching = (view: number, request: number, pattern: string) =>
  invoke<number[]>("rows_matching", { view, request, pattern });

/** The bytes of the selected files, from the listing alone. Folders count as nothing. */
export const selectionSize = (selection: Selection) => invoke<number>("selection_size", { selection });

/** The accent color picked in Windows, as `#rrggbb`. */
export const windowsAccent = () => invoke<string | null>("windows_accent");

/** Starts adding up the folders in `path`. `onSizesGrew` says when totals come in. */
export const scanSizes = (view: number, path: string) => invoke<void>("scan_sizes", { view, path });

/** Stops every scan and forgets the totals. */
export const stopSizes = () => invoke<void>("stop_sizes");

export const onSizesGrew = (handler: (view: number) => void) =>
  listen<number>("sizes-grew", (event) => handler(event.payload));

export const closeView = (view: number) => invoke<void>("close_view", { view });

/** Physical pixels, relative to the window. */
export const placeSnapArea = (x: number, y: number, width: number, height: number) =>
  invoke<void>("place_snap_area", { x, y, width, height });

export const openFile = (path: string) => invoke<void>("open_file", { path });

export const clipboardText = () => invoke<string>("clipboard_text");

export const appsFor = (selection: Selection) => invoke<App[]>("apps_for", { selection });

export const openWith = (selection: Selection, app: string) => invoke<void>("open_with", { selection, app });

export const chooseApp = (selection: Selection) => invoke<void>("choose_app", { selection });

/** Every app that can open files of `paths`' type. Empty when they don't share one. */
export const appsForPaths = (paths: string[]) => invoke<App[]>("apps_for_paths", { paths });

export const openPathsWith = (paths: string[], app: string) => invoke<void>("open_paths_with", { paths, app });

export const openPathsWithExe = (paths: string[], exe: string) =>
  invoke<void>("open_paths_with_exe", { paths, exe });

/** Windows' file picker for an app. `null` when the user backs out. */
export const browseApp = () => invoke<string | null>("browse_app");

/** Windows' own window for picking an app, the only thing that may set a default. */
export const chooseAppFor = (path: string) => invoke<void>("choose_app_for", { path });

export const itemFacts = (target: ShellTarget) => invoke<ItemFacts>("item_facts", { target });

/** Only for the items themselves, never what is inside a folder. */
export const setAttributes = (paths: string[], change: { readOnly?: boolean; hidden?: boolean }) =>
  invoke<void>("set_attributes", { paths, ...change });

export const measurePaths = (paths: string[]) => invoke<Measured>("measure_paths", { paths });

export const pathProperties = (path: string) =>
  invoke<[group: string, label: string, value: string][]>("path_properties", { path });

export const pathUsers = (paths: string[]) => invoke<string[]>("path_users", { paths });

export const sendTargets = () => invoke<SendTarget[]>("send_targets");

export const sendTo = (selection: Selection, target: string) => invoke<void>("send_to", { selection, target });

/** `x` and `y` are physical pixels inside the window. Gives the verb the UI should run itself. */
export const showShellMenu = (target: ShellTarget, x: number, y: number) =>
  invoke<string | null>("show_shell_menu", { target, x, y });

/** One item of Windows' own menu. `icon` is a picture in the thumbnail format. */
export interface ShellEntry {
  id: number | null;
  label: string;
  icon: number[] | null;
  divider: boolean;
  disabled: boolean;
  checked: boolean;
  items: ShellEntry[];
}

/** What Windows and other apps add to a right click, for Perli's own menu to show. */
export const shellMenuItems = (target: ShellTarget) => invoke<ShellEntry[]>("shell_menu_items", { target });

/** Runs an item of the list `shellMenuItems` gave last. `x` and `y` are as for `showShellMenu`. */
export const runShellItem = (id: number, x: number, y: number) => invoke<void>("run_shell_item", { id, x, y });

export const entryPicture = (icon: number[]) => decodeThumb(new Uint8Array(icon).buffer);

/** `x` and `y` are physical pixels inside the window, and pick the monitor it opens on. */
export const showProperties = (target: ShellTarget, x: number, y: number) =>
  invoke<void>("show_properties", { target, x, y });

export const openTerminal = (path: string) => invoke<void>("open_terminal", { path });

export const newTypes = () => invoke<NewType[]>("new_types");

/** The names of the user's own templates, A to Z. */
export const ownTemplates = () => invoke<string[]>("own_templates");

export const templatesFolder = () => invoke<string>("templates_folder");

/** The names of the folders right inside `path`, in Explorer's order. */
export const subfolders = (path: string, showHidden: boolean) => invoke<string[]>("subfolders", { path, showHidden });

/** The apps holding the selected files. */
export const fileUsers = (selection: Selection) => invoke<string[]>("file_users", { selection });

/** Something outside Perli changed the folder this view shows. */
export const onFolderChanged = (handler: (view: number) => void) =>
  listen<number>("folder-changed", (event) => handler(event.payload));

/** A folder another start of Perli was asked to open, with the names to select in it. */
export interface OpenAsk {
  folder: string | null;
  select: string[];
}

export const onOpenAsked = (handler: (ask: OpenAsk) => void) =>
  listen<OpenAsk>("open-asked", (event) => handler(event.payload));

/** Brings the window to the front. */
export const comeForward = () => invoke<void>("come_forward");

/** Starts one more Perli with a window of its own. */
export const openWindow = (folder: string, select: string[]) => invoke<void>("open_window", { folder, select });

export const onDrivesChanged = (handler: () => void) => listen("drives-changed", handler);

export const onFileDrag = (handler: (event: FileDrag) => void) =>
  listen<FileDrag>("file-drag", (event) => handler(event.payload));

/** Names the folder under a drag, which decides the cursor. */
export const setDropTarget = (folder: string | null) => invoke<void>("set_drop_target", { folder });

/** What the last drop can do on `folder`, for the user to pick from. */
export const dropChoices = (folder: string) => invoke<DropAction[]>("drop_choices", { folder });

/** Starts dragging the selected files to any app. Ends when the user lets go. */
export const startDrag = (selection: Selection) => invoke<void>("start_drag", { selection });

export async function fetchRows(
  view: number,
  request: number,
  start: number,
  count: number,
): Promise<Row[]> {
  return decodeRows(await invoke<ArrayBuffer>("rows", { view, request, start, count }));
}

/** What the quick preview shows. `next` is where the following piece of a text starts. */
export type Preview =
  | { kind: "text"; text: string; next: number | null }
  | { kind: "markdown"; html: string }
  | { kind: "archive"; entries: ArchiveEntry[]; more: boolean }
  | { kind: "comic"; pages: string[] }
  | { kind: "book"; title: string; chapters: string[]; contents: BookHeading[] }
  | { kind: "model" }
  | { kind: "song" }
  | { kind: "audio" }
  | { kind: "picture" };

/** A line of a book's own table of contents, and which chapter it opens. */
export interface BookHeading {
  title: string;
  chapter: number;
  depth: number;
}

/** One file or folder inside a ZIP. `modified` is as the archive wrote it. */
export interface ArchiveEntry {
  name: string;
  size: number;
  folder: boolean;
  modified: string | null;
}

export const previewRow = (view: number, request: number, row: number, offset = 0) =>
  invoke<Preview>("preview_row", { view, request, row, offset });

/** Label and value pairs, in Windows' own order. */
export const rowProperties = (view: number, request: number, row: number) =>
  invoke<[group: string, label: string, value: string][]>("row_properties", { view, request, row });

export type HashKind = "md5" | "sha1" | "sha256" | "sha512";

/** `null` once a newer checksum took its place. */
export const checksum = (view: number, request: number, row: number, algorithm: HashKind) =>
  invoke<string | null>("checksum", { view, request, row, algorithm });

export const pathChecksum = (path: string, algorithm: HashKind) =>
  invoke<string | null>("path_checksum", { path, algorithm });

/** Web and mail links only. */
export const openLink = (url: string) => invoke<void>("open_link", { url });

/** A picture of a row, `edge` device pixels on its longest side. */
export const fetchBigPicture = (view: number, request: number, row: number, edge: number) =>
  invoke<ArrayBuffer>("big_picture", { view, request, row, edge }).then(decodeThumb);

/** A picture's own width and height, or null for a format only the shell can draw. */
export const pictureSize = (view: number, request: number, row: number) =>
  invoke<[number, number] | null>("picture_size", { view, request, row });

/** A comic page or a book's picture, by its name inside the archive. */
export const fetchArchivePicture = (view: number, request: number, row: number, entry: string, edge: number) =>
  invoke<ArrayBuffer>("archive_picture", { view, request, row, entry, edge }).then(decodeThumb);

/** The start of a text file inside a ZIP, or null if it is not text. */
export const archiveText = (view: number, request: number, row: number, entry: string) =>
  invoke<string | null>("archive_text", { view, request, row, entry });

/** One chapter of a book as safe HTML, by its name inside the archive. */
export const bookChapter = (view: number, request: number, row: number, entry: string) =>
  invoke<string>("book_chapter", { view, request, row, entry });

/** A 3D model's bytes or, with `part`, those of a file beside it that the model points to. */
export const modelFile = (view: number, request: number, row: number, part?: string) =>
  invoke<ArrayBuffer>("model_file", { view, request, row, part: part ?? null });

/** A MIDI file's name, instruments and notes. Notes are start and length in seconds, key, channel. */
export interface SongInfo {
  title: string | null;
  /** General MIDI programs in the order they first play. 128 is the drums. */
  instruments: number[];
  notes: [number, number, number, number][];
}

export const songInfo = (view: number, request: number, row: number) =>
  invoke<SongInfo>("song_info", { view, request, row });

export interface Tags {
  title: string | null;
  artist: string | null;
  album: string | null;
}

/** Opens one sound file to the window, giving its path to stream and its tags. */
export const openAudio = (view: number, request: number, row: number) =>
  invoke<[string, Tags]>("open_audio", { view, request, row });

/** A song's own album cover, or null if it has none. */
export const fetchCover = (view: number, request: number, row: number, edge: number) =>
  invoke<ArrayBuffer>("cover", { view, request, row, edge }).then(decodeThumb);

/** A MIDI file played through the bundled SoundFont, as one WAV. */
export const songAudio = (view: number, request: number, row: number) =>
  invoke<ArrayBuffer>("song_audio", { view, request, row });

/** A picture on this PC that a Markdown file points to. */
export const fetchPictureFile = (path: string, edge: number) =>
  invoke<ArrayBuffer>("picture_file", { path, edge }).then(decodeThumb);

/** Decodes the format written by `read` in `src-tauri/src/thumbs.rs`. */
export async function fetchThumb(view: number, request: number, row: number): Promise<Thumb | null> {
  return decodeThumb(await invoke<ArrayBuffer>("thumbnail", { view, request, row }));
}

function decodeThumb(buffer: ArrayBuffer): Thumb | null {
  if (buffer.byteLength === 0) return null;
  const head = new DataView(buffer);
  return {
    width: head.getUint32(0, true),
    height: head.getUint32(4, true),
    pixels: new Uint8ClampedArray(buffer, THUMB_HEADER_BYTES),
  };
}

/** Decodes the format written by `encode_rows` in `src-tauri/src/folder.rs`. */
function decodeRows(buffer: ArrayBuffer): Row[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const rows = new Array<Row>(view.getUint32(0, true));

  let offset = 4;
  for (let i = 0; i < rows.length; i++) {
    const nameBytes = view.getUint32(offset, true);
    const locationBytes = view.getUint32(offset + 29, true);
    const nameStart = offset + HEADER_BYTES;
    const locationStart = nameStart + nameBytes;
    const flags = view.getUint8(offset + 28);
    const tagCount = view.getUint8(offset + 33);
    const tagStart = locationStart + locationBytes;
    rows[i] = {
      name: names.decode(bytes.subarray(nameStart, locationStart)),
      location: names.decode(bytes.subarray(locationStart, tagStart)),
      tags: tagCount
        ? Array.from({ length: tagCount }, (_, tag) => view.getUint32(tagStart + tag * TAG_BYTES, true))
        : NO_TAGS,
      size: readUint64(view, offset + 4),
      modified: readFiletime(view, offset + 12),
      created: readFiletime(view, offset + 20),
      isDir: (flags & FLAG_FOLDER) !== 0,
      isHidden: (flags & FLAG_HIDDEN) !== 0,
      isCloud: (flags & FLAG_CLOUD) !== 0,
      isPinned: (flags & FLAG_PINNED) !== 0,
      isCustom: (flags & FLAG_CUSTOM) !== 0,
    };
    offset = tagStart + tagCount * TAG_BYTES;
  }
  return rows;
}

/** Milliseconds since 1970. */
export const filetimeToMs = (ticks: number) => ticks / FILETIME_TICKS_PER_MS - FILETIME_TO_UNIX_MS;

function readFiletime(view: DataView, offset: number) {
  return filetimeToMs(readUint64(view, offset));
}

function readUint64(view: DataView, offset: number) {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * UINT32_RANGE;
}
