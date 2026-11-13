import { createSignal, For, onCleanup, onMount, type JSX } from "solid-js";
import { CLIPBOARD_SET } from "../../api";

export type EmptyArt = "folder" | "bin" | "search" | "filter";

export interface EmptyAction {
  label: string;
  /** The keys that do the same, read out with the button's name. */
  keys?: string;
  run: () => void;
  /** Asked when the list shows, each time Perli comes back to the front, and after Perli copies. */
  enabled?: () => Promise<boolean>;
}

/** What a list with no rows shows in their place. */
export interface Empty {
  art: EmptyArt;
  text: string;
  actions: EmptyAction[];
}

/** Each drawing is a few quiet lines in a 96 by 72 box. `.empty-accent` parts wear the accent. */
const ART: Record<EmptyArt, () => JSX.Element> = {
  folder: () => (
    <>
      <path d="M14 22a6 6 0 0 1 6-6h16l8 8h32a6 6 0 0 1 6 6v26a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6z" />
      <path class="empty-accent" d="M40 44h16M48 36v16" />
    </>
  ),
  bin: () => (
    <>
      <path d="M28 24h40M40 24v-5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v5M32 24l3 34a5 5 0 0 0 5 4h16a5 5 0 0 0 5-4l3-34" />
      <path class="empty-accent" d="M43 46l4 4 7-9" />
    </>
  ),
  search: () => (
    <>
      <circle cx="44" cy="33" r="17" />
      <path d="M57 46l14 14" />
      <path class="empty-accent" d="M38 33h12" />
    </>
  ),
  filter: () => (
    <>
      <path d="M20 16h56L54 41v17l-12 6V41z" />
      <path class="empty-accent" d="M40 26h16" />
    </>
  ),
};

function Action(props: { action: EmptyAction }) {
  const [enabled, setEnabled] = createSignal(!props.action.enabled);
  const ask = () => props.action.enabled?.().then(setEnabled).catch(console.error);
  onMount(() => {
    ask();
    // What another app copied is there to paste once Perli is back in front.
    window.addEventListener("focus", ask);
    // And what Perli copied in another pane, which needs no change of focus.
    window.addEventListener(CLIPBOARD_SET, ask);
    onCleanup(() => {
      window.removeEventListener("focus", ask);
      window.removeEventListener(CLIPBOARD_SET, ask);
    });
  });
  return (
    <button
      class="empty-action"
      disabled={!enabled()}
      aria-keyshortcuts={props.action.keys}
      // The list would take the click as one on its background, and the press as a second open.
      onClick={(event) => {
        event.stopPropagation();
        props.action.run();
      }}
      onDblClick={(event) => event.stopPropagation()}
    >
      {props.action.label}
      {props.action.keys && <kbd class="empty-keys">{props.action.keys}</kbd>}
    </button>
  );
}

/** A quiet drawing, one line, and the few things worth doing from here. */
export function EmptyState(props: { empty: Empty }) {
  return (
    <div class="empty-state">
      <svg class="empty-art" viewBox="0 0 96 72" aria-hidden="true">
        <ellipse class="empty-shadow" cx="48" cy="68" rx="22" ry="2.5" />
        <g class="empty-float">{ART[props.empty.art]()}</g>
      </svg>
      <p class="empty-text" role="status">
        {props.empty.text}
      </p>
      <div class="empty-actions">
        <For each={props.empty.actions}>{(action) => <Action action={action} />}</For>
      </div>
    </div>
  );
}
