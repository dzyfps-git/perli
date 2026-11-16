import { createEffect, createResource, createSignal, For, on, onMount, Show } from "solid-js";
import { clipboardHasContent, newTypes, ownTemplates } from "../../api";
import { iconKindOf, kindOf } from "../filelist/fileKinds";
import { iconTheme } from "../filelist/prefs";
import "./fileops.css";

/** What the user picked from the gallery. */
export type NewPick =
  | { kind: "folder" }
  | { kind: "file" }
  | { kind: "write" }
  | { kind: "clipboard" }
  | { kind: "type"; extension: string }
  /** `called` is the name the user gave it first, for a template with `{name}` in it. */
  | { kind: "own"; name: string; called?: string }
  | { kind: "templates" };

interface Tile {
  label: string;
  /** The small line under the label, such as the extension. */
  note?: string;
  icon: string;
  pick: NewPick;
  disabled?: boolean;
  /** Names it first, for a template with `{name}` in it. */
  asks?: boolean;
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
  /** The template being named before it is made. */
  const [asking, setAsking] = createSignal<string>();
  const [called, setCalled] = createSignal("");

  const starts = (): Tile[] => [
    { label: "Folder", icon: kindOf("Folder", true), pick: { kind: "folder" } },
    { label: "File", note: "Name it as you like", icon: kindOf("File", false), pick: { kind: "file" } },
    { label: "Text to write", note: "Name it, then write", icon: kindOf("x.txt", false), pick: { kind: "write" } },
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
      icon: iconKindOf(`x.${extension}`, false, iconTheme().extensions),
      pick: { kind: "type", extension },
    }));
  const own = (): Tile[] =>
    (found()?.[1] ?? []).map(({ name, folder, asks }) => ({
      label: name,
      note: asks ? "Name it first" : folder ? "Folder" : undefined,
      icon: iconKindOf(name, folder, iconTheme().extensions),
      pick: { kind: "own", name },
      asks,
    }));

  function pick(tile: Tile) {
    if (tile.asks && tile.pick.kind === "own") {
      setCalled("");
      return setAsking(tile.pick.name);
    }
    box.hidePopover();
    props.onPick(tile.pick);
  }

  function make(name: string) {
    const typed = called().trim();
    if (!typed) return;
    box.hidePopover();
    props.onPick({ kind: "own", name, called: typed });
  }

  /** Back to the tiles, on the one that asked. */
  function back(name: string) {
    setAsking(undefined);
    const tiles = [...box.querySelectorAll<HTMLButtonElement>(".new-tile")];
    (tiles.find((tile) => tile.dataset.own === name) ?? tiles[0])?.focus();
  }

  /** Arrow keys walk the tiles, a row at a time up and down. */
  function walk(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement) return;
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
  createEffect(on(asking, place, { defer: true }));

  /** `first` counts the tiles before these, so they all come in one after another. */
  const Tiles = (group: { tiles: Tile[]; first: number }) => (
    <div class="new-tiles">
        <For each={group.tiles}>
          {(tile, at) => (
            <button
              class="new-tile"
              disabled={tile.disabled}
              style={{ "--at": group.first + at() }}
              data-own={tile.pick.kind === "own" ? tile.pick.name : undefined}
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
      <Show when={asking()} keyed>
        {(name) => (
          <form
            class="new-naming zip-reveal"
            onSubmit={(event) => {
              event.preventDefault();
              make(name);
            }}
          >
            <h3>Name it</h3>
            <label class="rename-field">
              <span class="new-note">What you type goes where {name} says {"{name}"}.</span>
              <input
                ref={(input) => queueMicrotask(() => input.focus())}
                spellcheck={false}
                value={called()}
                onInput={(event) => setCalled(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  back(name);
                }}
              />
            </label>
            <div class="confirm-buttons">
              <button class="job-choice" type="button" onClick={() => back(name)}>
                Back
              </button>
              <button class="job-choice" type="submit" disabled={!called().trim()}>
                Make it
              </button>
            </div>
          </form>
        )}
      </Show>
      <div class="new-sections" hidden={!!asking()}>
      <section class="new-section" aria-label="New">
        <h3>New</h3>
        <Tiles tiles={starts()} first={0} />
      </section>
      <Show when={types().length > 0}>
        <section class="new-section" aria-label="Types">
          <h3>Types</h3>
          <Tiles tiles={types()} first={4} />
        </section>
      </Show>
      <section class="new-section" aria-label="Your templates">
        <h3>Your templates</h3>
        <Show when={own().length > 0} fallback={<p class="new-empty">Save any file or folder as a template from its menu, and it shows here.</p>}>
          <Tiles tiles={own()} first={4 + types().length} />
        </Show>
        <button class="new-open" onClick={() => pick({ label: "", icon: "", pick: { kind: "templates" } })}>
          <span class="new-open-icon" aria-hidden="true">
            {ICON_OPEN}
          </span>
          Open templates folder
        </button>
      </section>
      </div>
    </div>
  );
}
