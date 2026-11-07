import { createSignal, onMount } from "solid-js";
import { rowsMatching } from "../../api";
import type { FolderView } from "../navigation/folderView";
import "../settings/settings.css";
import "../fileops/fileops.css";

/** Selects the rows whose names fit a pattern, such as `*.jpg;*.png`, in place of the selection. */
export function SelectPattern(props: { view: FolderView; onClose: () => void }) {
  const [pattern, setPattern] = createSignal("");
  const [count, setCount] = createSignal(0);
  const [failure, setFailure] = createSignal<string>();
  let dialog!: HTMLDialogElement;
  let input!: HTMLInputElement;
  let latest = 0;

  /** The rows that fit now. The folder may have reloaded behind the dialog. */
  function rows(text: string) {
    const request = props.view.folder()?.request;
    return request === undefined || !text.trim() ? Promise.resolve([]) : rowsMatching(props.view.id, request, text);
  }

  // An older answer must not cover a newer one, so each count knows its turn.
  async function onInput() {
    const turn = ++latest;
    setPattern(input.value);
    try {
      const found = await rows(input.value);
      if (turn !== latest) return;
      setCount(found.length);
      setFailure(undefined);
    } catch (reason) {
      if (turn === latest) setFailure(String(reason));
    }
  }

  async function confirm() {
    try {
      const found = await rows(pattern());
      if (found.length === 0) return;
      dialog.close();
      props.view.list()?.select(found);
      props.view.list()?.focus();
    } catch (reason) {
      setFailure(String(reason));
    }
  }

  onMount(() => {
    dialog.showModal();
    input.focus();
  });

  return (
    <dialog
      ref={dialog}
      class="settings confirm"
      aria-label="Select by pattern"
      onClose={props.onClose}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) confirm();
      }}
    >
      <h2>Select by pattern</h2>
      <div class="rename-fields filter-one">
        <label class="rename-field">
          Names, such as *.jpg;*.png
          <input ref={input} spellcheck={false} onInput={onInput} />
        </label>
      </div>
      <p class="confirm-summary">{failure() ?? `${count().toLocaleString()} fit.`}</p>
      <div class="confirm-buttons">
        <button class="job-choice" onClick={() => dialog.close()}>
          Cancel
        </button>
        <button class="job-choice" disabled={count() === 0} onClick={confirm}>
          Select
        </button>
      </div>
    </dialog>
  );
}
