import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { openSheet } from "../../ui/sheet";
import { baseName } from "../navigation/path";
import { TAG_COLORS, tagColor } from "../tags/tags";
import { findIcons } from "./folderIcons";
import { lookOf, ownLookOf, setLook } from "./saved";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./sidebar.css";

const ICON_FOLDER = "";

/** A folder's color, icon and cover in one sheet, with a search through the icons. */
export function LookPicker(props: { path: string; onClose: () => void }) {
  const [typed, setTyped] = createSignal("");
  const look = () => lookOf(props.path);
  const icons = createMemo(() => findIcons(typed()));
  let dialog!: HTMLDialogElement;
  let search!: HTMLInputElement;
  let close!: ReturnType<typeof openSheet>;

  /** Folders inside, at any depth and also ones made later, take this look unless they have their own. */
  const handsDown = () => ownLookOf(props.path)?.inside === true;
  const canHand = () => ownLookOf(props.path)?.color !== undefined || ownLookOf(props.path)?.icon !== undefined;

  onMount(() => {
    close = openSheet(dialog);
    search.focus();
  });

  return (
    <dialog ref={dialog} class="settings confirm look-picker" aria-label="Folder look" onClose={props.onClose}>
      <div class="look-head">
        <span
          class="look-sample"
          style={{ "--look-color": look()?.color === undefined ? undefined : tagColor(look()!.color!) }}
          aria-hidden="true"
        >
          {look()?.icon ?? ICON_FOLDER}
        </span>
        <h2>{baseName(props.path) || props.path}</h2>
      </div>
      <h3 class="look-title">Color</h3>
      <div class="look-colors" role="radiogroup" aria-label="Color">
        <button
          class="look-color look-none"
          role="radio"
          aria-label="No color"
          aria-checked={look()?.color === undefined}
          onClick={() => setLook(props.path, { color: undefined })}
        />
        <For each={TAG_COLORS}>
          {(name, color) => (
            <button
              class="look-color"
              role="radio"
              aria-label={name}
              aria-checked={look()?.color === color()}
              style={{ background: tagColor(color()) }}
              onClick={() => setLook(props.path, { color: color() })}
            />
          )}
        </For>
      </div>
      <h3 class="look-title">Icon</h3>
      <input
        ref={search}
        class="look-search"
        type="search"
        placeholder="Find an icon: travel, music, code…"
        aria-label="Find an icon"
        spellcheck={false}
        value={typed()}
        onInput={(event) => setTyped(event.currentTarget.value)}
      />
      <div class="look-icons" role="radiogroup" aria-label="Icon">
        <Show when={!typed()}>
          <button
            class="look-icon"
            role="radio"
            aria-label="Plain folder"
            aria-checked={look()?.icon === undefined}
            onClick={() => setLook(props.path, { icon: undefined })}
          >
            {ICON_FOLDER}
          </button>
        </Show>
        <For each={icons()} fallback={<p class="look-none-found">No icon goes by that name.</p>}>
          {(icon) => (
            <button
              class="look-icon"
              role="radio"
              aria-label={icon.label}
              aria-checked={look()?.icon === icon.glyph}
              onClick={() => setLook(props.path, { icon: icon.glyph })}
            >
              {icon.glyph}
            </button>
          )}
        </For>
      </div>
      <h3 class="look-title">Cover</h3>
      <Show
        when={look()?.cover}
        fallback={<p class="settings-note">Right-click a picture in this folder and choose Use as folder cover. Tiles then show it.</p>}
      >
        {(cover) => (
          <p class="look-cover">
            <span>{baseName(cover())}</span>
            <button class="job-choice" onClick={() => setLook(props.path, { cover: undefined })}>
              Remove cover
            </button>
          </p>
        )}
      </Show>
      <Show when={handsDown()}>
        <p class="settings-note" role="status">
          Folders inside look the same, new ones too, unless they have a look of their own.
        </p>
      </Show>
      <div class="confirm-buttons">
        <button
          class="job-choice look-inside"
          aria-pressed={handsDown()}
          disabled={!canHand()}
          onClick={() => setLook(props.path, { inside: !handsDown() })}
        >
          {handsDown() ? "Folders inside go their own way" : "Same look for folders inside"}
        </button>
        <button class="job-choice" onClick={() => close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}
