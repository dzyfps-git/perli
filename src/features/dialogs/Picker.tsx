import { createEffect, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import {
  closeView,
  fetchRows,
  isFile,
  itemFacts,
  listPlaces,
  readSettingsFile,
  startJob,
  writeSettingsFile,
  type Filter,
  type Row,
} from "../../api";
import { FileList } from "../filelist/FileList";
import { DEFAULT_COLUMNS } from "../filelist/columns";
import { saved, stored } from "../filelist/prefs";
import { createFolderView, type FolderView, type RowAt } from "../navigation/folderView";
import { baseName, join, parentOf, samePath, toCrumbs, typedPath } from "../navigation/path";
import { bookmarks } from "../sidebar/saved";
import { FOLDERS } from "../sidebar/Sidebar";
import { formatSize } from "../../ui/format";
import { openSheet } from "../../ui/sheet";
import { datedName, fitsTypes, isTypedPath, nameProblem, slideOf, stemEnd, withExtension } from "./parts";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./dialogs.css";

/** Far past any id the tabs hand out, and only one picker is ever open. */
const PICKER_VIEW = 1_000_000;
/** How long the focus rests on a file before the picker looks inside it. */
const PEEK_WAIT_MS = 140;
const SLIDE_PX = 28;
const SLIDE_MS = 260;
const ICON_UP = "";
const ICON_PANE = "";
const ICON_DRIVE = "";
const ICON_STAR = "";
const ICON_CLOUD = "";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const days = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** Pictures Windows can read, for picking one. */
export const PICTURE_TYPES = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "avif", "tif", "tiff"];

/** Drops on the picker land here, as one of Perli's own places. */
export const PICKER_PLACE = "perli:picker";

export type PickMode = "open" | "save" | "folder";

/** What a file holds, said under the list while it is focused. */
export interface Peek {
  text: string;
  /** Colours to show beside the words, such as a palette's. */
  colors?: string[];
}

export interface PickAsk {
  mode: PickMode;
  title: string;
  /** What the files are for. Each remembers the folder it was last picked in. */
  purpose: "settings" | "pictures" | "apps" | "folders";
  /** Extensions to show, lowercase with no dots. None shows every file. */
  types?: string[];
  /** Where to open, whatever was picked last. */
  start?: string;
  /** Where to open when nothing was picked for this purpose yet. */
  fallback?: string;
  /** The name a save starts with, which gets the day. */
  name?: string;
  /** Pictures show as the gallery. */
  gallery?: boolean;
  peek?: (path: string) => Promise<Peek | undefined>;
}

/** The path picked, and whether the user agreed to replace the file there. */
export interface Picked {
  path: string;
  replace: boolean;
}

interface Asked extends PickAsk {
  done: (picked: Picked | undefined) => void;
}

const [asked, setAsked] = createSignal<Asked>();
const [openView, setOpenView] = createSignal<FolderView>();
let dropped: ((paths: string[]) => void) | undefined;

/** The picker's list while it is open, so finished jobs show their new rows in it too. */
export const pickerViews = () => {
  const view = openView();
  return view ? [view] : [];
};

/** Files dropped on the picker pick themselves. */
export const dropOnPicker = (paths: string[]) => dropped?.(paths);

const parseFolders = (value: unknown): Record<string, string> =>
  value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
const [lastFolders, setLastFolders] = stored("picker-folders", parseFolders(saved("picker-folders")));

/** Asks for a file or folder in Perli's own picker. Nothing when the user backs out. */
export function pick(ask: PickAsk): Promise<Picked | undefined> {
  asked()?.done(undefined);
  return new Promise((resolve) => setAsked({ ...ask, done: resolve }));
}

/** Saves `text` as a .json file the user picks. False when they back out. */
export async function saveSettingsFile(text: string, name: string, title = "Save") {
  const picked = await pick({ mode: "save", title, purpose: "settings", types: ["json"], name });
  if (!picked) return false;
  await writeSettingsFile(picked.path, text, picked.replace);
  return true;
}

/** The text of a .json file the user picks, or nothing when they back out. `describe` says, in the
 *  picker, what the focused file holds. */
export async function openSettingsFile(title: string, describe?: (text: string) => Peek | undefined) {
  const peek = describe && (async (path: string) => describe(await readSettingsFile(path)));
  const picked = await pick({ mode: "open", title, purpose: "settings", types: ["json"], peek });
  return picked && readSettingsFile(picked.path);
}

/** Where Perli's own panes are, which the picker offers first. */
export interface PickerPanes {
  here?: string;
  there?: string;
  home?: string;
}

export function PickerHost(props: { panes: () => PickerPanes; report: (failure: unknown) => void }) {
  return (
    <Show when={asked()} keyed>
      {(ask) => (
        <Picker ask={ask} panes={props.panes()} report={props.report} onClose={() => asked() === ask && setAsked(undefined)} />
      )}
    </Show>
  );
}

interface Place {
  label: string;
  path: string;
  icon: string;
}

function Picker(props: { ask: Asked; panes: PickerPanes; report: (failure: unknown) => void; onClose: () => void }) {
  const ask = props.ask;
  const folders = ask.mode === "folder";
  const filter: Filter = {
    name: "",
    extensions: folders ? [] : (ask.types ?? []),
    kinds: folders ? "folders" : "all",
    minSize: null,
    maxSize: null,
    modifiedFrom: null,
    modifiedTo: null,
    tags: [],
    foldersStay: true,
  };
  const start = ask.start ?? lastFolders()[ask.purpose] ?? ask.fallback ?? props.panes.here ?? props.panes.home ?? "C:\\";
  const view = createFolderView(
    PICKER_VIEW,
    { path: start, sort: { key: "name", descending: false }, layout: ask.gallery ? "gallery" : "list" },
    filter,
  );
  const suggested = ask.mode === "save" ? datedName(ask.name ?? "Perli settings.json") : "";
  const [name, setName] = createSignal(suggested);
  const [problem, setProblem] = createSignal<string>();
  const [shake, setShake] = createSignal(0);
  const [peek, setPeek] = createSignal<Peek>();
  const [replacing, setReplacing] = createSignal<{ path: string; facts: string }>();
  const [row, setRow] = createSignal<Row>();
  const [places] = createResource(() => listPlaces().catch(() => undefined));
  let dialog!: HTMLDialogElement;
  let input!: HTMLInputElement;
  let listBox!: HTMLDivElement;
  let crumbsBox!: HTMLDivElement;
  let keep!: HTMLButtonElement;
  let close!: ReturnType<typeof openSheet>;
  let chosen = false;
  let peekTimer: number | undefined;
  let peekTicket = 0;
  let rowTicket = 0;

  const shown = () => view.folder()?.path;
  const typesText = () => (ask.types?.length ? ask.types.map((type) => `.${type}`).join(", ") : "");

  const placeList = (): Place[] => {
    const list: Place[] = [];
    const add = (label: string, path: string | undefined, icon: string) => {
      if (path && !list.some((place) => samePath(place.path, path))) list.push({ label, path, icon });
    };
    add("This pane", props.panes.here, ICON_PANE);
    add("Other pane", props.panes.there, ICON_PANE);
    for (const folder of places()?.folders ?? []) {
      const known = FOLDERS[folder.kind];
      if (known) add(known.label, folder.path, known.icon);
    }
    for (const cloud of places()?.clouds ?? []) add(cloud.name, cloud.path, ICON_CLOUD);
    for (const drive of places()?.drives ?? []) if (!drive.locked) add(drive.name, drive.path, ICON_DRIVE);
    for (const path of bookmarks()) add(baseName(path) || path, path, ICON_STAR);
    return list;
  };

  function say(text: string) {
    setProblem(text);
    setShake(shake() + 1);
  }

  function finish(path: string, replace = false) {
    chosen = true;
    setLastFolders({ ...lastFolders(), [ask.purpose]: folders ? path : (parentOf(path) ?? path) });
    close(() => ask.done({ path, replace }));
  }

  async function askReplace(path: string) {
    const facts = await itemFacts({ kind: "paths", paths: [path] }).catch(() => undefined);
    const when = facts?.modified ? `Saved ${days.format(facts.modified)}, ${formatSize(facts.size)}.` : "";
    setReplacing({ path, facts: when });
    keep.focus();
  }

  /** A file of the folder on show, or one typed or dropped, is the answer. */
  async function takeFile(path: string) {
    setProblem(undefined);
    if (ask.mode === "save") return askReplace(path);
    if (!fitsTypes(baseName(path), ask.types)) return say(`Pick a ${typesText()} file`);
    finish(path);
  }

  async function saveAs(path: string) {
    const parent = parentOf(path);
    const wanted = withExtension(baseName(path), ask.types?.[0] ?? "json");
    const refused = nameProblem(wanted);
    if (refused || !parent) return say(refused ?? "Pick a folder to save in");
    const named = join(parent, wanted);
    if (await isFile(named)) return askReplace(named);
    finish(named);
  }

  async function confirm() {
    const folder = shown();
    if (!folder) return;
    const typed = name().trim();
    const place = typed && isTypedPath(typed) ? typedPath(folder, typed) : undefined;
    if (folders) {
      if (place) return goTo(place);
      const picked = row();
      return finish(picked?.isDir ? join(picked.location || folder, picked.name) : folder);
    }
    if (!typed) return say(ask.mode === "save" ? "Type a name" : "Pick a file");
    const full = place ?? join(folder, typed);
    if (await isFile(full)) return takeFile(full);
    // Typed text that names a folder goes there, and the name to save stays.
    if (place && (await view.open(full, true))) return setName(ask.mode === "save" ? suggested : "");
    if (ask.mode === "save") return saveAs(full);
    say("No file has that name here");
  }

  async function goTo(place: string) {
    if (await view.open(place, true)) {
      setName("");
      setProblem(undefined);
    } else say("There is no folder there");
  }

  function newFolder() {
    const folder = shown();
    if (folder) startJob({ kind: "new", folder, directory: true }, PICKER_VIEW).catch(props.report);
  }

  function peekAt(path: string | undefined) {
    window.clearTimeout(peekTimer);
    const ticket = ++peekTicket;
    setPeek(undefined);
    if (!path || !ask.peek) return;
    peekTimer = window.setTimeout(() => {
      ask.peek!(path)
        .then((found) => ticket === peekTicket && setPeek(found))
        .catch(() => ticket === peekTicket && setPeek({ text: "Perli can't read this one." }));
    }, PEEK_WAIT_MS);
  }

  async function onCursor(at: RowAt | undefined) {
    view.setCursor(at);
    const ticket = ++rowTicket;
    if (!at) {
      setRow(undefined);
      return peekAt(undefined);
    }
    const [found] = await fetchRows(PICKER_VIEW, at.snapshot, at.index, 1).catch(() => []);
    const folder = shown();
    if (ticket !== rowTicket || !found || !folder) return;
    setRow(found);
    if (!found.isDir && !folders) {
      setName(found.name);
      setProblem(undefined);
      setReplacing(undefined);
    }
    peekAt(found.isDir ? undefined : join(found.location || folder, found.name));
  }

  function onOpen(opened: Row) {
    const folder = shown();
    if (!folder) return;
    const path = join(opened.location || folder, opened.name);
    if (opened.isDir) void view.open(path);
    else if (!folders) void takeFile(path);
  }

  /** A file dropped here is picked, in its own folder. A folder dropped opens, or is the answer. */
  async function take(paths: string[]) {
    const first = paths[0];
    if (!first) return;
    if (!(await isFile(first))) return folders ? finish(first) : void view.open(first);
    const parent = parentOf(first);
    if (parent) await view.open(parent, true);
    if (folders) return;
    setName(baseName(first));
    void takeFile(first);
  }

  function onKeyDown(event: KeyboardEvent) {
    const key = event.key.toLowerCase();
    const typing = event.target instanceof HTMLInputElement;
    const run = (action: () => unknown) => {
      event.preventDefault();
      action();
    };
    if (event.ctrlKey && key === "l") {
      run(() => {
        input.focus();
        input.select();
      });
    } else if ((event.altKey && key === "arrowup") || (!typing && key === "backspace")) run(() => view.up());
    else if (event.altKey && key === "arrowleft") run(() => view.back());
    else if (event.altKey && key === "arrowright") run(() => view.forward());
    else if (key === "f5") run(() => view.refresh());
    else if (event.ctrlKey && event.shiftKey && key === "n" && ask.mode !== "open") run(newFolder);
    else if (key === "enter" && event.target === input) run(() => void confirm());
  }

  // The list slides the way the user went: in from the right going into a folder, from the left coming out.
  createEffect(
    on(shown, (now, before) => {
      // A long path keeps the folder on show in sight, with the start scrolled away.
      queueMicrotask(() => (crumbsBox.scrollLeft = crumbsBox.scrollWidth));
      const way = now && !reducedMotion.matches ? slideOf(before, now) : undefined;
      if (!way) return;
      const from = way === "in" ? SLIDE_PX : -SLIDE_PX;
      listBox.animate({ translate: [`${from}px 0`, "0 0"], opacity: [0.35, 1] }, { duration: SLIDE_MS, easing: "cubic-bezier(0.3, 1.1, 0.5, 1)" });
    }),
  );

  onMount(() => {
    setOpenView(view);
    dropped = (paths) => void take(paths);
    close = openSheet(dialog);
    view.openSaved();
    if (ask.mode === "save") {
      input.focus();
      input.setSelectionRange(0, stemEnd(name()));
    }
  });

  onCleanup(() => {
    window.clearTimeout(peekTimer);
    dropped = undefined;
    if (openView() === view) setOpenView(undefined);
    closeView(PICKER_VIEW).catch(console.error);
  });

  const mainLabel = () => {
    if (ask.mode === "open") return "Open";
    if (ask.mode === "save") return "Save";
    const picked = row();
    return picked?.isDir ? `Use “${picked.name}”` : "Use this folder";
  };

  return (
    <dialog
      ref={dialog}
      class="settings picker"
      aria-label={ask.title}
      data-drop={PICKER_PLACE}
      onClose={() => {
        if (!chosen) ask.done(undefined);
        props.onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <h2>{ask.title}</h2>
      <div class="picker-body">
        <nav class="picker-places" aria-label="Places">
          <For each={placeList()}>
            {(place, at) => (
              <button
                class="picker-place"
                style={{ "--at": at() }}
                aria-current={samePath(shown(), place.path) ? "location" : undefined}
                onClick={() => void goTo(place.path)}
              >
                <span class="picker-place-icon" aria-hidden="true">
                  {place.icon}
                </span>
                <span class="picker-place-name">{place.label}</span>
              </button>
            )}
          </For>
        </nav>
        <div class="picker-main">
          <div class="picker-crumbs" ref={crumbsBox}>
            <button class="picker-up" aria-label="Up a folder" disabled={!view.canGoUp()} onClick={() => void view.up()}>
              {ICON_UP}
            </button>
            <For each={shown() ? toCrumbs(shown()!) : []}>
              {(crumb, at) => (
                <>
                  <Show when={at() > 0}>
                    <span class="picker-crumb-gap" aria-hidden="true">
                      ›
                    </span>
                  </Show>
                  <button class="picker-crumb" onClick={() => void view.open(crumb.path)}>
                    {crumb.label}
                  </button>
                </>
              )}
            </For>
          </div>
          <div class="picker-list" ref={listBox}>
            <Show when={view.error()}>
              <p class="picker-error" role="alert">
                {view.error()}
              </p>
            </Show>
            <Show when={view.folder() && view.arrival()} keyed>
              {(_arrival) => (
                <FileList
                  view={PICKER_VIEW}
                  folder={view.folder()!.path}
                  snapshot={view.folder()!.request}
                  rearranged={view.folder()!.rearranged}
                  count={view.folder()!.count}
                  items={view.folder()!.items}
                  selected={view.folder()!.selected}
                  reveal={view.folder()!.reveal}
                  rename={view.folder()!.rename}
                  top={view.folder()!.top}
                  scrollTo={view.folder()!.scrollTo}
                  onLeave={view.keep}
                  thumbs
                  columns={DEFAULT_COLUMNS}
                  columnSet="plain"
                  fixedColumns
                  groups={view.folder()!.groups}
                  largest={view.folder()!.largest}
                  groupLabel={(key) => key}
                  onFold={view.toggleFold}
                  empty={{
                    art: "folder",
                    text: folders ? "No folders in here." : typesText() ? `No ${typesText()} files in here.` : "Nothing in here.",
                    actions: [],
                  }}
                  active={ask.mode !== "save"}
                  layout={view.layout() === "columns" ? "list" : view.layout()}
                  sort={view.sort()}
                  onSort={() => undefined}
                  onDragOut={() => undefined}
                  onOpen={onOpen}
                  onMenu={(event) => event.preventDefault()}
                  onBackgroundMenu={(event) => event.preventDefault()}
                  onHeaderMenu={(event) => event.preventDefault()}
                  onGroup={() => undefined}
                  onRename={(selection, newName) => startJob({ kind: "rename", selection, name: newName }, PICKER_VIEW)}
                  onEditEnd={view.editEnded}
                  onFirstPaint={() => undefined}
                  onSwapped={view.swapped}
                  onEscape={() => close()}
                  onPreview={() => undefined}
                  onCursor={(at) => void onCursor(at)}
                  onOpenBehind={() => undefined}
                  barItems={() => []}
                  connect={view.connectList}
                  onBackgroundDoubleClick={() => void view.up()}
                />
              )}
            </Show>
          </div>
        </div>
      </div>
      <p class="picker-peek" aria-live="polite">
        <Show when={peek()?.colors?.length}>
          <span class="picker-swatches" aria-hidden="true">
            <For each={peek()!.colors}>{(color) => <span class="picker-swatch" style={{ background: color }} />}</For>
          </span>
        </Show>
        {peek()?.text ?? (typesText() && !folders ? `Shows folders and ${typesText()} files` : "")}
      </p>
      <Show when={replacing()}>
        {(asking) => (
          <div class="picker-replace" role="alert">
            <p>
              Replace “{baseName(asking().path)}”? {asking().facts}
            </p>
            <button ref={keep} class="job-choice" onClick={() => (setReplacing(undefined), input.focus())}>
              Keep it
            </button>
            <button class="job-choice" data-main onClick={() => finish(asking().path, true)}>
              Replace
            </button>
          </div>
        )}
      </Show>
      <div class="picker-foot">
        <Show when={ask.mode !== "open"}>
          <button class="job-choice" onClick={newFolder}>
            New folder
          </button>
        </Show>
        <label class="picker-name" data-shake={shake() % 2 ? "a" : shake() ? "b" : undefined}>
          <span>{folders ? "Go to" : ask.mode === "save" ? "Name" : "File"}</span>
          <input
            ref={input}
            spellcheck={false}
            value={name()}
            placeholder={folders ? "Type a path, or pick a folder" : "Type a name or a path"}
            aria-invalid={problem() ? "true" : undefined}
            onInput={(event) => {
              setName(event.currentTarget.value);
              setProblem(undefined);
              setReplacing(undefined);
            }}
          />
        </label>
        <button class="job-choice" onClick={() => close()}>
          Cancel
        </button>
        <button class="job-choice" data-main onClick={() => void confirm()}>
          {mainLabel()}
        </button>
      </div>
      <p class="picker-problem" role="status">
        {problem()}
      </p>
    </dialog>
  );
}
