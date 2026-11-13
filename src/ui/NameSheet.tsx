import { createSignal, onMount } from "solid-js";
import { openSheet } from "./sheet";
import "../features/settings/settings.css";
import "../features/fileops/fileops.css";

/** What to ask a name for, and what to do with it. */
export interface NameAsk {
  title: string;
  /** The word on the button that confirms. */
  confirm: string;
  start?: string;
  done: (name: string) => void;
}

/** Asks for one name. Enter confirms, and an empty name can't be confirmed. */
export function NameSheet(props: { ask: NameAsk; onClose: () => void }) {
  const [name, setName] = createSignal(props.ask.start ?? "");
  let dialog!: HTMLDialogElement;
  let input!: HTMLInputElement;
  let close!: ReturnType<typeof openSheet>;

  function confirm() {
    const wanted = name().trim();
    if (wanted) close(() => props.ask.done(wanted));
  }

  onMount(() => {
    close = openSheet(dialog);
    input.focus();
    input.select();
  });

  return (
    <dialog
      ref={dialog}
      class="settings confirm"
      aria-label={props.ask.title}
      onClose={props.onClose}
      // Only the name box: Enter on a button presses that button.
      onKeyDown={(event) => event.key === "Enter" && event.target === input && confirm()}
    >
      <h2>{props.ask.title}</h2>
      <div class="rename-fields filter-one">
        <label class="rename-field">
          Name
          <input ref={input} spellcheck={false} value={name()} onInput={(event) => setName(event.currentTarget.value)} />
        </label>
      </div>
      <div class="confirm-buttons filter-buttons">
        <button class="job-choice" onClick={() => close()}>
          Cancel
        </button>
        <button class="job-choice" disabled={!name().trim()} onClick={confirm}>
          {props.ask.confirm}
        </button>
      </div>
    </dialog>
  );
}
