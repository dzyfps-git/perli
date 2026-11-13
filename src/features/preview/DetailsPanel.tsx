import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { checksum, fetchRows, fetchThumb, rowProperties, type HashKind, type Row, type Thumb } from "../../api";
import { saved, stored } from "../filelist/prefs";
import type { FolderView } from "../navigation/folderView";
import { draw } from "./QuickPreview";

/** Arrow keys held down skip past rows, so a row has to stay selected this long first. */
const SETTLE_MS = 120;
/** Reading a whole file is heavier, so its checksum waits a little longer. */
const HASH_AFTER_MS = 300;

type Hash =
  | { state: "waiting" }
  | { state: "working" }
  | { state: "done"; value: string }
  | { state: "failed"; why: string };

/** Each kind with its label and how many hex digits its answer has. */
const KINDS: [HashKind, string, number][] = [
  ["md5", "MD5", 32],
  ["sha1", "SHA-1", 40],
  ["sha256", "SHA-256", 64],
  ["sha512", "SHA-512", 128],
];
const [kind, setKind] = stored<HashKind>(
  "hash-kind",
  KINDS.find(([id]) => id === saved("hash-kind"))?.[0] ?? "sha256",
);
/** Kept across rows, so stepping through files finds the one that matches. */
const [pasted, setPasted] = createSignal("");

/** Spaces, colons and case don't matter, as sites print hashes every way. */
export const plainHash = (text: string) => text.replace(/[\s:]/g, "").toLowerCase();

/** Everything Windows knows about the one selected row, beside the list. */
export function DetailsPanel(props: { view: FolderView }) {
  const [row, setRow] = createSignal<Row>();
  const [picture, setPicture] = createSignal<Thumb>();
  const [facts, setFacts] = createSignal<[group: string, label: string, value: string][]>([]);
  const [hash, setHash] = createSignal<Hash>();
  const [copied, setCopied] = createSignal<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by each new row, so answers for one left behind are dropped. */
  let ticket = 0;

  function computeHash(mine: number) {
    const at = props.view.cursor();
    if (!at || mine !== ticket) return;
    const asked = kind();
    const current = () => mine === ticket && asked === kind();
    setHash({ state: "working" });
    setCopied(undefined);
    checksum(props.view.id, at.snapshot, at.index, asked)
      .then((value) => current() && value !== null && setHash({ state: "done", value }))
      .catch((why) => current() && setHash({ state: "failed", why: String(why) }));
  }

  /** A file kept only online waits to be asked again, since hashing downloads it. */
  function chooseKind(next: HashKind) {
    if (next === kind()) return;
    setKind(next);
    const shown = hash();
    if (shown && shown.state !== "waiting") computeHash(ticket);
  }

  /** A pasted hash's length gives away its kind, so the right one is worked out. */
  function paste(text: string) {
    setPasted(text);
    const digits = plainHash(text).length;
    const fits = KINDS.find(([, , length]) => length === digits);
    if (fits) chooseKind(fits[0]);
  }

  const verdict = createMemo(() => {
    const shown = hash();
    const wanted = plainHash(pasted());
    if (!wanted || shown?.state !== "done") return;
    return wanted === shown.value ? "match" : "mismatch";
  });

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
            {([group, label, value], at) => (
              <>
                <Show when={group !== facts()[at() - 1]?.[0]}>
                  <dt class="details-group">{group}</dt>
                </Show>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </>
            )}
          </For>
          <Show when={hash()}>
            {(shown) => (
              <>
                <dt class="details-group">Checksum</dt>
                <dd class="details-hash">
                  <div class="hash-kinds" role="group" aria-label="Checksum kind">
                    <For each={KINDS}>
                      {([id, label]) => (
                        <button aria-pressed={kind() === id} onClick={() => chooseKind(id)}>
                          {label}
                        </button>
                      )}
                    </For>
                  </div>
                  {shown().state === "waiting" && (
                    <button class="details-button" onClick={() => computeHash(ticket)}>
                      Download and work out
                    </button>
                  )}
                  {shown().state === "working" && <span class="details-muted hash-working">Working it out…</span>}
                  <Show when={((now) => now.state === "failed" && now)(shown())} keyed>
                    {(failed) => <span class="details-muted">{failed.why}</span>}
                  </Show>
                  <Show when={((now) => now.state === "done" && now)(shown())} keyed>
                    {(done) => (
                      <>
                        <code classList={{ "hash-match": verdict() === "match", "hash-mismatch": verdict() === "mismatch" }}>
                          {done.value}
                        </code>
                        <button class="details-button" onClick={() => copy(done.value)}>
                          Copy
                        </button>
                        <Show when={copied()}>
                          <span class="details-muted" role="status">
                            {copied()}
                          </span>
                        </Show>
                      </>
                    )}
                  </Show>
                  <Show when={verdict()} keyed>
                    {(said) => (
                      <span class={`hash-verdict hash-${said}`} role="status">
                        <span class="hash-verdict-icon" aria-hidden="true">
                          {said === "match" ? "" : ""}
                        </span>
                        {said === "match" ? "Matches" : "Doesn't match"}
                      </span>
                    )}
                  </Show>
                  <input
                    class="hash-paste"
                    classList={{ "hash-match": verdict() === "match", "hash-mismatch": verdict() === "mismatch" }}
                    placeholder="Paste a hash to compare"
                    aria-label="Hash to compare"
                    spellcheck={false}
                    value={pasted()}
                    onInput={(event) => paste(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape" || !pasted()) return;
                      event.stopPropagation();
                      paste("");
                    }}
                  />
                </dd>
              </>
            )}
          </Show>
        </dl>
      </Show>
    </aside>
  );
}
