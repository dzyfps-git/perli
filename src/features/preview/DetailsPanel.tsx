import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { checksum, fetchRows, fetchThumb, rowProperties, type Row, type Thumb } from "../../api";
import type { FolderView } from "../navigation/folderView";
import { draw } from "./QuickPreview";

/** Arrow keys held down skip past rows, so a row has to stay selected this long first. */
const SETTLE_MS = 120;
/** Reading a whole file is heavier, so its checksum waits a little longer. */
const HASH_AFTER_MS = 300;

type Hash =
  { state: "waiting" } | { state: "working" } | { state: "done"; value: string } | { state: "failed"; why: string };

/** Everything Windows knows about the one selected row, beside the list. */
export function DetailsPanel(props: { view: FolderView }) {
  const [row, setRow] = createSignal<Row>();
  const [picture, setPicture] = createSignal<Thumb>();
  const [facts, setFacts] = createSignal<[string, string][]>([]);
  const [hash, setHash] = createSignal<Hash>();
  const [copied, setCopied] = createSignal<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by each new row, so answers for one left behind are dropped. */
  let ticket = 0;

  function computeHash(mine: number) {
    const at = props.view.cursor();
    if (!at || mine !== ticket) return;
    setHash({ state: "working" });
    checksum(props.view.id, at.snapshot, at.index)
      .then((value) => mine === ticket && value !== null && setHash({ state: "done", value }))
      .catch((why) => mine === ticket && setHash({ state: "failed", why: String(why) }));
  }

  async function load(mine: number) {
    const at = props.view.cursor();
    if (!at) return;
    const { id } = props.view;
    const [found] = await fetchRows(id, at.snapshot, at.index, 1);
    if (mine !== ticket || !found) return;
    setRow(found);
    fetchThumb(id, at.snapshot, at.index)
      .then((thumb) => mine === ticket && thumb && setPicture(thumb))
      .catch(console.error);
    rowProperties(id, at.snapshot, at.index)
      .then((list) => mine === ticket && setFacts(list))
      .catch(console.error);
    if (found.isDir) return;
    // Reading a file kept only online would download all of it.
    if (found.isCloud) setHash({ state: "waiting" });
    else timer = setTimeout(() => computeHash(mine), HASH_AFTER_MS);
  }

  createEffect(
    on(
      () => props.view.cursor(),
      () => {
        const mine = ++ticket;
        clearTimeout(timer);
        setRow(undefined);
        setPicture(undefined);
        setFacts([]);
        setHash(undefined);
        setCopied(undefined);
        timer = setTimeout(() => load(mine).catch(console.error), SETTLE_MS);
      },
    ),
  );
  onCleanup(() => {
    ticket++;
    clearTimeout(timer);
  });

  function copy(value: string) {
    navigator.clipboard
      .writeText(value)
      .then(() => setCopied("Copied"))
      .catch(() => setCopied("Couldn't copy"));
  }

  return (
    <aside class="details-panel" aria-label="Details">
      <Show when={row()} fallback={<p class="details-empty">Select one item to see its details.</p>}>
        <Show when={picture()} keyed>
          {(thumb) => <canvas ref={(canvas) => draw(canvas, thumb)} class="details-picture" />}
        </Show>
        <p class="details-name">{row()!.name}</p>
        <dl class="details-facts">
          <For each={facts()}>
            {([label, value]) => (
              <>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </>
            )}
          </For>
          <Show when={hash()} keyed>
            {(shown) => (
              <>
                <dt>SHA-256</dt>
                <dd class="details-hash">
                  {shown.state === "waiting" && (
                    <button class="details-button" onClick={() => computeHash(ticket)}>
                      Download and work out
                    </button>
                  )}
                  {shown.state === "working" && <span class="details-muted">Working it out…</span>}
                  {shown.state === "failed" && <span class="details-muted">{shown.why}</span>}
                  {shown.state === "done" && (
                    <>
                      <code>{shown.value}</code>
                      <button class="details-button" onClick={() => copy(shown.value)}>
                        Copy
                      </button>
                      <Show when={copied()}>
                        <span class="details-muted" role="status">
                          {copied()}
                        </span>
                      </Show>
                    </>
                  )}
                </dd>
              </>
            )}
          </Show>
        </dl>
      </Show>
    </aside>
  );
}
