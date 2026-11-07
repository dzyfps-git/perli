import { createSignal, onMount, Show } from "solid-js";
import { createTag, setTag, type Selection } from "../../api";
import { Swatches } from "./Swatches";
import { refreshTags } from "./tags";
import "../settings/settings.css";
import "../fileops/fileops.css";

/** Makes a tag and puts it on the selected rows. */
export function NewTag(props: {
  /** Read on confirming, because the folder may reload behind the dialog. */
  selection: () => Selection | undefined;
  onDone: () => void;
  onClose: () => void;
}) {
  const [name, setName] = createSignal("");
  const [color, setColor] = createSignal(0);
  const [failure, setFailure] = createSignal<string>();
  let dialog!: HTMLDialogElement;
  let input!: HTMLInputElement;

  async function confirm() {
    try {
      const tag = await createTag(name(), color());
      await refreshTags();
      const selection = props.selection();
      if (selection) await setTag(selection, tag.id, true);
      dialog.close();
      props.onDone();
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
      aria-label="New tag"
      onClose={props.onClose}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) confirm();
      }}
    >
      <h2>New tag</h2>
      <div class="rename-fields filter-one">
        <label class="rename-field">
          Name
          <input ref={input} spellcheck={false} onInput={(event) => setName(event.currentTarget.value)} />
        </label>
      </div>
      <div class="rename-options">
        <Swatches label="Tag color" value={color()} onChange={setColor} />
      </div>
      <Show when={failure()}>
        <p class="confirm-summary" role="alert">
          {failure()}
        </p>
      </Show>
      <div class="confirm-buttons filter-buttons">
        <button class="job-choice" onClick={() => dialog.close()}>
          Cancel
        </button>
        <button class="job-choice" disabled={!name().trim()} onClick={confirm}>
          Create
        </button>
      </div>
    </dialog>
  );
}
