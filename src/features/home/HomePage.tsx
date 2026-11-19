import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { driveSpace, fetchPictureFile, recentFiles, type DriveSpace, type Places, type Recent, type Thumb } from "../../api";
import { formatSize } from "../../ui/format";
import { morph } from "../../ui/morph";
import { saved, stored } from "../filelist/prefs";
import { baseName, parentOf } from "../navigation/path";
import { draw } from "../preview/QuickPreview";
import { clock } from "../preview/playback";
import { rememberRecent } from "../reach/reach";
import { SpaceMini } from "../space/SpaceMini";
import {
  cleanSections,
  daysToFull,
  fullText,
  HOME_SECTIONS,
  loggedSpace,
  movedSection,
  readingPlaces,
  startOfDay,
  type HomeSection,
  type HomeSectionId,
  type ReadingStores,
  type SpaceLog,
} from "./home";
import "./home.css";

const ICON_DRIVE = "";
const ICON_REMOVABLE = "";
const ICON_NETWORK = "";
const ICON_FOLDER = "";
const ICON_FILE = "";
const ICON_EJECT = "";
const ICON_FORGET = "";
const ICON_EDIT = "";
const ICON_DONE = "";
const ICON_SHOWN = "";
const ICON_HIDDEN = "";
const ICON_WIDE = "";
const ICON_NARROW = "";
const ICON_GRIP = "";
const ICON_SEARCH = "";
const ICON_RESET = "";

/** A drive with less than this share free says so, calmly. */
const LOW_SHARE = 0.1;
const THUMB_EDGE = 72;
const MOST_TODAY = 12;

const TITLES: Record<HomeSectionId, string> = {
  drives: "Drives",
  space: "Space",
  reading: "Pick up where you left off",
  pinned: "Pinned",
  folders: "Recent folders",
  today: "Opened today",
};

const [sections, setSections] = stored<HomeSection[]>("home-sections", cleanSections(saved("home-sections")));

/** Each drive's free space, a sample a day, by its lowercase path, so a drive filling up can say when it will be full. */
const logsOf = (value: unknown): Record<string, SpaceLog> =>
  value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, SpaceLog] => Array.isArray(entry[1])))
    : {};
const [spaceLog, setSpaceLog] = stored<Record<string, SpaceLog>>("space-log", logsOf(saved("space-log")));

/** The places every viewer keeps, read fresh, since the viewers write them straight to storage. */
const READING_KEYS = { book: "book-places", comic: "comic-pages", pdf: "pdf-pages", timed: "song-resume" } as const;
const readStores = () =>
  Object.fromEntries(Object.entries(READING_KEYS).map(([kind, key]) => [kind, (saved(key) as object | null) ?? {}])) as unknown as ReadingStores;

/** Takes a file off the list by forgetting its place in every viewer. It opens at the start next time. */
function forgetPlace(path: string) {
  for (const key of Object.values(READING_KEYS)) {
    const all = (saved(key) as Record<string, unknown> | null) ?? {};
    if (!(path in all)) continue;
    delete all[path];
    localStorage.setItem(`perli-${key}`, JSON.stringify(all));
  }
}

/**
 * The home page: drives, where reading stopped, pinned and recent folders, and what was opened
 * today. Edit moves, widens and hides its parts. The first nine cards open on 1 to 9, and typing
 * anywhere starts a search.
 */
export function HomePage(props: {
  drives: Places["drives"] | undefined;
  pinned: string[];
  folders: string[];
  onOpen: (path: string) => void;
  onOpenFile: (path: string) => void;
  onMenu: (event: MouseEvent, path: string) => void;
  onEject: (path: string) => void;
  onSearch: (text: string) => void;
  onOpenSpace: () => void;
}) {
  let page!: HTMLElement;
  let searchBox!: HTMLInputElement;
  const [editing, setEditing] = createSignal(false);
  const [spaces, setSpaces] = createSignal<Record<string, DriveSpace>>({});
  const [reading, setReading] = createSignal(readingPlaces(readStores(), clock));
  const [today, setToday] = createSignal<Recent[]>([]);
  const [dragged, setDragged] = createSignal<HomeSectionId>();

  createEffect(() => {
    for (const drive of props.drives ?? []) {
      if (drive.locked || drive.path in spaces()) continue;
      driveSpace(drive.path)
        .then((space) => {
          if (space.total <= 0) return;
          setSpaces({ ...spaces(), [drive.path]: space });
          const key = drive.path.toLowerCase();
          setSpaceLog({ ...spaceLog(), [key]: loggedSpace(spaceLog()[key] ?? [], space.free, Date.now()) });
        })
        .catch(() => undefined);
    }
  });

  createEffect(() => {
    if (!rememberRecent()) return setToday([]);
    const since = startOfDay(Date.now());
    recentFiles(40)
      .then((files) => setToday(files.filter((file) => file.opened >= since).slice(0, MOST_TODAY)))
      .catch(() => setToday([]));
  });

  // The first nine cards answer to 1 to 9, which a small number in their corner tells.
  createEffect(() => {
    sections();
    editing();
    reading();
    today();
    queueMicrotask(() =>
      page?.querySelectorAll<HTMLElement>(".home-card").forEach((card, at) => {
        if (at < 9) card.dataset.key = String(at + 1);
        else delete card.dataset.key;
      }),
    );
  });

  function onKeyDown(event: KeyboardEvent) {
    const typing = (event.target as HTMLElement).closest("input");
    if (typing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "Escape" && editing()) return setEditing(false);
    if (/^[1-9]$/.test(event.key) && !editing()) {
      page.querySelector<HTMLElement>(`.home-card[data-key="${event.key}"]`)?.click();
      return event.preventDefault();
    }
    // The letter lands in the box, which takes the focus before it arrives.
    if (event.key.length === 1 && event.key !== " ") searchBox.focus();
  }

  onMount(() => page.focus({ preventScroll: true }));

  const change = (next: HomeSection[]) => morph(() => setSections(next), "home");
  const toggle = (id: HomeSectionId, part: "hidden" | "wide") =>
    change(sections().map((section) => (section.id === id ? { ...section, [part]: !section[part] } : section)));

  /** A part follows the pointer by its grip, and the others make way as it passes them. */
  function startDrag(event: PointerEvent, id: HomeSectionId) {
    if (event.button !== 0) return;
    const grip = event.currentTarget as HTMLElement;
    grip.setPointerCapture(event.pointerId);
    setDragged(id);
    const move = (moved: PointerEvent) => {
      const under = document.elementFromPoint(moved.clientX, moved.clientY)?.closest<HTMLElement>("[data-part]");
      const target = under?.dataset.part as HomeSectionId | undefined;
      if (!target || target === id) return;
      const list = sections();
      const from = list.findIndex((section) => section.id === id);
      const to = list.findIndex((section) => section.id === target);
      // Going down it lands after the part it passed, going up before it.
      const before = to > from ? list[to + 1]?.id : target;
      change(movedSection(list, id, before));
    };
    const end = () => {
      setDragged(undefined);
      grip.removeEventListener("pointermove", move);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("lostpointercapture", end, { once: true });
  }

  /** Alt and the arrows move a part by its grip, for the keyboard. */
  function onGripKey(event: KeyboardEvent, id: HomeSectionId) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    // Alt+Up is also "up a folder" for the window, which would leave the home page.
    event.stopPropagation();
    const list = sections();
    const at = list.findIndex((section) => section.id === id);
    const before = event.key === "ArrowUp" ? list[at - 1]?.id : list[at + 2]?.id;
    if (event.key === "ArrowUp" && at === 0) return;
    change(movedSection(list, id, before));
    queueMicrotask(() => page.querySelector<HTMLElement>(`[data-part="${id}"] .home-grip`)?.focus());
  }

  const shown = () => sections().filter((section) => editing() || !section.hidden);

  function Part(part: { section: HomeSection; children: JSX.Element; empty: boolean; note: string }) {
    return (
      <section
        class="home-part"
        data-part={part.section.id}
        classList={{ "home-wide": !!part.section.wide, "home-off": !!part.section.hidden, "home-dragged": dragged() === part.section.id }}
        style={{ "view-transition-name": `home-${part.section.id}` }}
        aria-label={TITLES[part.section.id]}
      >
        <header class="home-part-head">
          <Show when={editing()}>
            <button
              class="home-tool home-grip"
              aria-label={`Move ${TITLES[part.section.id]}. Drag, or Alt with the arrows`}
              onPointerDown={(event) => startDrag(event, part.section.id)}
              onKeyDown={(event) => onGripKey(event, part.section.id)}
            >
              {ICON_GRIP}
            </button>
          </Show>
          <h2>{TITLES[part.section.id]}</h2>
          <Show when={editing()}>
            <button
              class="home-tool"
              aria-label={part.section.wide ? "Half width" : "Full width"}
              onClick={() => toggle(part.section.id, "wide")}
            >
              {part.section.wide ? ICON_NARROW : ICON_WIDE}
            </button>
            <button
              class="home-tool"
              aria-label={part.section.hidden ? `Show ${TITLES[part.section.id]}` : `Hide ${TITLES[part.section.id]}`}
              aria-pressed={!part.section.hidden}
              onClick={() => toggle(part.section.id, "hidden")}
            >
              {part.section.hidden ? ICON_HIDDEN : ICON_SHOWN}
            </button>
          </Show>
        </header>
        <Show when={!part.empty} fallback={<p class="home-empty">{part.note}</p>}>
          {part.children}
        </Show>
      </section>
    );
  }

  const Thumbnail = (thumb: { path: string; folder?: boolean }) => {
    const [picture, setPicture] = createSignal<Thumb | null>(null);
    if (!thumb.folder) {
      fetchPictureFile(thumb.path, THUMB_EDGE * Math.ceil(devicePixelRatio))
        .then(setPicture)
        .catch(() => undefined);
    }
    return (
      <span class="home-thumb" aria-hidden="true" data-shown={picture() ? "" : undefined}>
        <Show when={picture()} keyed fallback={thumb.folder ? ICON_FOLDER : ICON_FILE}>
          {(shot) => <canvas ref={(canvas) => draw(canvas, shot)} />}
        </Show>
      </span>
    );
  };

  const FolderCard = (card: { path: string }) => (
    <button
      class="home-card home-folder"
      data-drop={card.path}
      onClick={() => props.onOpen(card.path)}
      onContextMenu={(event) => props.onMenu(event, card.path)}
    >
      <span class="home-icon" aria-hidden="true">
        {ICON_FOLDER}
      </span>
      <span class="home-card-text">
        <span class="home-card-name">{baseName(card.path) || card.path}</span>
        <span class="home-card-about">{parentOf(card.path) ?? ""}</span>
      </span>
    </button>
  );

  /** Each part: whether it has nothing to show, what it says then, and what it shows. */
  const parts: Record<HomeSectionId, { empty: () => boolean; note: () => string; view: () => JSX.Element }> = {
    drives: {
      empty: () => !props.drives?.length,
      note: () => "Drives show here once Windows lists them.",
      view: () => (
        <div class="home-cards home-drives">
          <For each={props.drives}>
            {(drive) => {
              const space = () => spaces()[drive.path];
              const used = () => (space() ? 1 - space()!.free / space()!.total : 0);
              const low = () => !!space() && space()!.free / space()!.total < LOW_SHARE;
              const full = () => {
                const days = daysToFull(spaceLog()[drive.path.toLowerCase()] ?? [], Date.now());
                return days === undefined ? "" : ` · ${fullText(days)}`;
              };
              return (
                <div class="home-drive-wrap">
                  <button
                    class="home-card home-drive"
                    data-drop={drive.locked ? undefined : drive.path}
                    onClick={() => props.onOpen(drive.path)}
                    onContextMenu={(event) => props.onMenu(event, drive.path)}
                  >
                    <span class="home-icon" aria-hidden="true">
                      {drive.network ? ICON_NETWORK : drive.removable ? ICON_REMOVABLE : ICON_DRIVE}
                    </span>
                    <span class="home-card-text">
                      <span class="home-card-name">{drive.name || drive.path}</span>
                      <span class="home-card-about">
                        {drive.locked
                          ? "Locked by BitLocker"
                          : space()
                            ? `${formatSize(space()!.free)} free of ${formatSize(space()!.total)}${low() ? " · running low" : ""}${full()}`
                            : drive.path}
                      </span>
                    </span>
                    <span class="home-bar" data-low={low() ? "" : undefined} style={{ "--used": used() }} aria-hidden="true" />
                  </button>
                  <Show when={drive.removable}>
                    <button class="home-eject" aria-label={`Eject ${drive.name || drive.path}`} onClick={() => props.onEject(drive.path)}>
                      {ICON_EJECT}
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      ),
    },
    space: {
      empty: () => !props.drives?.length,
      note: () => "Space shows what fills each drive once Windows lists them.",
      view: () => <SpaceMini drives={props.drives ?? []} spaces={spaces()} onOpen={props.onOpenSpace} />,
    },
    reading: {
      empty: () => reading().length === 0,
      note: () => "Books, comics, PDFs, films and songs you open in Perli show here, at the place you left them.",
      view: () => (
        <div class="home-cards home-reading">
          <For each={reading()}>
            {(place) => (
              <div class="home-reading-wrap">
                <button class="home-card home-file" onClick={() => props.onOpenFile(place.path)}>
                  <Thumbnail path={place.path} />
                  <span class="home-card-text">
                    <span class="home-card-name">{baseName(place.path)}</span>
                    <span class="home-card-about">{place.where}</span>
                  </span>
                </button>
                <button
                  class="home-forget"
                  aria-label={`Take ${baseName(place.path)} off this list. It opens at the start next time`}
                  onClick={() => {
                    forgetPlace(place.path);
                    morph(() => setReading(readingPlaces(readStores(), clock)), "home");
                  }}
                >
                  {ICON_FORGET}
                </button>
              </div>
            )}
          </For>
        </div>
      ),
    },
    pinned: {
      empty: () => props.pinned.length === 0,
      note: () => "Pin a folder from its menu, and it waits here and in the sidebar.",
      view: () => (
        <div class="home-cards">
          <For each={props.pinned}>{(path) => <FolderCard path={path} />}</For>
        </div>
      ),
    },
    folders: {
      empty: () => props.folders.length === 0,
      note: () => "The folders you go to show here.",
      view: () => (
        <div class="home-cards">
          <For each={props.folders.slice(0, 8)}>{(path) => <FolderCard path={path} />}</For>
        </div>
      ),
    },
    today: {
      empty: () => today().length === 0,
      note: () => rememberRecent() ? "Files you open today, in Perli or another app, show here." : "Recent places are off in the sidebar's menu.",
      view: () => (
        <div class="home-cards home-today">
          <For each={today()}>
            {(file) => (
              <button
                class="home-card home-file"
                onClick={() => (file.isDir ? props.onOpen(file.path) : props.onOpenFile(file.path))}
                onContextMenu={(event) => file.isDir && props.onMenu(event, file.path)}
              >
                <Thumbnail path={file.path} folder={file.isDir} />
                <span class="home-card-text">
                  <span class="home-card-name">{file.name}</span>
                  <span class="home-card-about">
                    {new Date(file.opened).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </span>
                </span>
              </button>
            )}
          </For>
        </div>
      ),
    },
  };

  // Leaving the page while it is being changed keeps the changes, and ends the editing.
  onCleanup(() => setEditing(false));

  return (
    <main ref={page} class="home-page" classList={{ "home-editing": editing() }} tabindex="-1" aria-label="Home page" onKeyDown={onKeyDown}>
      <div class="home-top">
        <label class="home-search">
          <span class="home-search-icon" aria-hidden="true">
            {ICON_SEARCH}
          </span>
          <input
            ref={searchBox}
            type="search"
            placeholder="Search your files"
            aria-label="Search your files"
            spellcheck={false}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.currentTarget.value.trim()) props.onSearch(event.currentTarget.value.trim());
              if (event.key === "Escape") {
                event.currentTarget.value = "";
                page.focus();
              }
            }}
          />
        </label>
        <Show when={editing()}>
          <button class="home-action" onClick={() => change(HOME_SECTIONS.map((section) => ({ ...section })))}>
            <span aria-hidden="true">{ICON_RESET}</span>
            Reset
          </button>
        </Show>
        <button class="home-action" aria-pressed={editing()} onClick={() => setEditing(!editing())}>
          <span aria-hidden="true">{editing() ? ICON_DONE : ICON_EDIT}</span>
          {editing() ? "Done" : "Edit"}
        </button>
      </div>
      <div class="home-parts">
        <For each={shown()}>
          {(section) => {
            const part = parts[section.id];
            return (
              <Part section={section} empty={part.empty()} note={part.note()}>
                {part.view()}
              </Part>
            );
          }}
        </For>
      </div>
    </main>
  );
}
