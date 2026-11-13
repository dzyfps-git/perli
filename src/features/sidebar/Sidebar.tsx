import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import {
  driveSpace,
  listPlaces,
  onDrivesChanged,
  openFile,
  recentFiles,
  type DriveSpace,
  type Places,
  type Recent,
} from "../../api";
import { formatSize } from "../../ui/format";
import { landed } from "../fileops/landed";
import { tagColor } from "../tags/tags";
import type { FolderView } from "../navigation/folderView";
import { BIN_PATH, samePath } from "../navigation/path";
import { placeLabel } from "./placeLists";
import { foldedSections, hiddenSections, lookOf, pinned, toggleFolded, type SectionId } from "./saved";
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

const ICON_NETWORK = "";
const ICON_CLOUD = "";

const FULL_SHARE = 0.9;
/** How long a drive's bar takes to make its wave. */
const WAVE_MS = 1200;
/** How many recent files the sidebar lists. */
const RECENT_COUNT = 10;

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
}) {
  const used = () => (props.space ? 1 - props.space.free / props.space.total : 0);
  return (
    <li>
      <button
        class="place"
        data-drop={props.onOpen ? undefined : props.path}
        aria-current={samePath(props.view.folder()?.path, props.path) ? "location" : undefined}
        onClick={() => (props.onOpen ? props.onOpen() : props.view.open(props.path))}
        onContextMenu={(event) => props.onMenu(event, props.path)}
      >
        <span class="place-icon" aria-hidden="true" style={{ color: props.color }}>
          {props.icon}
        </span>
        <span class="place-label">{props.label}</span>
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
  onRecentMenu: (event: MouseEvent, recent: Recent) => void;
  onSectionMenu: (event: MouseEvent) => void;
}) {
  const [places, setPlaces] = createSignal<Places>();
  const [spaces, setSpaces] = createSignal<Record<string, DriveSpace>>({});
  const [recent, setRecent] = createSignal<Recent[]>([]);
  const asking = new Set<string>();
  /** The drives whose bars are making a wave. */
  const [waving, setWaving] = createSignal<string[]>([]);
  let waveTimer: number | undefined;
  let nav!: HTMLElement;
  let glide!: HTMLSpanElement;

  function moveGlide(event: PointerEvent) {
    const place = (event.target as HTMLElement).closest(".place");
    if (!place) return;

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
  const readRecent = () => recentFiles(RECENT_COUNT).then(setRecent).catch(console.error);
  const onFocus = () => {
    readSpaces();
    readRecent();
  };
  const readPlaces = () => listPlaces().then(setPlaces).then(readSpaces).catch(console.error);
  const drivesListener = onDrivesChanged(readPlaces);

  onMount(() => {
    readPlaces();
    readRecent();
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

  return (
    <nav
      ref={nav}
      class="places"
      aria-label="Places"
      onPointerOver={moveGlide}
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
          <Place view={props.view} path={BIN_PATH} label="Recycle Bin" icon={ICON_BIN} onMenu={props.onMenu} />
        </Show>
      </Section>
      <Show when={recent().length}>
        <Section id="recent" label="Recent">
          <For each={recent()}>
            {(item) => (
              <Place
                view={props.view}
                path={item.path}
                label={item.name}
                icon={item.isDir ? ICON_FOLDER : ICON_FILE}
                onOpen={() => openRecent(item)}
                onMenu={(event) => props.onRecentMenu(event, item)}
              />
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
              icon={drive.network ? ICON_NETWORK : ICON_DRIVE}
              onMenu={props.onMenu}
              space={spaces()[drive.path]}
              wave={waving().includes(drive.path)}
            />
          )}
        </For>
      </Section>
    </nav>
  );
}
