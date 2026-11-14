import { Show } from "solid-js";

const ICON_LOCK = "";
/** What Rust's message says when a password does not open the file. */
export const WRONG_PASSWORD = "Wrong password";

/** Asks for an archive's password, over what it covers, in Perli's own look. */
export function PasswordCard(props: {
  wrong?: string;
  /** How long Perli keeps the password. */
  note?: string;
  onTry: (password: string) => void;
  onCancel: () => void;
}) {
  let box!: HTMLInputElement;
  return (
    <form
      class="archive-password"
      aria-label="Password"
      onSubmit={(event) => {
        event.preventDefault();
        if (box.value) props.onTry(box.value);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        props.onCancel();
      }}
    >
      <span class="archive-password-icon" aria-hidden="true">
        {ICON_LOCK}
      </span>
      <label class="archive-password-label">
        This file is under a password
        <input ref={(element) => ((box = element), queueMicrotask(() => element.focus()))} type="password" autocomplete="off" class="archive-filter" />
      </label>
      <Show when={props.wrong}>
        <p class="archive-password-wrong" role="alert">
          {props.wrong}
        </p>
      </Show>
      <span class="archive-password-buttons">
        <button type="button" class="details-button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" class="details-button archive-take">
          Unlock
        </button>
      </span>
      <p class="archive-password-note">{props.note ?? "Perli keeps it only while this preview is open."}</p>
    </form>
  );
}
