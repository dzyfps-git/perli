import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { driveSpace, listPlaces, onDrivesChanged, type DriveSpace, type Places } from "../../api";
import { formatSize } from "../../ui/format";
import type { FolderView } from "../navigation/folderView";
import { BIN_PATH, samePath } from "../navigation/path";
import "./sidebar.css";

const ICON_DRIVE = "";
const ICON_BIN = "";

const FOLDERS: Record<string, { label: string; icon: string }> = {
  home: { label: "Home", icon: "" },
  desktop: { label: "Desktop", icon: "" },
  documents: { label: "Documents", icon: "" },
  downloads: { label: "Downloads", icon: "" },
  pictures: { label: "Pictures", icon: "" },
  music: { label: "Music", icon: "" },
  videos: { label: "Videos", icon: "" },
};

const FULL_SHARE = 0.9;

type PlaceMenu = (event: MouseEvent, path: string) => void;

function Place(props: {
  view: FolderView;
  path: string;
  label: string;
  icon: string;
  onMenu: PlaceMenu;
  space?: DriveSpace;
}) {
  const used = () => (props.space ? 1 - props.space.free / props.space.total : 0);
  return (
    <li>
      <button
        class="place"
        aria-current={samePath(props.view.folder()?.path, props.path) ? "location" : undefined}
        onClick={() => props.view.open(props.path)}
        onContextMenu={(event) => props.onMenu(event, props.path)}
      >
        <span class="place-icon" aria-hidden="true">
          {props.icon}
        </span>
        <span class="place-label">{props.label}</span>
        <Show when={props.space}>
          {(space) => (
            <>
              <span class="place-free">{formatSize(space().free)} free</span>
              <span class="place-bar" role="presentation">
                <span
                  class="place-used"
                  classList={{ "place-used-full": used() >= FULL_SHARE }}
                  style={{ transform: `scaleX(${used()})` }}
                />
              </span>
            </>
          )}
        </Show>
      </button>
    </li>
  );
}

export function Sidebar(props: { view: FolderView; onMenu: PlaceMenu }) {
  const [places, setPlaces] = createSignal<Places>();
  const [spaces, setSpaces] = createSignal<Record<string, DriveSpace>>({});
  const asking = new Set<string>();
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

  const readPlaces = () => listPlaces().then(setPlaces).then(readSpaces).catch(console.error);
  const drivesListener = onDrivesChanged(readPlaces);

  onMount(() => {
    readPlaces();
    window.addEventListener("focus", readSpaces);
  });
  onCleanup(() => {
    drivesListener.then((stop) => stop());
    window.removeEventListener("focus", readSpaces);
  });

  return (
    <nav
      ref={nav}
      class="places"
      aria-label="Places"
      onPointerOver={moveGlide}
      onPointerLeave={() => glide.classList.remove("place-glide-on")}
    >
      <span ref={glide} class="place-glide" />
      <ul>
        <For each={places()?.folders}>
          {(folder) => <Place view={props.view} path={folder.path} onMenu={props.onMenu} {...FOLDERS[folder.kind]} />}
        </For>
        <Show when={places()}>
          <Place view={props.view} path={BIN_PATH} label="Recycle Bin" icon={ICON_BIN} onMenu={props.onMenu} />
        </Show>
      </ul>
      <ul>
        <For each={places()?.drives}>
          {(drive) => (
            <Place
              view={props.view}
              path={drive.path}
              label={drive.name}
              icon={ICON_DRIVE}
              onMenu={props.onMenu}
              space={spaces()[drive.path]}
            />
          )}
        </For>
      </ul>
    </nav>
  );
}
