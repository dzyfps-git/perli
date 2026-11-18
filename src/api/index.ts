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
  /** How many files the rows stand for, fewer than `count` when a file stands under two tags. */
  items: number;
  /** Hidden entries in the folder, shown or not. */
  hiddenCount: number;
  /** The rows under each header, in order. Empty when the rows are not grouped. */
  groups: Group[];
  /** The biggest size a row shows, which the size bars measure against. */
  largest: number;
  /** Files a search by tag couldn't reach, on a drive or computer that isn't here. */
  away: number;
  loadMs: number;
  /** Rows to select straight away, when this is a new order of the same folder. */
  selected?: number[];
  /** The archive this folder is in, when it is one inside an archive: the innermost as shown. */
  archive: string | null;
  /** The shown path of each archive on the way, the outermost first. */
  archives: string[];
  /** Something in that ZIP needs a password Perli doesn't have yet. */
  locked: boolean;
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
  /** Hidden and system both: one of Windows' own files. */
  isSystem: boolean;
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
/** The extra columns, read from each file's own properties. */
export type PropKey = "artist" | "album" | "length" | "taken" | "dimensions" | "packed";

export interface Sort {
  /** `found` is the order a search found its rows in, which no column stands for. */
  key: SortKey | PropKey | "found" | "tags";
  descending: boolean;
}

export type Grouping = "foldersFirst" | "filesFirst" | "mixed";

/** What rows gather under headers by. `folder` is where a search found each one. */
export type GroupBy = "none" | "date" | "kind" | "size" | "tag" | "folder" | "copies";

/** Rows under one header. */
export interface Group {
  /** A date edge's or kind's place, a size word, a tag's id, a folder's path, or "folders",
   *  "other", "older" or "none" for the rest. */
  key: string;
  start: number;
  /** The rows that show, none while folded. */
  count: number;
  total: number;
}

/** What a new order of the same rows tells the list. */
export interface Arranged {
  count: number;
  items: number;
  hiddenCount: number;
  groups: Group[];
  largest: number;
  away: number;
  selected: number[];
}

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
  /** Folders stay whatever `extensions` asks, so a picker can still go through them. */
  foldersStay?: boolean;
  /** Rows in the folder itself with these names, in lowercase, are left out, as a compare asks. */
  except?: string[];
}

/** Which rows a view shows and in what order. */
export interface Order extends Sort {
  group: Grouping;
  showHidden: boolean;
  /** Protected system files, which also need `showHidden`. */
  showSystem: boolean;
  filter: Filter;
  /** Folders whose rows show under them, by full path. */
  expanded?: string[];
  groupBy?: GroupBy;
  /** Where each date group starts, newest first, in milliseconds since 1970. */
  groupEdges?: number[];
  /** The extensions of each kind group, in order. */
  groupKinds?: string[][];
  /** Groups whose rows are out of sight, by key. */
  folded?: string[];
}

export interface Start {
  /** The folder from the command line. It replaces the saved session for this run. */
  folder: string | null;
  /** Names to select in `folder`. */
  select: string[];
  session: string | null;
  home: string | null;
  /** One more window, which keeps its place in its own session, not the first window's. */
  newWindow: boolean;
  /** A tab moved here from another window, as `parseMoved` reads it. */
  moved: string | null;
  /** The window keeps its tabs in a file of its own. False for a start on one folder, a detour. */
  keep: boolean;
}

export interface DriveSpace {
  free: number;
  total: number;
}

export interface Places {
  folders: { kind: string; path: string }[];
  drives: {
    name: string;
    path: string;
    network: boolean;
    removable: boolean;
    /** BitLocker keeps it encrypted. */
    encrypted: boolean;
    /** Encrypted and not unlocked yet. */
    locked: boolean;
  }[];
  /** Phones and the like, which have no drive letter. Explorer shows their files. */
  devices: { name: string; id: string }[];
  /** Folders a sync app keeps, such as OneDrive. */
  clouds: { name: string; path: string }[];
}

/** Rows of one snapshot. */
/** A file or folder from Windows' list of recently opened ones. */
export interface Recent {
  name: string;
  path: string;
  isDir: boolean;
  /** When it was last opened, in milliseconds since 1970. */
  opened: number;
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
  /** Runs of rows, first and last both in, for selections too big to send row by row. */
  ranges?: [number, number][];
}

/** What the UI can ask of the file engine. Folders are paths, and files are always rows. */
/** How hard a new ZIP squeezes its files. */
export type ZipLevel = "store" | "fast" | "normal" | "best";
export type ArchiveFormat = "zip" | "7z" | "tar" | "tar.gz";

export type Task =
  | { kind: "copy" | "move"; selection: Selection; folder: string }
  | { kind: "rename"; selection: Selection; name: string }
  | { kind: "renameAll"; selection: Selection; names: string[] }
  | { kind: "new"; folder: string; directory: boolean }
  /** A new folder named after the first selected row. With `moveIn` the rows go into it. */
  | { kind: "newFolderFrom"; selection: Selection; folder: string; moveIn: boolean }
  | { kind: "copyPaths" | "movePaths"; paths: string[]; folder: string }
  | { kind: "template"; folder: string; extension: string }
  /** `called` is what the user named it, for a `{name}` in the template's names. */
  | { kind: "ownTemplate"; folder: string; name: string; date?: string; called?: string }
  | { kind: "renameTemplate"; name: string; to: string }
  | { kind: "removeTemplate"; name: string }
  | { kind: "fromClipboard"; folder: string }
  | { kind: "saveTemplate"; selection: Selection }
  | { kind: "zip"; selection: Selection; level?: ZipLevel; password?: string; format?: ArchiveFormat; aes?: boolean }
  /** `smart` gives an archive its own folder only when more than one item sits at its top. */
  | { kind: "unzip"; selection: Selection; ownFolder: boolean; smart?: boolean; only?: string[]; password?: string }
  | { kind: "paste"; folder: string }
  | { kind: "pasteShortcut"; folder: string }
  /** Every attachment of a mail file, into `folder`. */
  | { kind: "saveAttachments"; path: string; folder: string; only?: number }
  | { kind: "tag"; target: ShellTarget; tag: number; on: boolean }
  | { kind: "deleteTag"; id: number }
  | { kind: "drop"; folder: string; action?: DropAction; id: number }
  | { kind: "recycle" | "delete" | "restore" | "purge"; selection: Selection }
  | { kind: "restoreTo"; selection: Selection; folder: string }
  | { kind: "empty" }
  /** Everything in a ZIP, into a folder of its own beside it. */
  | { kind: "extractZip"; path: string }
  /** A quick edit's text saved over its file. `seen` is what the preview said of it when read. */
  | { kind: "save"; path: string; text: string; seen?: string }
  /** A filled-in PDF, staged by `stagePdf`, saved over its file. */
  | { kind: "savePdf"; path: string; staged: number; seen?: string }
  /** Pictures by path, from a preview, or the selected rows. */
  | { kind: "picture"; paths?: string[]; selection?: Selection; edit: PictureEdit; keep?: PictureKeep }
  | { kind: "wallpaper"; path: string };

/** What a copy keeps of a photo's facts. A turn saved into the file keeps them all. */
export interface PictureKeep {
  camera: boolean;
  place: boolean;
}

export type PictureFormat = "png" | "jpeg" | "tiff" | "bmp";
/** The formats a picture can be copied as, and their names. */
export const PICTURE_FORMATS: [PictureFormat, string][] = [["png", "PNG"], ["jpeg", "JPEG"], ["tiff", "TIFF"], ["bmp", "BMP"]];
/** Sizes a smaller copy can take, by its longer side. */
export const COPY_EDGES = [3840, 2560, 1920, 1280, 800];
/** A turn saves into the file. The rest make a new picture beside it. */
export type PictureEdit =
  /** Quarter turns clockwise, after a mirror left to right with `flip`. */
  | { kind: "turn"; quarters: number; flip: boolean }
  /** Never bigger than the picture already is. */
  | { kind: "resize"; longest: number }
  | { kind: "convert"; format: PictureFormat }
  /** A smaller JPEG, keeping what `keep` says of the photo's facts. */
  | { kind: "share" }
  /** A copy of part of it. Each side is a share of the whole picture as it shows, from 0 to 1. */
  | { kind: "crop"; left: number; top: number; width: number; height: number };

export interface Progress {
  bytes: number;
  totalBytes: number;
  items: number;
  totalItems: number;
  current: string;
  /** In a job of several parts, which one this is and how many there are; both 0 otherwise. */
  part?: number;
  parts?: number;
}

export type Answer = "replace" | "keepBoth" | "merge" | "skip" | "retry" | "elevate" | "permanent" | "cancel";

export interface Facts {
  size: number;
  /** FILETIME ticks. */
  modified: number;
  folder: boolean;
}

export type Question =
  | {
      kind: "conflict";
      name: string;
      source: Facts;
      target: Facts;
      /** The file coming in, when it is one on a disk. */
      sourcePath: string | null;
      targetPath: string;
      /** Of everything picked for the job, how many names are taken there and how many are free. */
      clashes: number;
      fresh: number;
      choices: Answer[];
    }
  | { kind: "problem"; path: string; message: string; choices: Answer[] }
  | { kind: "noBin"; path: string; choices: Answer[] };

export type JobEvent = { id: number } & (
  | {
      kind: "started";
      title: string;
      origin: number | null;
      newItem: boolean;
      recycle: boolean;
      back: boolean;
      /** The archives it takes files out of. */
      unpack: string[];
      /** The folder the job fills, for what to do when it is done. */
      target: string | null;
    }
  /** Windows is about to ask for permission, with UAC over the whole screen. */
  | { kind: "elevating" }
  /** Waits for another job on these drives. Empty once it starts. */
  | { kind: "waiting"; drives: string[] }
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
      /** What the job skipped after a problem. */
      failed: Retry[];
      /** False for a restore or an undo, whose skips are only listed. */
      retries: boolean;
      cancelled: boolean;
      /** Tags changed, so the tag list and the tag dots need reading again. */
      tags: boolean;
      /** The undo step this job added. */
      step: number | null;
    } & Undoable)
);

/** One item a copy or a move skipped, and the folder it was going to. */
export interface Retry {
  source: string;
  folder: string;
  moving: boolean;
}

/** What the start found of jobs a crash cut short. */
export interface Swept {
  putBack: number;
  cleaned: number;
}

/** What Undo and Redo can do now. */
export interface Undoable {
  /** The step Undo would reverse next. */
  latestStep: number | null;
  redo: boolean;
  /** What Undo and Redo would do, like "Renamed a.txt to b.txt". */
  undoText: string | null;
  redoText: string | null;
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
  /** `effect` is what letting go there would do, or null where nothing would happen. */
  | { kind: "over"; x: number; y: number; effect?: DropAction | null }
  /** `right` means the right button dragged, so the user gets to pick what happens. */
  | { kind: "drop"; id: number; x: number; y: number; right: boolean; forGood: boolean }
  | { kind: "leave" };

/** What a drop can do, when the user picks it from a menu. */
/** `delete` is Shift on the Recycle Bin, and never a menu choice. */
export type DropAction = "move" | "copy" | "link" | "delete";

/** What a view wants from its search: a new query, the same one again, or the rows found so far. */
export type SearchStep = "start" | "again" | "grown";

/** A picture of a file, with plain alpha. */
export interface Thumb {
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/** What a Windows menu or Properties window is for. */
/** `paths` outlives a reload of the folder, which `rows` don't. */
export type ShellTarget =
  | { kind: "rows"; selection: Selection }
  | { kind: "folder"; path: string }
  | { kind: "paths"; paths: string[] };

const HEADER_BYTES = 34;
const TAG_BYTES = 4;
const THUMB_HEADER_BYTES = 8;
const FLAG_FOLDER = 1;
const FLAG_HIDDEN = 2;
const FLAG_CLOUD = 4;
const FLAG_PINNED = 8;
const FLAG_CUSTOM = 16;
const FLAG_SYSTEM = 32;
const UINT32_RANGE = 2 ** 32;
const FILETIME_TICKS_PER_MS = 10_000;
const FILETIME_TO_UNIX_MS = 11_644_473_600_000;

const names = new TextDecoder("utf-16le");
/** Most rows have no tags, and they can all share this. */
const NO_TAGS: number[] = [];

export const startState = () => invoke<Start>("start_state");

export const saveSession = (text: string) => invoke<void>("save_session", { text });

export const listPlaces = () => invoke<Places>("list_places");

/** How an eject went. A busy drive says what still holds it. */
export type Ejected = { kind: "done" } | { kind: "busy"; reason: string };

/** Ejects a card, a disc or a USB disk. A drive still in use says why, with no box from Windows. */
export const ejectDrive = (path: string) => invoke<Ejected>("eject_drive", { path });

/** Shows a phone's files in File Explorer. */
export const openDevice = (id: string) => invoke<void>("open_device", { id });

/** Opens Windows' own BitLocker prompt for a locked drive. */
export const unlockDrive = (path: string) => invoke<void>("unlock_drive", { path });

export const checkUpdate = () => invoke<UpdateOffer | null>("check_update");

/** Ends Perli once the installer starts. */
export const installUpdate = () => invoke<void>("install_update");
/** How much of the update has come down, and how big it is when the server says. */
export const onUpdateProgress = (handler: (done: number, total: number | null) => void) =>
  listen<[number, number | null]>("update-progress", (event) => handler(...event.payload));
/** The download is done and the installer is starting. Perli closes, then reopens. */
export const onUpdateDownloaded = (handler: () => void) => listen("update-downloaded", handler);

export const recentFiles = (limit: number) => invoke<Recent[]>("recent_files", { limit });

/** Takes an item off Windows' recent list. The item itself stays. */
export const forgetRecent = (path: string) => invoke<number>("forget_recent", { path });

/** False when a server or network drive doesn't answer within a few seconds. */
export const reachable = (path: string) => invoke<boolean>("reachable", { path });

/** The first lines of a row that reads as text, or null. */
export const peekText = (view: number, request: number, row: number) =>
  invoke<string | null>("peek_text", { view, request, row });

/** The first few things in a folder (name, is a folder) and how many it holds, for its hover card. */
export interface FolderStart {
  names: [name: string, folder: boolean][];
  count: number;
  more: boolean;
}

/** A whole text file, for a compare. Null when it is not text. */
export const wholeText = (view: number, request: number, row: number) =>
  invoke<string | null>("whole_text", { view, request, row });

export const peekFolder = (view: number, request: number, row: number) =>
  invoke<FolderStart | null>("peek_folder", { view, request, row });

export const driveSpace = (path: string) => invoke<DriveSpace>("drive_space", { path });

/** The Recycle Bin's size, and the most it holds, in bytes, where Windows keeps a limit. */
export const binUsage = () => invoke<{ size: number; limit: number | null }>("bin_usage");

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

/** Keeps the password of a ZIP opened as a folder for this session. Fails with the
 *  wrong-password message unless it opens the ZIP's locked files. */
export const unlockZip = (path: string, password: string) => invoke<void>("unlock_zip", { path, password });
/** What files taken out of archives take up in Perli's cache, in bytes. */
export const archiveCacheSize = () => invoke<number>("archive_cache_size");
/** Empties that cache. Gives back the bytes left, which apps still have open. */
export const clearArchiveCache = () => invoke<number>("clear_archive_cache");

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
  invoke<Arranged>("arrange_view", { view, request, shown, order, selected });

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
  search: { step: SearchStep; query: string; scope: SearchScope; inside: boolean; depth: number | null } | null,
) =>
  invoke<Arranged>("reload_view", {
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
/** The job's id, or null when there was nothing to do. */
export const startJob = (task: Task, origin?: number) => invoke<number | null>("start_job", { task, origin });

/** With `step`, this only undoes that step, and only while it is the newest. */
/** With `back`, undoes every step from the newest down to `step`, as one. */
export const undoJob = (origin?: number, step?: number, back = false) => invoke<void>("undo_job", { origin, step, back });
export const redoJob = (origin?: number) => invoke<void>("redo_job", { origin });
export const undoState = () => invoke<Undoable>("undo_state");

/** One step of the undo log, told the way a person would. */
export interface Activity {
  id: number;
  /** Milliseconds since 1970, or 0 for a step from before times were kept. */
  at: number;
  text: string;
  /** Where to look for what it left. */
  path: string;
  /** Only the newest step can be undone. */
  newest: boolean;
}

/** What can still be undone, newest first. */
export const activity = () => invoke<Activity[]>("activity");

/** The files of the last drop, for the shelf to keep. Nothing moves. */
export const shelveDrop = () => invoke<string[]>("shelve_drop");

/** The full paths of the selected rows. */
export const selectionPaths = (selection: Selection) => invoke<string[]>("selection_paths", { selection });

/** Drags files out by their paths, the way `startDrag` does with rows. */
export const startDragPaths = (paths: string[]) => invoke<void>("start_drag_paths", { paths });

/** Which of `paths` are still there, in the same order. */
export const pathsExist = (paths: string[]) => invoke<boolean[]>("paths_exist", { paths });

/** How far from the shown folder a search looks. */
export type SearchScope = "below" | "folder" | "drive" | "drives";
/** With jobs running, this keeps the window open past the close limit. True if it did. */
/** `request` is the number `onCloseAsked` gave, so a late answer can't hold a newer request. */
export const holdClose = (request: number) => invoke<boolean>("hold_close", { request });
export const onCloseAsked = (handler: (request: number) => void) =>
  listen<number>("close-asked", (event) => handler(event.payload));
export const cancelJobsAndClose = () => invoke<void>("cancel_jobs_and_close");
export const pauseJob = (id: number) => invoke<void>("pause_job", { id });
export const resumeJob = (id: number) => invoke<void>("resume_job", { id });
export const cancelJob = (id: number) => invoke<void>("cancel_job", { id });
export const startJobNow = (id: number) => invoke<void>("start_job_now", { id });
export const setJobOptions = (verify: boolean, onePerDrive: boolean) => invoke<void>("set_job_options", { verify, onePerDrive });

/** The whole-PC index as the user set it. */
export interface IndexOptions {
  on: boolean;
  paused: boolean;
  /** Wait while the PC runs on its battery. */
  battery: boolean;
  network: boolean;
  /** Folders left out, with all they hold. */
  skip: string[];
}

export interface IndexStatus {
  state: "off" | "waiting" | "walking" | "ready" | "paused" | "battery";
  /** Files and folders listed. */
  files: number;
  folders: number;
  /** What the list takes on disk. */
  bytes: number;
  /** When the last look through a drive ended, in ms. */
  walked?: number | null;
  /** What the look under way has listed so far. */
  listed: number;
  drives: string[];
}

export const setIndexOptions = (options: IndexOptions) => invoke<void>("set_index_options", { options });
export const indexStatus = () => invoke<IndexStatus>("index_status");
export const rebuildIndex = () => invoke<void>("rebuild_index");
export const takeSweepReport = () => invoke<Swept>("take_sweep_report");

/** `all` uses the same answer for every later case of this kind. */
export const answerJob = (id: number, answer: Answer, all: boolean) =>
  invoke<void>("answer_job", { id, reply: { answer, all } });

export const onJobEvent = (handler: (event: JobEvent) => void) =>
  listen<JobEvent>("job", (event) => handler(event.payload));

/** Starts a job and waits for it to end: null when there was nothing to do. The job's card,
 *  questions and undo step are the same as any other job's. */
export async function runJob(task: Task, origin?: number) {
  type Finished = Extract<JobEvent, { kind: "finished" }>;
  // A quick job can end before `startJob` comes back, so ends are heard from the start.
  const ends = new Map<number, Finished>();
  let wanted: { id: number; done: (event: Finished) => void } | undefined;
  const stop = await onJobEvent((event) => {
    if (event.kind !== "finished") return;
    if (event.id === wanted?.id) wanted.done(event);
    else ends.set(event.id, event);
  });
  try {
    const id = await startJob(task, origin);
    if (id === null) return null;
    return await new Promise<Finished>((done) => {
      const early = ends.get(id);
      if (early) done(early);
      else wanted = { id, done };
    });
  } finally {
    stop();
  }
}

/** What is wrong with each of `names`, which line up with the selected rows. */
export const checkRenames = (selection: Selection, names: string[]) =>
  invoke<(string | null)[]>("check_renames", { selection, names });

/** The selected rows' names, and whether each is a folder. */
export const rowFacts = (selection: Selection) => invoke<[string, boolean][]>("row_facts", { selection });
/** What a batch rename's tokens read from each row. `deep` reads date taken, artist and title too. */
export const renameFacts = (selection: Selection, deep: boolean) =>
  invoke<import("../features/fileops/renameRules").NameFacts[]>("rename_facts", { selection, deep });

export const measureSelection = (selection: Selection) => invoke<Measured>("measure_selection", { selection });

export const binSummary = () => invoke<Measured>("bin_summary");

/** Fired on `window` once Perli puts files on the clipboard. */
export const CLIPBOARD_SET = "perli-clipboard-set";

export const setClipboard = (selection: Selection, cut: boolean) =>
  invoke<{ names: string[]; paths: string[]; sequence: number }>("set_clipboard", { selection, cut }).then((set) => {
    window.dispatchEvent(new Event(CLIPBOARD_SET));
    return set;
  });

export const cancelCut = (sequence: number) => invoke<void>("cancel_cut", { sequence });

export const clipboardSequence = () => invoke<number>("clipboard_sequence");

/** True if a paste would make something: files, an image or text. */
export const clipboardCanPaste = () => invoke<boolean>("clipboard_can_paste");
/** Text or a picture is on the clipboard, to make a new file from. */
export const clipboardHasContent = () => invoke<boolean>("clipboard_has_content");
export const clipboardHasFiles = () => invoke<boolean>("clipboard_has_files");

/** The first row at or after `start` whose name starts with `prefix`, wrapping around. */
export const findRow = (view: number, request: number, prefix: string, start: number) =>
  invoke<number | null>("find_row", { view, request, prefix, start });

export const listTags = () => invoke<Tag[]>("list_tags");

export const createTag = (name: string, color: number) => invoke<Tag>("create_tag", { name, color });

export const editTag = (id: number, name: string, color: number) => invoke<void>("edit_tag", { id, name, color });

/** Undo brings the tag back, on every file that had it. */
export const deleteTag = (id: number) => runJob({ kind: "deleteTag", id });

/** Puts `tag` on the selected rows, or takes it off, as a job Undo can take back. */
export const setTag = (target: ShellTarget, tag: number, on: boolean) => runJob({ kind: "tag", target, tag, on });

/** Puts `tag` on files by their paths, or takes it off. */
export const setTagPaths = (paths: string[], tag: number, on: boolean) => setTag({ kind: "paths", paths }, tag, on);

/** Every tagged file here, by path, with its tags, for a backup. */
export const taggedFiles = () => invoke<[string, number[]][]>("tagged_files");

/** Puts a backup's tags back on the files here. Says how many files got them. */
export const restoreTagged = (files: [string, number[]][]) => invoke<number>("restore_tagged", { files });

/** Asks the sync app to keep the selected rows on this device for good, or to free their space. */
export const keepOnDevice = (selection: Selection, keep: boolean) =>
  invoke<void>("keep_on_device", { selection, keep });

/** The tags all the selected rows have. */
export const commonTags = (target: ShellTarget) => invoke<number[]>("common_tags", { target });

/** The rows whose names fit `pattern`, such as `*.jpg;*.png`. */
export const rowsMatching = (view: number, request: number, pattern: string) =>
  invoke<number[]>("rows_matching", { view, request, pattern });

/** The rows that fit `filter`, for picking all of one kind, tag or day. */
export const rowsWhere = (view: number, request: number, filter: Filter) =>
  invoke<number[]>("rows_where", { view, request, filter });

/** What git says of a row, weakest first, as `git::Mark` in Rust. */
export type GitMark = "ignored" | "new" | "added" | "modified" | "conflict";

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  /** The rows git has something to say of, by lowercase name. */
  marks: [string, GitMark][];
}

/** What git says of `folder`'s rows and its branch, or null outside a repository or without git. */
/** `fresh` asks git past what it said for the same index and rows. */
export const gitStatus = (folder: string, fresh = false) => invoke<GitStatus | null>("git_status", { folder, fresh });

/** How a row stands against the other pane's row of the same name, in the order of `folder::Mark`.
 *  Pending is a folder whose insides, or a file whose bytes, are still being compared. */
export const MARKS = ["none", "only", "newer", "older", "differs", "same", "pending"] as const;
export type Mark = (typeof MARKS)[number];

/** What sets a compared folder apart from its twin: how many things under it, and the first few. */
export interface Apart {
  count: number;
  names: string[];
}

/** What the bar of compared panes says of one: how many rows it could show have each mark (by its
 *  place in `MARKS`), the names of rows to leave out, and what sets each shown folder apart. */
export interface CompareSummary {
  counts: number[];
  hidden: string[];
  folders: ({ row: number } & Apart)[];
}

/** One byte a row of `snapshot`, each an index into `MARKS`, and what the bar says. */
export interface Marks {
  snapshot: number;
  marks: Uint8Array;
  summary?: CompareSummary;
  /** What sets each folder row apart, by row. */
  apart?: Map<number, Apart>;
}

/** How each row of one pane stands against the rows of the other. With `content`, files alike in
 *  size stand by their bytes. */
export const compared = (view: number, request: number, other: number, otherRequest: number, content = false) =>
  invoke<ArrayBuffer>("compared", { view, request, other, otherRequest, content }).then((bytes) => new Uint8Array(bytes));

/** What the bar of compared panes says of one, with the names of its rows whose mark is in `hide`. */
export const compareSummary = (view: number, request: number, other: number, otherRequest: number, content: boolean, hide: number[]) =>
  invoke<CompareSummary>("compare_summary", { view, request, other, otherRequest, content, hide });

/** Learns for a while what the marks of compared panes wait on. How many pairs it settled. */
export const compareSettle = (view: number, request: number, other: number, otherRequest: number, content: boolean) =>
  invoke<number>("compare_settle", { view, request, other, otherRequest, content });

/** Stops learning for two panes' marks, as their compare ended. */
export const compareStop = (view: number, other: number) => invoke<void>("compare_stop", { view, other });

/** The first of `names` among a view's rows, in any case: which of them, and its row. */
export const rowNamed = (view: number, request: number, names: string[]) =>
  invoke<[number, number] | null>("row_named", { view, request, names });

/** How many rows fit `filter`, to tell a folder of songs or pictures by. */
export const countWhere = (view: number, request: number, filter: Filter) =>
  invoke<number>("count_where", { view, request, filter });

/** What `names` read for each of `rows`, as Windows shows them. A `date:` name gives milliseconds. */
export const rowProps = (view: number, request: number, rows: number[], names: string[]) =>
  invoke<(string | null)[][]>("row_props", { view, request, rows, names });

/** A few pictures right inside `path`, for its tile to show a stack of, or up to `most` (200 at
 *  the very most) for the cover picker. */
export const folderPictures = (path: string, most?: number) => invoke<string[]>("folder_pictures", { path, most: most ?? null });

/** The bytes of the selected files, from the listing alone. Folders count as nothing. */
/** How many files the rows are, each once, and their size. */
export const selectionSize = (selection: Selection) => invoke<[number, number]>("selection_size", { selection });

/** The accent color picked in Windows, as `#rrggbb`. */
export const windowsAccent = () => invoke<string | null>("windows_accent");

/** Starts adding up the folders in `path`. `onSizesGrew` says when totals come in. */
export const scanSizes = (view: number, path: string) => invoke<void>("scan_sizes", { view, path });

/** Stops every scan and forgets the totals. */
export const stopSizes = () => invoke<void>("stop_sizes");

/** Experimental. Makes another app's Open or Save dialog go to `folder`, and gives the dialog's title. */
export const sendToFileDialog = (folder: string) => invoke<string>("send_to_file_dialog", { folder });

/** One thing right inside a folder, with all the bytes under it. */
export interface MapCell {
  name: string;
  bytes: number;
  folder: boolean;
}

/** Weighs what is in `path` for the disk map. Answers come through `onMapGrew` with `ticket`. */
export const mapFolder = (path: string, ticket: number) => invoke<void>("map_folder", { path, ticket });
export const stopMap = () => invoke<void>("stop_map");
/** `cells` are new or have grown. `done` says they were the last. */
export const onMapGrew = (handler: (grew: { ticket: number; cells: MapCell[]; done: boolean }) => void) =>
  listen<{ ticket: number; cells: MapCell[]; done: boolean }>("map-grew", (event) => handler(event.payload));

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

/** Saves `text` as a .json file picked in Perli's picker. One already there needs `replace`. */
export const writeSettingsFile = (path: string, text: string, replace: boolean) =>
  invoke<void>("write_settings_file", { path, text, replace });

/** The text of a .json file of settings picked in Perli's picker. */
export const readSettingsFile = (path: string) => invoke<string>("read_settings_file", { path });

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

/** Opens Windows Terminal in a folder, or else PowerShell. `shell` asks for one by name. */
export type Terminal = "cmd" | "wt" | "powershell" | "pwsh";

export const openTerminal = (path: string, shell?: Terminal) => invoke<void>("open_terminal", { path, shell });

/** The terminals on this PC. */
export const terminals = () => invoke<Terminal[]>("terminals");

export const newTypes = () => invoke<NewType[]>("new_types");

/** The names of the user's own templates, A to Z. */
/** One of the user's own templates. `asks` means a `{name}` is in it, so the user names it first. */
export interface OwnTemplate {
  name: string;
  folder: boolean;
  asks: boolean;
}

export const ownTemplates = () => invoke<OwnTemplate[]>("own_templates");

export const templatesFolder = () => invoke<string>("templates_folder");

/** What is right inside `path`, in Explorer's order, as [name, is a folder]: the folders, then with `files` the files. */
export const folderItems = (path: string, showHidden: boolean, showSystem: boolean, files: boolean) =>
  invoke<[string, boolean][]>("subfolders", { path, showHidden, showSystem, files });

/** The names of the folders right inside `path`, in Explorer's order. */
export const subfolders = (path: string, showHidden: boolean, showSystem: boolean) =>
  folderItems(path, showHidden, showSystem, false).then((items) => items.map(([name]) => name));

/** The apps holding the selected files. */
export const fileUsers = (selection: Selection) => invoke<string[]>("file_users", { selection });

/** Something outside Perli changed the folder this view shows. */
export const onFolderChanged = (handler: (view: number) => void) =>
  listen<number>("folder-changed", (event) => handler(event.payload));

/** A folder another start of Perli was asked to open, with the names to select in it. */
export interface OpenAsk {
  folder: string | null;
  select: string[];
  /** For this window, which opened for the folder: select here, and open no window of its own. */
  here?: boolean;
}

export const onOpenAsked = (handler: (ask: OpenAsk) => void) =>
  listen<OpenAsk>("open-asked", (event) => handler(event.payload));

/** Asks that came before the UI listened. Call once `onOpenAsked` is set; later ones are events. */
export const asksWaiting = () => invoke<OpenAsk[]>("asks_waiting");

/** Brings the window to the front. */
export const comeForward = () => invoke<void>("come_forward");

/** Another Perli window under the pointer, and whether the pointer is on its tabs. */
export interface TabTarget {
  window: number;
  tabBar: boolean;
}
export const perliWindowAt = () => invoke<TabTarget | null>("perli_window_at");
/** Sends a moved tab's text to another Perli window. False when it didn't take it. */
export const sendTab = (window: number, tab: string) => invoke<boolean>("send_tab", { window, tab });
export const otherWindows = () => invoke<number[]>("other_windows");
/** Asks another Perli window to send all its tabs here and close. False when it won't. */
export const askForTabs = (window: number) => invoke<boolean>("ask_for_tabs", { window });
export const jobsRunning = () => invoke<boolean>("jobs_running");
/** Shows a picture, `width` by `height` RGBA pixels, at the pointer, over every window. */
export function ghostShow(width: number, height: number, rgba: Uint8ClampedArray) {
  const body = new Uint8Array(8 + rgba.length);
  const head = new DataView(body.buffer);
  head.setUint32(0, width, true);
  head.setUint32(4, height, true);
  body.set(rgba, 8);
  return invoke<void>("ghost_show", body);
}
export const ghostMove = () => invoke<void>("ghost_move");
export const ghostHide = () => invoke<void>("ghost_hide");

/** Starts one more Perli with a window of its own, and gives its process id. */
/** `moved` is a whole tab for the new window to take, as `parseMoved` reads it. */
export const openWindow = (folder: string, select: string[], moved?: string) =>
  invoke<number>("open_window", { folder, select, moved: moved ?? null });

/** This window's tabs go on closing: kept to reopen, or dropped when they went to another window. */
export const forgetSession = (reopenable: boolean) => invoke<void>("forget_session", { reopenable });
/** Opens again every window that was open when Perli last stopped. */
export const restoreWindows = () => invoke<void>("restore_windows");
/** Opens the window closed last. False when none is kept. */
export const reopenWindow = () => invoke<boolean>("reopen_window");
/** Tells the back end which workspace this window shows, for other windows to ask. */
export const setWorkspace = (name: string | undefined) => invoke<void>("set_workspace", { name: name ?? null });
/** For each name, the other Perli window showing that workspace, or null. */
export const workspaceWindows = (names: string[]) => invoke<(number | null)[]>("workspace_windows", { names });
/** Brings another Perli window to the front. */
export const showWindow = (window: number) => invoke<boolean>("show_window", { window });
/** Asks the window showing workspace `name` to send it here and close. False when it won't. */
export const bringWorkspace = (window: number, name: string) => invoke<boolean>("bring_workspace", { window, name });
/** Sends a workspace, as JSON, to the window that asked for it. */
export const sendWorkspace = (window: number, text: string) => invoke<boolean>("send_workspace", { window, text });
/** Selects `select` in `folder` in the window of Perli `process`, once it is up. False if it never came. */
export const selectInWindow = (process: number, folder: string, select: string[]) =>
  invoke<boolean>("select_in_window", { process, ask: { folder, select, here: true } });

export const onDrivesChanged = (handler: () => void) => listen("drives-changed", handler);

export const onFileDrag = (handler: (event: FileDrag) => void) =>
  listen<FileDrag>("file-drag", (event) => handler(event.payload));

/** Names the folder under a drag, which decides the cursor. */
export const setDropTarget = (folder: string | null) => invoke<void>("set_drop_target", { folder });

/** Whether Space is held, for a drag resting on a folder to open it at once. */
export const spaceDown = () => invoke<boolean>("space_down");

/** What the last drop can do on `folder`, for the user to pick from. */
export const dropChoices = (folder: string) => invoke<DropAction[]>("drop_choices", { folder });
/** The count and size of the drop that waits for an answer. */
export const measureDrop = (id: number) => invoke<Measured>("measure_drop", { id });

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
  /** `seen` comes with a whole file, which a quick edit can save over. */
  | { kind: "text"; text: string; next: number | null; end: number; encoding: string; seen?: string }
  | { kind: "markdown"; html: string; source: string; seen?: string }
  /** `hidden` when even the names are locked. `lock` says how locked files are locked, such as
   *  "AES-256" or "ZipCrypto", and is null when none are. */
  | { kind: "archive"; entries: ArchiveEntry[]; more: boolean; hidden: boolean; lock: string | null }
  | { kind: "comic"; pages: string[] }
  | { kind: "book"; title: string; chapters: string[]; contents: BookHeading[] }
  | { kind: "model" }
  /** A SQLite database's tables and views, or why they can't be read. */
  | { kind: "database"; tables: DbTable[]; failure: string | null }
  | { kind: "parquet" }
  | { kind: "font"; faces: FontFacts[] }
  | ({ kind: "mail" } & Mail)
  | { kind: "pdf" }
  | { kind: "song" }
  | { kind: "audio" }
  | { kind: "video" }
  | { kind: "picture" }
  /** Only in the cloud, so nothing was read. Windows' picture of it shows, if it has one. */
  | { kind: "cloud" };

/** A mail saved as a file. `date` is FILETIME ticks, or 0 when the mail doesn't say. */
export interface Mail {
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: number;
  body: string;
  attachments: { name: string; size: number }[];
}

/** A line of a book's own table of contents, and which chapter it opens. */
export interface BookHeading {
  title: string;
  chapter: number;
  depth: number;
}

/** One file or folder inside an archive. `modified` is as the archive wrote it. */
export interface ArchiveEntry {
  name: string;
  size: number;
  folder: boolean;
  modified: string | null;
  /** Protected by a password. */
  locked: boolean;
  /** How a ZIP's file is squeezed, such as "Deflate" or "Zstandard". Null for other kinds. */
  method?: string | null;
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

/** How wide each of `count` rows of a snapshot from `from` on shows for its height, turned the way
 *  its photo or video says, for the gallery. 0 for a row that is no picture. */
export const pictureAspects = (view: number, request: number, from: number, count: number) =>
  invoke<number[]>("picture_aspects", { view, request, from, count });

/** A comic page or a book's picture, by its name inside the archive. */
export const fetchArchivePicture = (view: number, request: number, row: number, entry: string, edge: number, password?: string) =>
  invoke<ArrayBuffer>("archive_picture", { view, request, row, entry, edge, password: password ?? null }).then(decodeThumb);

/** The start of a text file inside a ZIP, or null if it is not text. */
/** Fails with the wrong-password message unless `password` opens all of `entry`. */
export const archivePassword = (view: number, request: number, row: number, entry: string, password: string) =>
  invoke<void>("archive_password", { view, request, row, entry, password });

export const archiveText = (view: number, request: number, row: number, entry: string, password?: string) =>
  invoke<string | null>("archive_text", { view, request, row, entry, password: password ?? null });

/** What reading every file of a ZIP back found. */
export interface ArchiveTested {
  sound: number;
  damaged: string[];
  /** Files left unread for want of a password. */
  locked: number;
}

export const archiveTest = (view: number, request: number, row: number, password?: string) =>
  invoke<ArchiveTested>("archive_test", { view, request, row, password: password ?? null });

/** Drags one file out of a ZIP, the way a row is dragged out of the list. */
export const dragEntry = (view: number, request: number, row: number, entry: string, password?: string) =>
  invoke<void>("drag_entry", { view, request, row, entry, password: password ?? null });

/** One attachment of a mail, taken out to a file of its own to open, show or drag. */
export const mailAttachment = (path: string, index: number) => invoke<string>("mail_attachment", { path, index });

/** A mail taken out of another, to show in its place. */
export const readMail = (path: string) => invoke<Mail>("read_mail", { path });

/** The words beside a file under its own name: lyrics (`lrc`) or subtitles (`srt`, `vtt`). */
/** The loudest point of each of `bars` slices of a sound, from 0 to 1, read a little at a time. */
export const audioPeaks = (view: number, request: number, row: number, bars: number) =>
  invoke<number[]>("audio_peaks", { view, request, row, bars });

export const besideText = (view: number, request: number, row: number, extension: "lrc" | "srt" | "vtt", path?: string) =>
  invoke<string | null>("beside_text", { view, request, row, extension, path: path ?? null });

/** Hands a film to the small window that plays it on top of every window. */
export const miniOpen = (state: unknown) => invoke<void>("mini_open", { state });
/** What the main window handed the small window last, once. */
export const miniTake = <T>() => invoke<T | null>("mini_take");
/** Sizes the small window to the film's shape and puts it in a corner of the screen. */
export const miniFit = (width: number, aspect: number, corner: string) => invoke<void>("mini_fit", { width, aspect, corner });

/** Saves a frame of a film as a PNG beside it, and gives the new file's name. */
export function saveFrame(view: number, request: number, row: number, seconds: number, png: ArrayBuffer) {
  const HEAD = 24;
  const body = new Uint8Array(HEAD + png.byteLength);
  const head = new DataView(body.buffer);
  head.setUint32(0, view, true);
  head.setUint32(4, row, true);
  head.setFloat64(8, request, true);
  head.setFloat64(16, seconds, true);
  body.set(new Uint8Array(png), HEAD);
  return invoke<string>("save_frame", body);
}

/** A filled-in PDF written beside its file as "name (filled).pdf". Answers the name it took. */
export function savePdfCopy(path: string, pdf: Uint8Array) {
  const name = new TextEncoder().encode(path);
  const body = new Uint8Array(4 + name.length + pdf.length);
  new DataView(body.buffer).setUint32(0, name.length, true);
  body.set(name, 4);
  body.set(pdf, 4 + name.length);
  return invoke<string>("save_pdf_copy", body);
}

/** A filled-in PDF kept for a "savePdf" job to write over its file. Answers its ticket. */
export const stagePdf = (pdf: Uint8Array) => invoke<number>("stage_pdf", pdf);

/** One chapter of a book as safe HTML, by its name inside the archive. */
export const bookChapter = (view: number, request: number, row: number, entry: string) =>
  invoke<string>("book_chapter", { view, request, row, entry });

/** A 3D model's bytes or, with `part`, those of a file beside it that the model points to. */
export const modelFile = (view: number, request: number, row: number, part?: string) =>
  invoke<ArrayBuffer>("model_file", { view, request, row, part: part ?? null });

/** A table or view of a SQLite database, with the statement that made it. */
export interface DbTable {
  name: string;
  view: boolean;
  sql: string;
}

/** Rows read from a database: at most 5,000, with `more` when there are others. */
export interface DbRows {
  columns: string[];
  /** Each column's declared type, for a table's own rows. */
  types: string[];
  rows: (string | null)[][];
  more: boolean;
}

/** What one face of a font says about itself. Text it doesn't give is empty. */
export interface FontFacts {
  family: string;
  style: string;
  fullName: string;
  version: string;
  designer: string;
  maker: string;
  copyright: string;
  license: string;
  description: string;
  /** The face's own sample text, if its maker gave one. */
  sample: string;
  glyphs: number;
  unitsPerEm: number;
  weight: number;
  /** From 1, ultra-condensed, to 9, ultra-expanded; 5 is normal. */
  width: number;
  italic: boolean;
  monospaced: boolean;
  outlines: string;
  embedding: string;
  /** The characters it draws, as runs of first and last code points. */
  characters: [number, number][];
  axes: { tag: string; name: string; min: number; default: number; max: number }[];
}

/** One face of a row's font to draw with; a face of a collection comes on its own. */
export const fontFace = (view: number, request: number, row: number, index: number) =>
  invoke<ArrayBuffer>("font_face", { view, request, row, index });

/** Who a row's font is installed for. Only "user" can be taken back without an admin. */
export type FontInstalled = "no" | "user" | "system";
export const fontInstalled = (view: number, request: number, row: number) =>
  invoke<FontInstalled>("font_installed", { view, request, row });
/** Installs a row's font for this user, or with `remove` takes it out again. */
export const installFont = (view: number, request: number, row: number, remove: boolean) =>
  invoke<void>("install_font", { view, request, row, remove });

/** A row's file as a path the window may stream, reading only the parts it needs. */
export const openStreamed = (view: number, request: number, row: number) => invoke<string>("open_streamed", { view, request, row });

export const dbCount = (view: number, request: number, row: number, table: string) => invoke<number>("db_count", { view, request, row, table });

export const dbRows = (view: number, request: number, row: number, table: string, order: { column: number; down: boolean } | null, filters: string[]) =>
  invoke<DbRows>("db_rows", { view, request, row, table, order, filters });

/** What the user's own statement finds. The database is open read-only, so it can't change it. */
export const dbQuery = (view: number, request: number, row: number, sql: string) => invoke<DbRows>("db_query", { view, request, row, sql });

/** A MIDI song's notes in order of start, as columns: start and length in seconds, key, channel. */
export interface Notes {
  start: Float32Array;
  long: Float32Array;
  key: Uint8Array;
  channel: Uint8Array;
}

/** Where a MIDI song's notes sound across it, in `columns` slices: each key and channel once a slice. */
export interface Overview {
  columns: number;
  column: Uint16Array;
  key: Uint8Array;
  channel: Uint8Array;
}

/** A MIDI file's name, instruments and notes. */
export interface SongInfo {
  title: string | null;
  /** General MIDI programs in the order they first play. 128 is the drums. */
  instruments: number[];
  /** Each channel that plays and the instrument it starts with. */
  channels: [channel: number, instrument: number][];
  /** When each beat falls, in seconds. */
  beats: number[];
  /** When each bar starts, in seconds, following the time signatures. */
  bars: number[];
  /** The lowest and highest key played. */
  low: number;
  high: number;
  /** The longest note, in seconds. */
  longest: number;
  /** When the last note ends, in seconds. 0 for a song with no notes. */
  end: number;
  overview: Overview;
  /** The notes that may sound from `from` to `to` seconds, in order of start. A big song has
   *  millions, so they come a stretch at a time. */
  notesBetween: (from: number, to: number) => Promise<Notes>;
}

/** Slices of a song the player's strip shows, about one a pixel. */
const OVERVIEW_COLUMNS = 1200;

/** How a MIDI file is played: silent channels as bits, keys up or down, and how fast. */
export interface Playing {
  muted: number;
  transpose: number;
  speed: number;
}

export async function songInfo(view: number, request: number, row: number): Promise<SongInfo> {
  const [info, packed] = await Promise.all([
    invoke<Omit<SongInfo, "overview" | "notesBetween">>("song_info", { view, request, row }),
    invoke<ArrayBuffer>("song_overview", { view, request, row, columns: OVERVIEW_COLUMNS }),
  ]);
  const count = Math.floor(packed.byteLength / 4);
  const overview = {
    columns: OVERVIEW_COLUMNS,
    column: new Uint16Array(packed, 0, count),
    key: new Uint8Array(packed, 2 * count, count),
    channel: new Uint8Array(packed, 3 * count, count),
  };
  const notesBetween = (from: number, to: number) => invoke<ArrayBuffer>("song_notes", { view, request, row, from, to }).then(unpackNotes);
  return { ...info, overview, notesBetween };
}

/** Notes packed by Rust as columns: every start, every length, every key, every channel. */
export function unpackNotes(packed: ArrayBuffer): Notes {
  const count = Math.floor(packed.byteLength / 10);
  return {
    start: new Float32Array(packed, 0, count),
    long: new Float32Array(packed, 4 * count, count),
    key: new Uint8Array(packed, 8 * count, count),
    channel: new Uint8Array(packed, 9 * count, count),
  };
}

export interface Tags {
  title: string | null;
  artist: string | null;
  album: string | null;
}

/** Opens one sound file to the window, giving its path to stream and its tags. */
export const openAudio = (view: number, request: number, row: number, path?: string) =>
  invoke<[string, Tags]>("open_audio", { view, request, row, path: path ?? null });

/** A song's own album cover, or null if it has none. */
export const fetchCover = (view: number, request: number, row: number, edge: number) =>
  invoke<ArrayBuffer>("cover", { view, request, row, edge }).then(decodeThumb);

/** An AIFF file as one WAV, since the window plays no AIFF. */
export const aiffAudio = (view: number, request: number, row: number, path?: string) =>
  invoke<ArrayBuffer>("aiff_audio", { view, request, row, path: path ?? null });

/**
 * A MIDI file as one WAV, through the bundled SoundFont or a `.sf2` file named by `font`. The
 * number streams it from `song://` while it is made, until `forgetSong` lets go of it.
 */
export const songAudio = (view: number, request: number, row: number, how?: { playing?: Playing; font?: string; path?: string }) =>
  invoke<number>("song_audio", {
    view,
    request,
    row,
    path: how?.path ?? null,
    playing: how?.playing ?? null,
    font: how?.font ?? null,
  });

export const forgetSong = (number: number) => invoke<void>("forget_song", { number });

/** The desktop picture now, if it is a file. */
export const wallpaperNow = () => invoke<string | null>("wallpaper_now");
/** How a file stands now, the stamp a quick edit's save checks. */
export const fileSeen = (path: string) => invoke<string | null>("file_seen", { path });

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
      isSystem: (flags & FLAG_SYSTEM) !== 0,
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
