import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { isDefaultApp, setDefaultApp } from "../../api";
import type { Tag } from "../../api";
import { folderSizes, hoverCards, setHoverCards } from "../filelist/prefs";
import { TagSettings } from "../tags/TagSettings";
import {
  accent,
  ACCENTS,
  addPalette,
  changePalette,
  deletePalette,
  ownPalette,
  palettes,
  setAccent,
  setTheme,
  theme,
  THEMES,
} from "./appearance";
import { paletteStyle, type Palette } from "./palettes";
import {
  checkOnStart,
  currentVersion,
  installNow,
  lookForUpdate,
  setCheckOnStart,
  updateFailure,
  updateOffer,
  updateState,
} from "./updates";
import "./settings.css";

const COLOR_NAMES = ["First color", "Middle color", "Last color"];
const ACCENT_VARS = ["--accent-start", "--accent", "--accent-end"];

/** Changes one color, and keeps the other two. */
function withColor(palette: Palette, at: number, color: string): Palette {
  const colors = [...palette.colors] as Palette["colors"];
  colors[at] = color;
  return { ...palette, colors };
}

const ICON_CLOSE = "";

export function Settings(props: {
  open: boolean;
  onClose: () => void;
  onToggleSizes: () => void;
  onTagsChanged: () => void;
  onDeleteTag: (tag: Tag) => void;
  /** Saves what must survive Perli ending for an update. */
  onBeforeUpdate: () => Promise<unknown>;
}) {
  const [isDefault, setIsDefault] = createSignal(false);
  const [defaultFailure, setDefaultFailure] = createSignal<string>();
  let dialog!: HTMLDialogElement;

  createEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme();
    root.dataset.accent = accent();
    // The user's own colors have no rule in the style sheet, so they go on the page itself.
    const own = ownPalette();
    ACCENT_VARS.forEach((name, at) =>
      own ? root.style.setProperty(name, own.colors[at]) : root.style.removeProperty(name),
    );
  });

  // The window frame and Mica follow Windows unless told otherwise.
  createEffect(
    on(theme, (value, previous) => {
      if (previous === undefined && value === "system") return;
      getCurrentWindow()
        .setTheme(value === "system" ? null : value)
        .catch(console.error);
    }),
  );

  createEffect(() => {
    if (props.open) dialog.showModal();
    else if (dialog.open) dialog.close();
  });

  createEffect(() => {
    if (props.open) isDefaultApp().then(setIsDefault).catch(console.error);
  });

  async function toggleDefault() {
    const on = !isDefault();
    try {
      await setDefaultApp(on);
      setIsDefault(on);
      setDefaultFailure(undefined);
    } catch (failure) {
      setDefaultFailure(String(failure));
    }
  }

  return (
    <dialog ref={dialog} class="settings" aria-label="Settings" onClose={props.onClose}>
      <header class="settings-header">
        <h2>Settings</h2>
        <button class="settings-close" aria-label="Close settings" onClick={props.onClose}>
          {ICON_CLOSE}
        </button>
      </header>

      <h3 id="settings-theme">Theme</h3>
      <div class="settings-themes" role="radiogroup" aria-labelledby="settings-theme">
        <For each={THEMES}>
          {(choice) => (
            <button
              class="settings-theme"
              role="radio"
              aria-checked={theme() === choice.id}
              onClick={() => setTheme(choice.id)}
            >
              {choice.label}
            </button>
          )}
        </For>
      </div>

      <h3 id="settings-accent">Accent</h3>
      <div class="settings-accents" role="radiogroup" aria-labelledby="settings-accent">
        <For each={ACCENTS}>
          {(choice) => (
            <button
              class="settings-accent"
              role="radio"
              aria-checked={accent() === choice.id}
              onClick={() => setAccent(choice.id)}
            >
              <span class="settings-swatch" data-accent={choice.id} />
              {choice.label}
            </button>
          )}
        </For>
        <For each={palettes()}>
          {(palette) => (
            <button
              class="settings-accent"
              role="radio"
              aria-checked={accent() === palette.id}
              onClick={() => setAccent(palette.id)}
            >
              <span class="settings-swatch" data-accent={palette.id} style={paletteStyle(palette)} />
              {palette.name}
            </button>
          )}
        </For>
        <button class="settings-accent" onClick={addPalette}>
          New palette
        </button>
      </div>
      <Show when={ownPalette()} keyed>
        {(palette) => (
          <div class="settings-palette">
            <input
              class="settings-palette-name"
              aria-label="Palette name"
              spellcheck={false}
              value={palette.name}
              onChange={(event) => changePalette({ ...palette, name: event.currentTarget.value.trim() || palette.name })}
            />
            <For each={COLOR_NAMES}>
              {(name, at) => (
                <input
                  class="settings-palette-color"
                  type="color"
                  aria-label={name}
                  value={palette.colors[at()]}
                  onChange={(event) => changePalette(withColor(palette, at(), event.currentTarget.value))}
                />
              )}
            </For>
            <button class="settings-theme" onClick={() => deletePalette(palette.id)}>
              Delete palette
            </button>
          </div>
        )}
      </Show>

      <h3>Tags</h3>
      <TagSettings onChanged={props.onTagsChanged} onDelete={props.onDeleteTag} />

      <h3>Hover cards</h3>
      <button
        class="settings-theme settings-default"
        role="switch"
        aria-checked={hoverCards()}
        onClick={() => setHoverCards(!hoverCards())}
      >
        Show details when the pointer rests on a file
      </button>
      <p class="settings-note">Text files show their first lines, and other files their picture.</p>

      <h3>Folder sizes</h3>
      <button
        class="settings-theme settings-default"
        role="switch"
        aria-checked={folderSizes()}
        onClick={props.onToggleSizes}
      >
        Add up folders in the background
      </button>
      <p class="settings-note">
        The Size column fills in as Perli walks each folder you open. Links are not followed, and cloud
        files stay in the cloud.
      </p>

      <h3>Updates</h3>
      <p class="settings-note settings-update" role="status">
        {
          {
            idle: `Perli ${currentVersion()}`,
            checking: "Checking for updates…",
            current: `Perli ${currentVersion()} is up to date.`,
            ready: `Perli ${updateOffer()?.version} is ready to install.`,
            installing: "Downloading the update. Perli restarts when it is done.",
            failed: "Perli could not check for updates.",
          }[updateState()]
        }
      </p>
      <Show when={updateState() === "ready" && updateOffer()?.notes}>
        <p class="settings-note">{updateOffer()?.notes}</p>
      </Show>
      <div class="settings-update-buttons">
        <Show
          when={updateState() === "ready" || updateState() === "installing"}
          fallback={
            <button class="settings-theme" disabled={updateState() === "checking"} onClick={() => lookForUpdate()}>
              Check for updates
            </button>
          }
        >
          <button
            class="settings-theme"
            disabled={updateState() === "installing"}
            onClick={() => installNow(props.onBeforeUpdate)}
          >
            Install and restart
          </button>
        </Show>
        <button
          class="settings-theme"
          role="switch"
          aria-checked={checkOnStart()}
          onClick={() => setCheckOnStart(!checkOnStart())}
        >
          Check when Perli starts
        </button>
      </div>
      <Show when={updateFailure()}>
        <p class="settings-note" role="alert">
          {updateFailure()}
        </p>
      </Show>

      <h3>Default file manager</h3>
      <button class="settings-theme settings-default" role="switch" aria-checked={isDefault()} onClick={toggleDefault}>
        Open folders in Perli
      </button>
      <p class="settings-note">The taskbar, Start and Open dialogs in other apps stay with Windows.</p>
      <Show when={defaultFailure()}>
        <p class="settings-note" role="alert">
          {defaultFailure()}
        </p>
      </Show>
    </dialog>
  );
}
