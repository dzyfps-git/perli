import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { HashKind } from "../../api";
import { saved, stored } from "../filelist/prefs";

/** Reading a whole file is heavy, so its checksum waits a little after it is shown. */
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
/** Kept across files, so stepping through them finds the one that matches. */
const [pasted, setPasted] = createSignal("");

/** Spaces, colons and case don't matter, as sites print hashes every way. */
export const plainHash = (text: string) => text.replace(/[\s:]/g, "").toLowerCase();

/**
 * One file's checksum inside a `details-facts` list: the kinds, the answer, and a box to paste
 * a hash to compare. Make a new one for each file. With `wait` the file is only online, so
 * nothing is read until the user asks, since that would download all of it.
 */
export function Checksum(props: { compute: (kind: HashKind) => Promise<string | null>; wait: boolean }) {
  const [hash, setHash] = createSignal<Hash>({ state: props.wait ? "waiting" : "working" });
  const [copied, setCopied] = createSignal<string>();
  /** Bumped by each new try, so the answer of an older one is dropped. */
  let ticket = 0;

  function work() {
    const mine = ++ticket;
    setHash({ state: "working" });
    setCopied(undefined);
    props
      .compute(kind())
      .then((value) => mine === ticket && value !== null && setHash({ state: "done", value }))
      .catch((why) => mine === ticket && setHash({ state: "failed", why: String(why) }));
  }

  const timer = props.wait ? undefined : setTimeout(work, HASH_AFTER_MS);
  onCleanup(() => {
    ticket++;
    clearTimeout(timer);
  });
  // The kind is shared, so one picked elsewhere is worked out here too.
  createEffect(on(kind, () => hash().state !== "waiting" && work(), { defer: true }));

  /** A pasted hash's length gives away its kind, so the right one is worked out. */
  function paste(text: string) {
    setPasted(text);
    const digits = plainHash(text).length;
    const fits = KINDS.find(([, , length]) => length === digits);
    if (fits) setKind(fits[0]);
  }

  const verdict = createMemo(() => {
    const shown = hash();
    const wanted = plainHash(pasted());
    if (!wanted || shown.state !== "done") return;
    return wanted === shown.value ? "match" : "mismatch";
  });

  function copy(value: string) {
    navigator.clipboard
      .writeText(value)
      .then(() => setCopied("Copied"))
      .catch(() => setCopied("Couldn't copy"));
  }

  return (
    <>
      <dt class="details-group">Checksum</dt>
      <dd class="details-hash">
        <div class="hash-kinds" role="group" aria-label="Checksum kind">
          <For each={KINDS}>
            {([id, label]) => (
              <button aria-pressed={kind() === id} onClick={() => setKind(id)}>
                {label}
              </button>
            )}
          </For>
        </div>
        {hash().state === "waiting" && (
          <button class="details-button" onClick={work}>
            Download and work out
          </button>
        )}
        {hash().state === "working" && <span class="details-muted hash-working">Working it out…</span>}
        <Show when={((now) => now.state === "failed" && now)(hash())} keyed>
          {(failed) => <span class="details-muted">{failed.why}</span>}
        </Show>
        <Show when={((now) => now.state === "done" && now)(hash())} keyed>
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
  );
}
