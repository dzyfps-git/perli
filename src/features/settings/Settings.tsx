import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { isDefaultApp, setDefaultApp } from "../../api";
import type { Tag } from "../../api";
import { folderSizes } from "../filelist/prefs";
import { TagSettings } from "../tags/TagSettings";
import { accent, ACCENTS, setAccent, setTheme, theme, THEMES } from "./appearance";
import "./settings.css";

const ICON_CLOSE = "";

export function Settings(props: {
  open: boolean;
  onClose: () => void;
  onToggleSizes: () => void;
  onTagsChanged: () => void;
  onDeleteTag: (tag: Tag) => void;
}) {
  const [isDefault, setIsDefault] = createSignal(false);
  const [defaultFailure, setDefaultFailure] = createSignal<string>();
  let dialog!: HTMLDialogElement;

  createEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme();
    root.dataset.accent = accent();
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
      </div>

      <h3>Tags</h3>
      <TagSettings onChanged={props.onTagsChanged} onDelete={props.onDeleteTag} />

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
