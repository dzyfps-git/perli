import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { subfolders } from "../../api";
import { openSheet } from "../../ui/sheet";
import { showHidden } from "../filelist/prefs";
import { baseName, join } from "../navigation/path";
import { TAG_COLORS, tagColor } from "../tags/tags";
import { findIcons } from "./folderIcons";
import { lookOf, setLook, setLooksFor } from "./saved";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./sidebar.css";

// ponytail: stops after this many folders inside, which keeps a whole drive from freezing the
// sheet. A job in Rust would be the way past it.
const MOST_FOLDERS = 500;
const ICON_FOLDER = "";

/** A folder's color, icon and cover in one sheet, with a search through the icons. */
export function LookPicker(props: { path: string; onClose: () => void }) {
  const [typed, setTyped] = createSignal("");
  const [spread, setSpread] = createSignal<string>();
  const look = () => lookOf(props.path);
  const icons = createMemo(() => findIcons(typed()));
  let dialog!: HTMLDialogElement;
  let search!: HTMLInputElement;
  let close!: ReturnType<typeof openSheet>;

  /** Every folder inside, a level at a time, up to `MOST_FOLDERS`. */
  async function giveInside() {
    const found: string[] = [];
    const waiting = [props.path];
    while (waiting.length > 0 && found.length < MOST_FOLDERS) {
      const folder = waiting.shift()!;
      const names = await subfolders(folder, showHidden()).catch((): string[] => []);
      for (const name of names.slice(0, MOST_FOLDERS - found.length)) {
        found.push(join(folder, name));
        waiting.push(join(folder, name));
      }
      setSpread(`Finding folders… ${found.length.toLocaleString()}`);
    }
    const { color, icon } = look() ?? {};
    setLooksFor(found, { color, icon });
    const more = waiting.length > 0 && found.length >= MOST_FOLDERS ? ", the first ones found" : "";
    const many = found.length === 1 ? "1 folder inside looks" : `${found.length.toLocaleString()} folders inside look`;
    setSpread(found.length === 0 ? "There are no folders inside." : `${many} the same now${more}.`);
  }

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
      <Show when={spread()}>
        <p class="settings-note" role="status">
          {spread()}
        </p>
      </Show>
      <div class="confirm-buttons">
        <button class="job-choice look-inside" disabled={!look() || spread()?.startsWith("Finding")} onClick={giveInside}>
          Same look for folders inside
        </button>
        <button class="job-choice" onClick={() => close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}
