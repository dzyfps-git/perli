import { createEffect, createResource, For, on, onMount, Show } from "solid-js";
import { clipboardHasContent, newTypes, ownTemplates } from "../../api";
import { kindOf } from "../filelist/fileKinds";
import "./fileops.css";

/** What the user picked from the gallery. */
export type NewPick =
  | { kind: "folder" }
  | { kind: "file" }
  | { kind: "clipboard" }
  | { kind: "type"; extension: string }
  | { kind: "own"; name: string }
  | { kind: "templates" };

interface Tile {
  label: string;
  /** The small line under the label, such as the extension. */
  note?: string;
  icon: string;
  pick: NewPick;
  disabled?: boolean;
}

const EDGE_GAP = 8;
const COLUMNS = 4;
const ICON_OPEN = "";

/**
 * New things to make, as a small gallery of tiles with their icons: a folder, a blank file, the
 * clipboard as a file, every type Windows offers, and the user's own templates.
 */
export function NewGallery(props: { x: number; y: number; onPick: (pick: NewPick) => void; onClose: () => void }) {
  let box!: HTMLDivElement;
  const [found] = createResource(() => Promise.all([newTypes(), ownTemplates(), clipboardHasContent()]));

  const starts = (): Tile[] => [
    { label: "Folder", icon: kindOf("Folder", true), pick: { kind: "folder" } },
    { label: "File", note: "Name it as you like", icon: kindOf("File", false), pick: { kind: "file" } },
    {
      label: "From clipboard",
      note: found()?.[2] ? "Text or picture" : "Nothing to use",
      icon: kindOf("x.png", false),
      pick: { kind: "clipboard" },
      disabled: !found()?.[2],
    },
  ];
  const types = (): Tile[] =>
    (found()?.[0] ?? []).map(({ extension, name }) => ({
      label: name,
      note: `.${extension}`,
      icon: kindOf(`x.${extension}`, false),
      pick: { kind: "type", extension },
    }));
  const own = (): Tile[] =>
    (found()?.[1] ?? []).map((name) => ({ label: name, icon: kindOf(name, false), pick: { kind: "own", name } }));

  function pick(tile: Tile) {
    box.hidePopover();
    props.onPick(tile.pick);
  }

  /** Arrow keys walk the tiles, a row at a time up and down. */
  function walk(event: KeyboardEvent) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS }[event.key];
    if (!step) return;
    event.preventDefault();
    const tiles = [...box.querySelectorAll<HTMLButtonElement>(".new-tile:enabled")];
    const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
    tiles[Math.max(0, Math.min(tiles.length - 1, at + step))]?.focus();
  }

  /** Opens where it was asked for, kept inside the window. */
  function place() {
    const { width, height } = box.getBoundingClientRect();
    const left = Math.max(EDGE_GAP, Math.min(props.x, innerWidth - width - EDGE_GAP));
    const top = Math.max(EDGE_GAP, Math.min(props.y, innerHeight - height - EDGE_GAP));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }

  onMount(() => {
    box.showPopover();
    place();
    box.querySelector<HTMLButtonElement>(".new-tile")?.focus();
  });
  // The types and templates come a moment later and make it taller, so it is placed again.
  createEffect(on(found, place, { defer: true }));

  /** `first` counts the tiles before these, so they all come in one after another. */
  const Tiles = (group: { tiles: Tile[]; first: number }) => (
    <div class="new-tiles">
        <For each={group.tiles}>
          {(tile, at) => (
            <button
              class="new-tile"
              disabled={tile.disabled}
              style={{ "--at": group.first + at() }}
              onClick={() => pick(tile)}
            >
              <span class="file-icon" data-kind={tile.icon} aria-hidden="true" />
              <span class="new-label">{tile.label}</span>
              <Show when={tile.note}>
                <span class="new-note">{tile.note}</span>
              </Show>
            </button>
          )}
        </For>
    </div>
  );

  return (
    <div
      ref={box}
      class="new-gallery"
      popover="auto"
      role="dialog"
      aria-label="New"
      onKeyDown={walk}
      onToggle={(event) => (event as ToggleEvent).newState === "closed" && props.onClose()}
    >
      <section class="new-section" aria-label="New">
        <h3>New</h3>
        <Tiles tiles={starts()} first={0} />
      </section>
      <Show when={types().length > 0}>
        <section class="new-section" aria-label="Types">
          <h3>Types</h3>
          <Tiles tiles={types()} first={3} />
        </section>
      </Show>
      <section class="new-section" aria-label="Your templates">
        <h3>Your templates</h3>
        <Show when={own().length > 0} fallback={<p class="new-empty">Save any file as a template from its menu, and it shows here.</p>}>
          <Tiles tiles={own()} first={3 + types().length} />
        </Show>
        <button class="new-open" onClick={() => pick({ label: "", icon: "", pick: { kind: "templates" } })}>
          <span class="new-open-icon" aria-hidden="true">
            {ICON_OPEN}
          </span>
          Open templates folder
        </button>
      </section>
    </div>
  );
}
