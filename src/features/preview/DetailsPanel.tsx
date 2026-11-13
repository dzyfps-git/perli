import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { checksum, fetchRows, fetchThumb, rowProperties, type Row, type Thumb } from "../../api";
import type { FolderView } from "../navigation/folderView";
import { Checksum } from "./Checksum";
import { headline } from "./pictureFacts";
import { draw } from "./QuickPreview";

/** Arrow keys held down skip past rows, so a row has to stay selected this long first. */
const SETTLE_MS = 120;
const COPIED_MS = 1200;

/** Everything Windows knows about the one selected row, beside the list. */
export function DetailsPanel(props: { view: FolderView }) {
  const [shown, setShown] = createSignal<{ row: Row; snapshot: number; index: number }>();
  const [picture, setPicture] = createSignal<Thumb>();
  const [facts, setFacts] = createSignal<[group: string, label: string, value: string][]>([]);
  /** The value just copied, by its place in the list. */
  const [copied, setCopied] = createSignal(-1);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function copy(value: string, at: number) {
    // Selecting part of a value is not a click on it.
    if (getSelection()?.toString()) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(at);
      setTimeout(() => copied() === at && setCopied(-1), COPIED_MS);
    }, console.error);
  }
  /** Bumped by each new row, so answers for one left behind are dropped. */
  let ticket = 0;

  async function load(mine: number) {
    const at = props.view.cursor();
    if (!at) return;
    const { id } = props.view;
    const [found] = await fetchRows(id, at.snapshot, at.index, 1);
    if (mine !== ticket || !found) return;
    setShown({ row: found, snapshot: at.snapshot, index: at.index });
    fetchThumb(id, at.snapshot, at.index)
      .then((thumb) => mine === ticket && thumb && setPicture(thumb))
      .catch(console.error);
    rowProperties(id, at.snapshot, at.index)
      .then((list) => mine === ticket && setFacts(list))
      .catch(console.error);
  }

  createEffect(
    on(
      () => props.view.cursor(),
      () => {
        const mine = ++ticket;
        clearTimeout(timer);
        setShown(undefined);
        setPicture(undefined);
        setFacts([]);
        timer = setTimeout(() => load(mine).catch(console.error), SETTLE_MS);
      },
    ),
  );
  onCleanup(() => {
    ticket++;
    clearTimeout(timer);
  });

  return (
    <aside class="details-panel" aria-label="Details">
      <Show when={shown()} fallback={<p class="details-empty">Select one item to see its details.</p>}>
        <Show when={picture()} keyed>
          {(thumb) => <canvas ref={(canvas) => draw(canvas, thumb)} class="details-picture" />}
        </Show>
        <p class="details-name">{shown()!.row.name}</p>
        <Show when={headline(facts()).length > 0}>
          <ul class="details-headline">
            <For each={headline(facts())}>{(fact) => <li>{fact}</li>}</For>
          </ul>
        </Show>
        <dl class="details-facts">
          <For each={facts()}>
            {([group, label, value], at) => (
              <>
                <Show when={group !== facts()[at() - 1]?.[0]}>
                  <dt class="details-group">{group}</dt>
                </Show>
                <dt>{label}</dt>
                <dd
                  class="details-value"
                  tabindex="0"
                  role="button"
                  aria-label={`${label}: ${value}. Click to copy`}
                  data-copied={copied() === at() || undefined}
                  onClick={() => copy(value, at())}
                  onKeyDown={(event) => event.key === "Enter" && copy(value, at())}
                >
                  {value}
                </dd>
              </>
            )}
          </For>
          <Show when={((now) => now && !now.row.isDir && now)(shown())} keyed>
            {(file) => (
              <Checksum
                wait={file.row.isCloud}
                compute={(kind) => checksum(props.view.id, file.snapshot, file.index, kind)}
              />
            )}
          </Show>
        </dl>
      </Show>
    </aside>
  );
}
