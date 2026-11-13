import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import {
  binUsage,
  driveSpace,
  ejectDrive,
  fetchPictureFile,
  forgetRecent,
  listPlaces,
  openDevice,
  onDrivesChanged,
  openFile,
  reachable,
  recentFiles,
  unlockDrive,
  type DriveSpace,
  type Places,
  type Recent,
  type Tag,
  type Thumb,
} from "../../api";
import { ago } from "../../ui/dates";
import { formatSize } from "../../ui/format";
import { draw } from "../preview/QuickPreview";
import { rememberRecent, servers } from "../reach/reach";
import { landed } from "../fileops/landed";
import { TAG_DROP, tagColor, tagQuery, tags } from "../tags/tags";
import type { FolderView } from "../navigation/folderView";
import { BIN_PATH, samePath } from "../navigation/path";
import { byDay, movedTo, placeLabel } from "./placeLists";
import { showsSmart, type SmartFolder } from "../smart/smartList";
import {
  foldedSections,
  hiddenSections,
  lookOf,
  movePinned,
  pinned,
  setPinned,
  smartFolders,
  toggleFolded,
  type SectionId,
} from "./saved";
import "./sidebar.css";

const ICON_DRIVE = "";
const ICON_BIN = "";
export const ICON_FOLDER = "";
const ICON_FILE = "";
const ICON_CHEVRON = "";

export const FOLDERS: Record<string, { label: string; icon: string }> = {
  home: { label: "Home", icon: "" },
  desktop: { label: "Desktop", icon: "" },
  documents: { label: "Documents", icon: "" },
  downloads: { label: "Downloads", icon: "" },
  pictures: { label: "Pictures", icon: "" },
  music: { label: "Music", icon: "" },
  videos: { label: "Videos", icon: "" },
};

const ICON_SMART = "\uE71C";
const ICON_EJECT = "\uF847";
const ICON_REMOVABLE = "\uE88E";
const ICON_PHONE = "\uE8EA";
const ICON_NETWORK = "";
const ICON_CLOUD = "";
const ICON_LOCK = "\uE72E";

const FULL_SHARE = 0.9;
/** How long a drive's bar takes to make its wave. */
const WAVE_MS = 1200;
/** How many recent files the sidebar lists. */
const RECENT_COUNT = 10;
/** How far a pinned place moves under the pointer before it is being dragged, not clicked. */
const DRAG_START = 4;
const GLIDE = { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
/** Cloud folders wear the icon their sync app gave them, drawn this many pixels across. */
const PICTURE_EDGE = 16;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** What a network place's dot says on hover. */
const reachText = (answers: boolean | null | undefined) =>
  answers == null ? "checking it answers" : answers ? "answering" : "not answering";

type PlaceMenu = (event: MouseEvent, path: string) => void;

/** The glyph and color a folder shows, with its own look over the usual one. */
export function folderGlyph(path: string, icon = ICON_FOLDER) {
  const look = lookOf(path);
  return { icon: look?.icon ?? icon, color: look?.color === undefined ? undefined : tagColor(look.color) };
}

function Place(props: {
  view: FolderView;
  path: string;
  label: string;
  icon: string;
  color?: string;
  onMenu: PlaceMenu;
  /** Set for what is not a folder to browse, such as a recent file. */
  onOpen?: () => void;
  space?: DriveSpace;
  /** A copy or a move just landed on this drive. */
  wave?: boolean;
  /** Set for a drive that can be ejected. */
  onEject?: () => void;
  /** How full, from 0 to 1, as a ring round the icon. */
  ring?: number;
  /** Said on hover, after the label. */
  about?: string;
  /** A pinned place, which drags or Alt+arrows into a new order. */
  pin?: boolean;
  /** For a place on another computer: it answers, it doesn't, or null while asking. */
  reach?: boolean | null;
  /** A small glyph after the label, such as a lock. */
  badge?: string;
  /** Its own icon, drawn in place of the glyph. */
  picture?: Thumb | null;
}) {
  const used = () => (props.space ? 1 - props.space.free / props.space.total : 0);
  return (
    <li class="place-item" data-ejects={props.onEject ? "" : undefined} data-pin={props.pin ? props.path : undefined}>
      <button
        class="place"
        data-drop={props.onOpen ? undefined : props.path}
        aria-current={samePath(props.view.folder()?.path, props.path) ? "location" : undefined}
        onClick={() => (props.onOpen ? props.onOpen() : props.view.open(props.path))}
        onContextMenu={(event) => props.onMenu(event, props.path)}
        aria-label={props.about ? `${props.label}, ${props.about}` : undefined}
      >
        <span
          class="place-icon"
          aria-hidden="true"
          data-ring={props.ring === undefined ? undefined : ""}
          data-full={props.ring !== undefined && props.ring >= FULL_SHARE ? "" : undefined}
          style={{ color: props.color, "--ring": props.ring }}
        >
          <Show when={props.picture} keyed fallback={props.icon}>
            {(picture) => <canvas class="place-picture" ref={(canvas) => draw(canvas, picture)} />}
          </Show>
        </span>
        <span class="place-label">{props.label}</span>
        <Show when={props.badge}>
          <span class="place-badge" aria-hidden="true">
            {props.badge}
          </span>
        </Show>
        <Show when={props.reach !== undefined}>
          <span
            class="place-reach"
            aria-hidden="true"
            data-reach={props.reach === null ? "asking" : props.reach ? "yes" : "no"}
          />
        </Show>
        <Show when={props.space}>
          {(space) => (
            <>
              <span class="place-free">{formatSize(space().free)} free</span>
              <span class="place-bar" role="presentation" data-wave={props.wave ? "" : undefined}>
                <span
                  class="place-used"
                  classList={{ "place-used-full": used() >= FULL_SHARE }}
                  style={{ transform: `scaleX(${used()})`, "--used": used() }}
                />
              </span>
            </>
          )}
        </Show>
      </button>
      <Show when={props.onEject}>
        <button class="place-eject" aria-label={`Eject ${props.label}`} onClick={() => props.onEject?.()}>
          {ICON_EJECT}
        </button>
      </Show>
    </li>
  );
}

/** A part of the sidebar under a heading, which folds away on a click. */
function Section(props: { id: SectionId; label: string; children: JSX.Element }) {
  const folded = () => foldedSections().includes(props.id);
  return (
    <Show when={!hiddenSections().includes(props.id)}>
      <section class="place-section" aria-label={props.label}>
        <button
          class="place-heading"
          aria-expanded={!folded()}
          onClick={() => toggleFolded(props.id)}
        >
          {props.label}
          <span class="place-chevron" aria-hidden="true">
            {ICON_CHEVRON}
          </span>
        </button>
        {/* Kept in place while folded, so it can spring open and shut. */}
        <div class="place-fold" classList={{ "place-folded": folded() }} inert={folded() || undefined}>
          <ul>{props.children}</ul>
        </div>
      </section>
    </Show>
  );
}

export function Sidebar(props: {
  view: FolderView;
  onMenu: PlaceMenu;
  /** `forget` takes the item off Windows' recent list. */
  onRecentMenu: (event: MouseEvent, recent: Recent, forget: () => void) => void;
  onServerMenu: (event: MouseEvent, server: string) => void;
  onSectionMenu: (event: MouseEvent) => void;
  /** Shows every file that has the tag. */
  onTag: (tag: Tag) => void;
  onTagMenu: (event: MouseEvent, tag: Tag) => void;
  onSmart: (smart: SmartFolder) => void;
  onSmartMenu: (event: MouseEvent, smart: SmartFolder) => void;
  /** The places were read again. */
  onPlaces: (places: Places) => void;
  report: (failure: unknown) => void;
}) {
  const [places, setPlaces] = createSignal<Places>();
  const [spaces, setSpaces] = createSignal<Record<string, DriveSpace>>({});
  const [recent, setRecent] = createSignal<Recent[]>([]);
  const [bin, setBin] = createSignal<{ size: number; limit: number | null }>();
  /** Whether each server and network drive answers. Missing while the first ask is out. */
  const [reach, setReach] = createSignal<Record<string, boolean>>({});
  const askingReach = new Set<string>();
  const [pictures, setPictures] = createSignal<Record<string, Thumb | null>>({});
  const readBin = () => binUsage().then(setBin).catch(console.error);
  const asking = new Set<string>();
  /** The drives whose bars are making a wave. */
  const [waving, setWaving] = createSignal<string[]>([]);
  let waveTimer: number | undefined;
  let nav!: HTMLElement;
  let glide!: HTMLSpanElement;

  function moveGlide(event: PointerEvent) {
    const place = (event.target as HTMLElement).closest(".place");
    // A held pin wears its own look, so the hover pill would only trail behind it.
    if (!place || nav.querySelector("[data-dragging]")) return;

    const top = place.getBoundingClientRect().top - nav.getBoundingClientRect().top;
    const hidden = !glide.classList.contains("place-glide-on");
    // Appearing should fade in on the spot, not fly over from the last place.
    if (hidden) glide.style.transition = "none";
    glide.style.transform = `translateY(${top}px)`;
    if (hidden) void glide.offsetHeight;
    glide.style.transition = "";
    glide.classList.add("place-glide-on");
  }

  /** Each drive answers on its own, so a slow network drive holds up only its own bar. */
  function readSpaces() {
    for (const { path } of places()?.drives ?? []) {
      if (asking.has(path)) continue;
      asking.add(path);
      driveSpace(path)
        .then((space) => space.total > 0 && setSpaces({ ...spaces(), [path]: space }))
        // An empty card reader or a lost drive has nothing to show.
        .catch(() => undefined)
        .finally(() => asking.delete(path));
    }
  }

  // A job that changed a drive shows there at once: its bar makes a wave and is measured again.
  createEffect(
    on(
      landed,
      (job) => {
        const drives = (places()?.drives ?? [])
          .map((drive) => drive.path)
          .filter((path) => job?.folders.some((folder) => folder.toLowerCase().startsWith(path.toLowerCase())));
        readBin();
        if (drives.length === 0) return;
        readSpaces();
        setWaving(drives);
        window.clearTimeout(waveTimer);
        waveTimer = window.setTimeout(() => setWaving([]), WAVE_MS);
      },
      { defer: true },
    ),
  );
  onCleanup(() => window.clearTimeout(waveTimer));

  /** Files open in other apps, so coming back to Perli is when the list may have changed. */
  const readRecent = () =>
    rememberRecent() ? recentFiles(RECENT_COUNT).then(setRecent).catch(console.error) : setRecent([]);
  createEffect(on(rememberRecent, readRecent, { defer: true }));

  /** Each place answers on its own, and an old answer shows until a new one comes. */
  function readReach() {
    const drives = places()?.drives.filter((drive) => drive.network).map((drive) => drive.path) ?? [];
    for (const path of [...servers(), ...drives]) {
      if (askingReach.has(path)) continue;
      askingReach.add(path);
      reachable(path)
        .catch(() => false)
        .then((answers) => setReach({ ...reach(), [path]: answers }))
        .finally(() => askingReach.delete(path));
    }
  }
  createEffect(on(servers, readReach, { defer: true }));

  /** A sync app's own folder icon, read once per folder. */
  function readPictures() {
    for (const { path } of places()?.clouds ?? []) {
      if (path in pictures()) continue;
      setPictures({ ...pictures(), [path]: null });
      fetchPictureFile(path, PICTURE_EDGE * Math.ceil(devicePixelRatio))
        .then((picture) => setPictures({ ...pictures(), [path]: picture }))
        .catch(() => undefined);
    }
  }

  // A phone has no drive letter, so nothing says when one is plugged in. Coming back to Perli
  // after plugging it in is when it shows. A server that woke up gets its dot back then too.
  const onFocus = () => {
    readPlaces();
    readRecent();
    readBin();
  };
  const readPlaces = () =>
    listPlaces()
      .then((found) => {
        setPlaces(found);
        props.onPlaces(found);
        readSpaces();
        readReach();
        readPictures();
      })
      .catch(console.error);
  const drivesListener = onDrivesChanged(readPlaces);

  onMount(() => {
    readPlaces();
    readRecent();
    readBin();
    window.addEventListener("focus", onFocus);
  });
  onCleanup(() => {
    drivesListener.then((stop) => stop());
    window.removeEventListener("focus", onFocus);
  });

  const openRecent = (item: Recent) => {
    if (item.isDir) props.view.open(item.path);
    else openFile(item.path).catch(console.error);
  };

  /** Off the list at once, then read again in case Windows kept another shortcut to it. */
  const forget = (item: Recent) => {
    setRecent(recent().filter((kept) => kept !== item));
    forgetRecent(item.path).then(readRecent).catch(props.report);
  };

  /** Runs `change`, then glides each pinned place from where it was to where it is now. */
  function glidePins(change: () => void, held?: Element) {
    const before = [...nav.querySelectorAll<HTMLElement>("[data-pin]")].map(
      (item) => [item, item.getBoundingClientRect().top] as const,
    );
    change();
    if (reducedMotion.matches) return;
    for (const [item, top] of before) {
      const shift = top - item.getBoundingClientRect().top;
      if (shift && item !== held) item.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], GLIDE);
    }
  }

  /** Alt+Up and Alt+Down move a focused pinned place, before they can mean Up a folder. */
  function nudgePin(event: KeyboardEvent) {
    const path = (event.target as HTMLElement).closest<HTMLElement>("[data-pin]")?.dataset.pin;
    if (!path || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    event.stopPropagation();
    glidePins(() => movePinned(path, event.key === "ArrowUp" ? -1 : 1));
  }

  /**
   * A pinned place follows the pointer, and the others make way as it passes them. Pointer
   * events, not HTML drag and drop, since the window takes those for files.
   */
  function dragPin(down: PointerEvent) {
    const target = down.target as HTMLElement;
    const item = target.closest<HTMLElement>("[data-pin]");
    if (!item || down.button !== 0 || target.closest(".place-eject")) return;
    const path = item.dataset.pin!;
    const grab = down.clientY - item.getBoundingClientRect().top;
    let dragging = false;

    const move = (event: PointerEvent) => {
      if (!dragging && Math.abs(event.clientY - down.clientY) < DRAG_START) return;
      if (!dragging) glide.classList.remove("place-glide-on");
      dragging = true;
      item.dataset.dragging = "";
      const passed = [...nav.querySelectorAll<HTMLElement>("[data-pin]")].filter((other) => {
        const box = other.getBoundingClientRect();
        return other !== item && event.clientY > box.top + box.height / 2;
      }).length;
      if (pinned()[passed] !== path) glidePins(() => setPinned(movedTo(pinned(), path, passed)), item);
      item.style.transform = "";
      // The list clips what leaves it, so the held place stops at its ends.
      const list = item.parentElement!.getBoundingClientRect();
      const box = item.getBoundingClientRect();
      const top = Math.min(Math.max(event.clientY - grab, list.top), list.bottom - box.height);
      item.style.transform = `translateY(${top - box.top}px)`;
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!dragging) return;
      const from = item.style.transform;
      item.style.transform = "";
      delete item.dataset.dragging;
      if (!reducedMotion.matches) item.animate([{ transform: from }, { transform: "none" }], GLIDE);
      // Letting go would also click the place under the pointer.
      const swallow = (click: Event) => {
        click.preventDefault();
        click.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  return (
    <nav
      ref={nav}
      class="places"
      aria-label="Places"
      onPointerOver={moveGlide}
      onPointerDown={dragPin}
      onKeyDown={nudgePin}
      onPointerLeave={() => glide.classList.remove("place-glide-on")}
      // Headings and empty space both open the sections menu, so hiding every section never
      // strands it. Places handle their own right-click first.
      onContextMenu={(event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        props.onSectionMenu(event);
      }}
    >
      <span ref={glide} class="place-glide" />
      <Show when={pinned().length}>
        <Section id="pinned" label="Pinned">
          <For each={pinned()}>
            {(path) => (
              <Place
                view={props.view}
                path={path}
                label={placeLabel(path)}
                pin
                onMenu={props.onMenu}
                icon={folderGlyph(path).icon}
                color={folderGlyph(path).color}
              />
            )}
          </For>
        </Section>
      </Show>
      <Section id="places" label="Places">
        <For each={places()?.folders}>
          {(folder) => (
            <Place
              view={props.view}
              path={folder.path}
              onMenu={props.onMenu}
              label={FOLDERS[folder.kind].label}
              icon={folderGlyph(folder.path, FOLDERS[folder.kind].icon).icon}
              color={folderGlyph(folder.path, FOLDERS[folder.kind].icon).color}
            />
          )}
        </For>
        <Show when={places()}>
          <Place
            view={props.view}
            path={BIN_PATH}
            label="Recycle Bin"
            icon={ICON_BIN}
            onMenu={props.onMenu}
            ring={bin()?.limit ? Math.min(1, bin()!.size / bin()!.limit!) : undefined}
            about={bin() && (bin()!.limit ? `${formatSize(bin()!.size)} of ${formatSize(bin()!.limit!)}` : formatSize(bin()!.size))}
          />
        </Show>
      </Section>
      <Show when={smartFolders().length}>
        <Section id="smart" label="Smart folders">
          <For each={smartFolders()}>
            {(smart) => (
              <li>
                <button
                  class="place place-smart"
                  aria-current={
                    showsSmart(smart, {
                      folder: props.view.folder()?.path,
                      query: props.view.query(),
                      scope: props.view.scope(),
                      filter: props.view.filterForm(),
                    })
                      ? "location"
                      : undefined
                  }
                  aria-description={`A saved search and filter of ${smart.folder}. It only shows files, and moves none.`}
                  onClick={() => props.onSmart(smart)}
                  onContextMenu={(event) => props.onSmartMenu(event, smart)}
                >
                  <span class="place-icon" aria-hidden="true">
                    {ICON_SMART}
                  </span>
                  <span class="place-label">{smart.name}</span>
                </button>
              </li>
            )}
          </For>
        </Section>
      </Show>
      <Show when={rememberRecent() && recent().length}>
        <Section id="recent" label="Recent">
          <For each={byDay(recent(), new Date())}>
            {(day) => (
              <>
                <li class="place-day">{day.label}</li>
                <For each={day.items}>
                  {(item) => (
                    <Place
                      view={props.view}
                      path={item.path}
                      label={item.name}
                      icon={item.isDir ? ICON_FOLDER : ICON_FILE}
                      about={`opened ${ago(item.opened, Date.now())}`}
                      onOpen={() => openRecent(item)}
                      onMenu={(event) => props.onRecentMenu(event, item, () => forget(item))}
                    />
                  )}
                </For>
              </>
            )}
          </For>
        </Section>
      </Show>
      <Show when={tags().length}>
        <Section id="tags" label="Tags">
          <For each={tags()}>
            {(tag) => (
              <li>
                <button
                  class="place place-tag"
                  data-drop={TAG_DROP + tag.id}
                  aria-current={props.view.query().toLowerCase() === tagQuery(tag.name).toLowerCase() ? "location" : undefined}
                  aria-description="Shows every file with this tag. Drop files here to tag them."
                  onClick={() => props.onTag(tag)}
                  onContextMenu={(event) => props.onTagMenu(event, tag)}
                >
                  <span class="place-icon" aria-hidden="true">
                    <span class="tag-dot place-tag-dot" style={{ background: tagColor(tag.color) }} />
                  </span>
                  <span class="place-label">{tag.name}</span>
                </button>
              </li>
            )}
          </For>
        </Section>
      </Show>
      <Show when={places()?.clouds.length}>
        <Section id="cloud" label="Cloud">
          <For each={places()?.clouds}>
            {(cloud) => (
              <Place
                view={props.view}
                path={cloud.path}
                label={cloud.name}
                onMenu={props.onMenu}
                icon={folderGlyph(cloud.path, ICON_CLOUD).icon}
                color={folderGlyph(cloud.path, ICON_CLOUD).color}
                // A look the user gave the folder wins over the sync app's icon.
                picture={lookOf(cloud.path) ? undefined : pictures()[cloud.path]}
              />
            )}
          </For>
        </Section>
      </Show>
      <Show when={servers().length}>
        <Section id="network" label="Network">
          <For each={servers()}>
            {(server) => (
              <Place
                view={props.view}
                path={server}
                label={server.slice(2)}
                icon={ICON_NETWORK}
                reach={reach()[server] ?? null}
                about={reachText(reach()[server])}
                onMenu={(event) => props.onServerMenu(event, server)}
              />
            )}
          </For>
        </Section>
      </Show>
      <Section id="drives" label="Drives">
        <For each={places()?.drives}>
          {(drive) => (
            <Place
              view={props.view}
              path={drive.path}
              label={drive.name}
              icon={drive.network ? ICON_NETWORK : drive.removable ? ICON_REMOVABLE : ICON_DRIVE}
              badge={drive.encrypted ? ICON_LOCK : undefined}
              reach={drive.network ? (reach()[drive.path] ?? null) : undefined}
              about={
                drive.locked
                  ? "locked by BitLocker. Click to unlock it"
                  : drive.encrypted
                    ? "encrypted with BitLocker"
                    : drive.network
                      ? reachText(reach()[drive.path])
                      : undefined
              }
              onOpen={drive.locked ? () => unlockDrive(drive.path).catch(props.report) : undefined}
              onMenu={props.onMenu}
              space={spaces()[drive.path]}
              wave={waving().includes(drive.path)}
              onEject={drive.removable ? () => ejectDrive(drive.path).catch(props.report) : undefined}
            />
          )}
        </For>
        <For each={places()?.devices}>
          {(device) => (
            <Place
              view={props.view}
              path={device.id}
              label={device.name}
              icon={ICON_PHONE}
              onOpen={() => openDevice(device.id).catch(props.report)}
              onMenu={(event) => event.preventDefault()}
            />
          )}
        </For>
      </Section>
    </nav>
  );
}
