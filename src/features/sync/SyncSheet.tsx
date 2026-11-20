import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { removeSyncPair, saveSyncPair, syncPairs, syncPreview, type SyncPair, type SyncPreview } from "../../api";
import { formatSize } from "../../ui/format";
import { openSheet } from "../../ui/sheet";
import { pick } from "../dialogs/Picker";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "../dialogs/dialogs.css";
import "../cloud/cloud.css";

/** How often a scheduled pair is looked at, and the choices of how often one runs. */
const LOOK_MS = 60_000;
const EVERY: { minutes: number; label: string }[] = [
  { minutes: 0, label: "Only when asked" },
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 1440, label: "Every day" },
];
/** The most lines the look before a run lists. The counts cover all of them. */
const MOST_LINES = 200;

const [pairs, setPairs] = createSignal<SyncPair[]>([]);
export const syncPairList = pairs;
export const readSyncPairs = () => syncPairs().then(setPairs).catch(console.error);

/** The pair the sheet shows, new or saved. */
const [editing, setEditing] = createSignal<SyncPair>();
export { editing as editingSync };
export const newSync = (from = "", to = "") => setEditing({ id: "", from, to, mirror: false, skip: "", every: 0, ran: 0 });
export const editSync = (pair: SyncPair) => setEditing({ ...pair });
export const closeSync = () => setEditing(undefined);

const base = (path: string) => path.replace(/\\+$/, "").split("\\").pop() || path;
export const syncLabel = (pair: SyncPair) => `${base(pair.from)} → ${base(pair.to)}`;

/** Asks for each scheduled pair once a minute. Only one that is due runs, in one window. */
export function startSyncTimer(run: (id: string, scheduled: boolean) => void) {
  // The pairs are read again each time, so one saved in another window runs here too.
  const timer = setInterval(() => void readSyncPairs().then(() => pairs().forEach((pair) => pair.every > 0 && run(pair.id, true))), LOOK_MS);
  onCleanup(() => clearInterval(timer));
}

export async function forgetSync(pair: SyncPair) {
  await removeSyncPair(pair.id);
  await readSyncPairs();
}

/**
 * A sync pair: where from, where to, Update or Mirror, what it leaves alone and how often it
 * runs. Before a pair's first run, and whenever asked, it shows every copy and every removal.
 */
export function SyncSheet(props: { pair: SyncPair; onRun: (pair: SyncPair) => void; onClose: () => void }) {
  const [pair, setPair] = createSignal(props.pair);
  const [preview, setPreview] = createSignal<SyncPreview>();
  const [failure, setFailure] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  let dialog!: HTMLDialogElement;
  let close!: ReturnType<typeof openSheet>;

  const change = (part: Partial<SyncPair>) => {
    setPair({ ...pair(), ...part });
    setPreview(undefined);
    setFailure(undefined);
  };
  const ready = () => !!pair().from.trim() && !!pair().to.trim() && !busy();
  /** A pair's first run, and a mirror's every run, is looked at before it goes. */
  const mustLook = () => pair().ran === 0 || pair().mirror;

  async function choose(side: "from" | "to") {
    const picked = await pick({ mode: "folder", title: side === "from" ? "Sync from" : "Sync to", purpose: "folders" });
    if (picked) change({ [side]: picked.path });
  }

  async function work(job: () => Promise<void>) {
    setBusy(true);
    setFailure(undefined);
    try {
      await job();
    } catch (reason) {
      setFailure(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const look = () => work(async () => void setPreview(await syncPreview(pair())));
  const save = () =>
    work(async () => {
      await saveSyncPair(pair());
      await readSyncPairs();
      close();
    });
  const run = () =>
    work(async () => {
      const saved = await saveSyncPair(pair());
      await readSyncPairs();
      close(() => props.onRun(saved));
    });

  const lines = () => {
    const shown = preview();
    if (!shown) return [];
    const removes = shown.removes.map((path) => `${shown.forGood ? "Deleted for good" : "To the bin"}: ${path}`);
    const copies = shown.copies.map(([source, folder]) => `Copy ${base(source)} into ${folder}`);
    return [...removes, ...copies].slice(0, MOST_LINES);
  };
  const said = () => {
    if (failure()) return failure();
    const shown = preview();
    if (!shown) return mustLook() ? "Look first to see every copy and removal before it runs." : "Runs as a job, with Undo.";
    if (!shown.copies.length && !shown.removes.length) return "The two sides are alike. Nothing to do.";
    const copies = `${shown.copies.length.toLocaleString()} to copy (${formatSize(shown.bytes)})`;
    if (!shown.removes.length) return copies;
    const removes = shown.removes.length.toLocaleString();
    // S3 keeps no bin: the run asks before it deletes anything for good.
    return shown.forGood ? `${copies}, ${removes} deleted for good first, once you say so` : `${copies}, ${removes} to the bin first`;
  };

  onMount(() => {
    close = openSheet(dialog);
  });

  return (
    <dialog ref={dialog} class="settings confirm drive-sheet cloud-sheet" aria-label="Sync" onClose={props.onClose}>
      <h2>{pair().id ? syncLabel(pair()) : "New sync"}</h2>
      <div class="drive-fields">
        <label class="rename-field">
          From
          <input spellcheck={false} value={pair().from} onChange={(event) => change({ from: event.currentTarget.value })} />
        </label>
        <button class="settings-chip" onClick={() => choose("from")}>
          Pick…
        </button>
        <label class="rename-field">
          To
          <input spellcheck={false} value={pair().to} onChange={(event) => change({ to: event.currentTarget.value })} />
        </label>
        <button class="settings-chip" onClick={() => choose("to")}>
          Pick…
        </button>
      </div>
      <div class="settings-chips" role="radiogroup" aria-label="How">
        <button class="settings-chip" role="radio" aria-checked={!pair().mirror} onClick={() => change({ mirror: false })}>
          Update
        </button>
        <button class="settings-chip" role="radio" aria-checked={pair().mirror} onClick={() => change({ mirror: true })}>
          Mirror
        </button>
      </div>
      <p class="settings-note">
        {pair().mirror
          ? "Copies what is new or changed, and takes away what the source no longer has. What goes, goes to a bin."
          : "Copies what is new or changed. Nothing is taken away, and a file it replaces goes to a bin."}
      </p>
      <div class="drive-fields">
        <label class="rename-field">
          Leave out
          <input spellcheck={false} placeholder="*.tmp; node_modules" value={pair().skip} onChange={(event) => change({ skip: event.currentTarget.value })} />
        </label>
        <span />
        <label class="rename-field">
          Runs
          <select value={pair().every} onChange={(event) => change({ every: Number(event.currentTarget.value) })}>
            <For each={EVERY}>{(one) => <option value={one.minutes}>{one.label}</option>}</For>
          </select>
        </label>
      </div>
      <p class="drive-hint" classList={{ "properties-failure": !!failure() }} role="status">
        {said()}
      </p>
      <Show when={lines().length}>
        <ul class="cloud-versions sync-lines">
          <For each={lines()}>{(line) => <li>{line}</li>}</For>
        </ul>
      </Show>
      <div class="confirm-buttons properties-buttons">
        <button class="properties-link" disabled={!ready()} onClick={look}>
          Look first
        </button>
        <span class="properties-said" />
        <button class="job-choice" onClick={() => close()}>
          Cancel
        </button>
        <button class="job-choice" disabled={!ready()} onClick={save}>
          Save
        </button>
        <button class="job-choice drive-confirm" disabled={!ready() || (mustLook() && !preview())} onClick={run}>
          Run now
        </button>
      </div>
    </dialog>
  );
}
