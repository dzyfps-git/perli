import { For, Show } from "solid-js";
import { baseName, parentOf, samePath } from "../navigation/path";
import { cutMark, takeBackCut } from "./clipboard";

const ICON_CUT = "";
const MOST_NAMES = 8;

/**
 * Cut files wait for a paste, and the faded rows say so only in their own folder. This chip on
 * the sidebar says so from anywhere: a click peeks at what is cut, goes back to it, or lets it go.
 */
export function CutChip(props: { onShow: (folder: string, names: string[]) => void }) {
  let chip!: HTMLButtonElement;
  let peek!: HTMLDivElement;

  function open() {
    if (peek.matches(":popover-open")) return peek.hidePopover();
    peek.showPopover();
    const { right, bottom } = chip.getBoundingClientRect();
    const { height } = peek.getBoundingClientRect();
    peek.style.left = `${right + 8}px`;
    peek.style.top = `${Math.max(4, Math.min(bottom - height, innerHeight - height - 4))}px`;
  }

  return (
    <Show when={cutMark()}>
      {(cut) => {
        // The paths, not the faded names: rows of a search fade nowhere, but are cut all the same.
        const names = () => cut().paths.map(baseName).sort((a, b) => a.localeCompare(b));
        const first = () => parentOf(cut().paths[0] ?? "") ?? cut().folder;
        const oneFolder = () => cut().paths.every((path) => samePath(parentOf(path), first()));
        /** Show goes to the first one's folder, with what is cut there selected. */
        const shownNames = () => cut().paths.filter((path) => samePath(parentOf(path), first())).map(baseName);
        const label = () => (names().length === 1 ? "1 item cut" : `${names().length} items cut`);
        const more = () => names().length - MOST_NAMES;
        return (
          <>
            <button ref={chip} class="cut-chip" aria-haspopup="dialog" onClick={open}>
              <span class="cut-icon" aria-hidden="true">
                {ICON_CUT}
              </span>
              <span class="cut-count" aria-hidden="true">
                {names().length}
              </span>
              <span class="cut-label">{label()}</span>
            </button>
            <div ref={peek} class="new-gallery cut-peek" popover="auto" role="dialog" aria-label={label()}>
              <span class="cut-from">From {oneFolder() ? baseName(first()) || first() : "several folders"}</span>
              <ul class="cut-names">
                <For each={names().slice(0, MOST_NAMES)}>{(name) => <li>{name}</li>}</For>
              </ul>
              <Show when={more() > 0}>
                <span class="cut-more">and {more()} more</span>
              </Show>
              <div class="cut-actions">
                <button
                  class="job-choice"
                  onClick={() => {
                    peek.hidePopover();
                    props.onShow(first(), shownNames());
                  }}
                >
                  Show
                </button>
                <button class="job-choice" onClick={takeBackCut}>
                  Clear
                </button>
              </div>
            </div>
          </>
        );
      }}
    </Show>
  );
}
