import { createSignal, For, onMount } from "solid-js";
import { listPlaces, type Places } from "../../api";
import type { FolderView } from "../navigation/folderView";
import { samePath } from "../navigation/path";
import "./sidebar.css";

const ICON_DRIVE = "";

const FOLDERS: Record<string, { label: string; icon: string }> = {
  home: { label: "Home", icon: "" },
  desktop: { label: "Desktop", icon: "" },
  documents: { label: "Documents", icon: "" },
  downloads: { label: "Downloads", icon: "" },
  pictures: { label: "Pictures", icon: "" },
  music: { label: "Music", icon: "" },
  videos: { label: "Videos", icon: "" },
};

type PlaceMenu = (event: MouseEvent, path: string) => void;

function Place(props: { view: FolderView; path: string; label: string; icon: string; onMenu: PlaceMenu }) {
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
      </button>
    </li>
  );
}

export function Sidebar(props: { view: FolderView; onMenu: PlaceMenu }) {
  const [places, setPlaces] = createSignal<Places>();
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

  // ponytail: read once, so a newly plugged drive needs a restart. Watch for drive changes in Phase 3.
  onMount(() => {
    listPlaces().then(setPlaces).catch(console.error);
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
      </ul>
      <ul>
        <For each={places()?.drives}>
          {(drive) => (
            <Place view={props.view} path={drive.path} label={drive.name} icon={ICON_DRIVE} onMenu={props.onMenu} />
          )}
        </For>
      </ul>
    </nav>
  );
}
