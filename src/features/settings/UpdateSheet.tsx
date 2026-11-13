import { For, Match, onMount, Show, Switch } from "solid-js";
import { openSheet } from "../../ui/sheet";
import { noteBlocks } from "./notes";
import { currentVersion, installNow, updateFailure, updateOffer, updateState } from "./updates";
import "./settings.css";
import "../fileops/fileops.css";

/** What a new version brings, with the choice to install it now or later. */
export function UpdateSheet(props: { onBeforeUpdate: () => Promise<unknown>; onLater: () => void; onClose: () => void }) {
  let dialog!: HTMLDialogElement;
  let close!: ReturnType<typeof openSheet>;
  onMount(() => (close = openSheet(dialog)));
  const installing = () => updateState() === "installing";

  return (
    <dialog ref={dialog} class="settings update-sheet" aria-label="Update ready" onClose={props.onClose}>
      <h2>Perli {updateOffer()?.version} is ready</h2>
      <p class="update-from">You have {currentVersion()}.</p>
      <div class="update-notes">
        <For each={noteBlocks(updateOffer()?.notes ?? "")} fallback={<p>Fixes and small changes.</p>}>
          {(block) => (
            <Switch>
              <Match when={block.kind === "heading" && block}>{(heading) => <h3>{heading().text}</h3>}</Match>
              <Match when={block.kind === "text" && block}>{(text) => <p>{text().text}</p>}</Match>
              <Match when={block.kind === "list" && block}>
                {(list) => (
                  <ul>
                    <For each={list().items}>{(item) => <li>{item}</li>}</For>
                  </ul>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </div>
      <Show when={updateFailure()}>
        <p class="settings-note" role="alert">
          {updateFailure()}
        </p>
      </Show>
      <div class="confirm-buttons">
        <button class="job-choice" disabled={installing()} onClick={() => close(props.onLater)}>
          Later
        </button>
        <button class="job-choice update-install" disabled={installing()} onClick={() => installNow(props.onBeforeUpdate)}>
          {installing() ? "Downloading…" : "Install now"}
        </button>
      </div>
    </dialog>
  );
}
