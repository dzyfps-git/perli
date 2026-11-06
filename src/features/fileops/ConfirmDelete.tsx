import { createSignal, onMount } from "solid-js";
import type { Measured } from "../../api";
import { formatSize } from "../../ui/format";
import "../settings/settings.css";
import "./fileops.css";

export interface DeleteRequest {
  title: string;
  /** What the user would lose, which the confirm button waits for. */
  measure?: () => Promise<Measured>;
  /** The text to show instead, when there is nothing to measure. */
  note?: string;
  cancelLabel?: string;
  confirmLabel?: string;
  confirm: () => void;
}

/** Cancel holds the focus, and the confirm button waits until the user can see what they would lose. */
export function ConfirmDelete(props: { request: DeleteRequest; onClose: () => void }) {
  const [measured, setMeasured] = createSignal<Measured>();
  const [failure, setFailure] = createSignal<string>();
  let dialog!: HTMLDialogElement;
  let cancel!: HTMLButtonElement;

  function summary() {
    if (props.request.note) return props.request.note;
    const size = measured();
    if (!size) return failure() ?? "Measuring";
    const items = size.items === 1 ? "1 item" : `${size.items.toLocaleString()} items`;
    return `${items}, ${formatSize(size.bytes)}. This can't be undone.`;
  }

  function confirm() {
    dialog.close();
    props.request.confirm();
  }

  onMount(() => {
    dialog.showModal();
    cancel.focus();
    props.request
      .measure?.()
      .then(setMeasured)
      .catch((reason) => setFailure(String(reason)));
  });

  return (
    <dialog ref={dialog} class="settings confirm" aria-label={props.request.title} onClose={props.onClose}>
      <h2>{props.request.title}</h2>
      <p class="confirm-summary">{summary()}</p>
      <div class="confirm-buttons">
        <button ref={cancel} class="job-choice" onClick={() => dialog.close()}>
          {props.request.cancelLabel ?? "Cancel"}
        </button>
        <button
          class="job-choice confirm-delete"
          disabled={!props.request.note && !measured()}
          onClick={confirm}
        >
          {props.request.confirmLabel ?? "Delete"}
        </button>
      </div>
    </dialog>
  );
}
