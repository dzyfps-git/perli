import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, For, on } from "solid-js";
import { accent, ACCENTS, setAccent, setTheme, theme, THEMES } from "./appearance";
import "./settings.css";

const ICON_CLOSE = "";

export function Settings(props: { open: boolean; onClose: () => void }) {
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
    </dialog>
  );
}
